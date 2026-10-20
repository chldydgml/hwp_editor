import JSZip from 'jszip';
import type { CharShape, HwpDocument, OpaqueControl, PageDef, Paragraph, ParaShape, Run, Section, Style } from '../../model/types';
import { defaultPage, mergeRuns } from '../../model/util';
import { attr, decodeUtf8, descendant, descendants, intAttr, kid, kids, parseXml, serializeXml } from '../xml';
import { readCharPr, readFonts, readParaPr, readStyle } from './header';

/** run 수준 개체의 표시 이름 */
const OBJECT_LABELS: Record<string, string> = {
  tbl: '표', pic: '그림', equation: '수식', rect: '사각형', ellipse: '타원', line: '선', arc: '호',
  polygon: '다각형', curve: '곡선', connectLine: '연결선', container: '묶음 개체', ole: 'OLE 개체',
  chart: '차트', textart: '글맵시', video: '동영상', compose: '글자 겹침', dutmal: '덧말',
  btn: '단추', radioBtn: '라디오 단추', checkBtn: '선택 상자', comboBox: '목록 상자', edit: '입력 상자',
  listBox: '목록', scrollBar: '스크롤바', switch: '개체',
};
const CTRL_LABELS: Record<string, string> = {
  header: '머리말', footer: '꼬리말', footNote: '각주', endNote: '미주', autoNum: '번호', newNum: '새 번호',
  pageNum: '쪽 번호', pageNumCtrl: '쪽 번호 제어', pageHiding: '감추기', colPr: '단 정의', fieldBegin: '필드',
  fieldEnd: '필드 끝', bookmark: '책갈피', indexmark: '찾아보기', hiddenComment: '숨은 설명',
};
/** hp:t 안의 문자 요소 */
const INLINE_CHARS: Record<string, string> = {
  tab: '\t', lineBreak: '\n', nbSpace: ' ', fwSpace: ' ', hyphen: '­',
};

export interface HwpxPackage {
  files: Map<string, Uint8Array>;
  headerPath: string;
  sectionPaths: string[];
}

export async function unzipHwpx(data: Uint8Array | ArrayBuffer): Promise<HwpxPackage> {
  const zip = await JSZip.loadAsync(data);
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files.set(name, await entry.async('uint8array'));
  }
  const hpfPath = findRootfile(files);
  const hpf = files.get(hpfPath);
  if (!hpf) throw new Error('HWPX 패키지에 content.hpf 가 없습니다.');
  const opf = parseXml(decodeUtf8(hpf));
  const items = new Map(descendants(opf, 'item').map((i) => [attr(i, 'id'), attr(i, 'href')]));
  const resolve = (href: string) => (files.has(href) ? href : files.has('Contents/' + href) ? 'Contents/' + href : href);
  let headerPath = 'Contents/header.xml';
  const sectionPaths: string[] = [];
  for (const ref of descendants(opf, 'itemref')) {
    const id = attr(ref, 'idref');
    const href = resolve(items.get(id) ?? '');
    if (/header\.xml$/i.test(href)) headerPath = href;
    else if (/section\d*\.xml$/i.test(href)) sectionPaths.push(href);
  }
  if (sectionPaths.length === 0) {
    sectionPaths.push(...[...files.keys()].filter((f) => /^Contents\/section\d+\.xml$/.test(f)).sort(bySectionNo));
  }
  return { files, headerPath, sectionPaths };
}

const bySectionNo = (a: string, b: string) => parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, ''));

function findRootfile(files: Map<string, Uint8Array>): string {
  const c = files.get('META-INF/container.xml');
  if (c) {
    for (const r of descendants(parseXml(decodeUtf8(c)), 'rootfile')) {
      const p = attr(r, 'full-path');
      if (p.endsWith('.hpf')) return p;
    }
  }
  return 'Contents/content.hpf';
}

/** id 속성 → 배열 인덱스 대응표 */
const idIndex = (els: Element[]) => new Map(els.map((e, i) => [intAttr(e, 'id', i), i]));

export async function readHwpx(data: Uint8Array | ArrayBuffer): Promise<HwpDocument> {
  const pkg = await unzipHwpx(data);
  const headerBytes = pkg.files.get(pkg.headerPath);
  if (!headerBytes) throw new Error('HWPX 패키지에 header.xml 이 없습니다.');
  const head = parseXml(decodeUtf8(headerBytes)).documentElement;

  const fonts = readFonts(head);
  const charEls = descendants(head, 'charPr').filter((e) => e.parentElement?.localName === 'charProperties');
  const paraEls = descendants(head, 'paraPr').filter((e) => e.parentElement?.localName === 'paraProperties');
  const styleEls = descendants(head, 'style').filter((e) => e.parentElement?.localName === 'styles');
  const charMap = idIndex(charEls);
  const paraMap = idIndex(paraEls);
  const styleMap = idIndex(styleEls);

  const charShapes: CharShape[] = charEls.map((e) => ({ props: readCharPr(e, fonts), raw: { hwpx: serializeXml(e) } }));
  const paraShapes: ParaShape[] = paraEls.map((e) => ({ props: readParaPr(e), raw: { hwpx: serializeXml(e) } }));
  const styles: Style[] = styleEls.map((e) => {
    const s = readStyle(e);
    s.charShapeId = charMap.get(s.charShapeId) ?? 0;
    s.paraShapeId = paraMap.get(s.paraShapeId) ?? 0;
    s.nextStyleId = styleMap.get(s.nextStyleId) ?? 0;
    return s;
  });

  const ctx: Ctx = { charMap, paraMap, styleMap };
  const sections = pkg.sectionPaths.map((p) => {
    const bytes = pkg.files.get(p);
    if (!bytes) throw new Error(`HWPX 패키지에 ${p} 가 없습니다.`);
    return readSection(parseXml(decodeUtf8(bytes)).documentElement, ctx);
  });

  return {
    meta: readMeta(pkg),
    charShapes,
    paraShapes,
    styles,
    sections,
    source: { format: 'hwpx', hwpxFiles: pkg.files },
  };
}

function readMeta(pkg: HwpxPackage): HwpDocument['meta'] {
  const meta = { title: '', creator: '', subject: '', description: '', keywords: '' };
  const hpf = pkg.files.get('Contents/content.hpf');
  if (!hpf) return meta;
  const opf = parseXml(decodeUtf8(hpf));
  meta.title = descendant(opf, 'title')?.textContent ?? '';
  for (const m of descendants(opf, 'meta')) {
    const v = m.textContent ?? '';
    switch (attr(m, 'name')) {
      case 'creator': meta.creator = v; break;
      case 'subject': meta.subject = v; break;
      case 'description': meta.description = v; break;
      case 'keyword': meta.keywords = v; break;
    }
  }
  return meta;
}

interface Ctx {
  charMap: Map<number, number>;
  paraMap: Map<number, number>;
  styleMap: Map<number, number>;
}

export function readPagePr(secPr: Element): PageDef {
  const page = defaultPage();
  const pp = kid(secPr, 'pagePr');
  if (!pp) return page;
  page.width = intAttr(pp, 'width', page.width);
  page.height = intAttr(pp, 'height', page.height);
  page.landscape = attr(pp, 'landscape', 'WIDELY') === 'NARROWLY';
  const m = kid(pp, 'margin');
  page.marginLeft = intAttr(m, 'left', page.marginLeft);
  page.marginRight = intAttr(m, 'right', page.marginRight);
  page.marginTop = intAttr(m, 'top', page.marginTop);
  page.marginBottom = intAttr(m, 'bottom', page.marginBottom);
  page.marginHeader = intAttr(m, 'header', page.marginHeader);
  page.marginFooter = intAttr(m, 'footer', page.marginFooter);
  page.marginGutter = intAttr(m, 'gutter', page.marginGutter);
  return page;
}

function readSection(sec: Element, ctx: Ctx): Section {
  const section: Section = { page: defaultPage(), paragraphs: [], raw: {} };
  for (const p of kids(sec, 'p')) section.paragraphs.push(readParagraph(p, ctx, section));
  if (section.paragraphs.length === 0) section.paragraphs.push({ paraShapeId: 0, styleId: 0, runs: [] });
  return section;
}

const opaque = (el: Element, label: string, inText = false): OpaqueControl => ({
  label,
  preview: descendants(el, 't').map((t) => t.textContent ?? '').join(' ').trim().slice(0, 200) || undefined,
  hwpx: serializeXml(el),
  hwpxInText: inText || undefined,
});

function readParagraph(p: Element, ctx: Ctx, section: Section): Paragraph {
  const para: Paragraph = {
    paraShapeId: ctx.paraMap.get(intAttr(p, 'paraPrIDRef')) ?? 0,
    styleId: ctx.styleMap.get(intAttr(p, 'styleIDRef')) ?? 0,
    runs: [],
    pageBreak: attr(p, 'pageBreak') === '1' || undefined,
    columnBreak: attr(p, 'columnBreak') === '1' || undefined,
  };
  const runs: Run[] = [];
  for (const run of kids(p, 'run')) {
    const cs = ctx.charMap.get(intAttr(run, 'charPrIDRef')) ?? 0;
    para.endCharShapeId = cs;
    for (const c of Array.from(run.children)) {
      const name = c.localName;
      if (name === 'secPr' && section.raw && !section.raw.hwpxSecPr) {
        section.raw.hwpxSecPr = serializeXml(c);
        section.page = readPagePr(c);
      } else if (name === 'ctrl') {
        const first = c.firstElementChild?.localName ?? '';
        if (first === 'colPr' && c.children.length === 1 && section.raw && !section.raw.hwpxColPr && section.paragraphs.length === 0) {
          section.raw.hwpxColPr = serializeXml(c);
        } else {
          runs.push({ kind: 'control', charShapeId: cs, ctrl: opaque(c, CTRL_LABELS[first] ?? '컨트롤') });
        }
      } else if (name === 't') {
        readText(c, cs, runs);
      } else if (name === 'linesegarray') {
        // 줄 배치 정보는 한컴오피스가 다시 계산하므로 버립니다.
      } else {
        runs.push({ kind: 'control', charShapeId: cs, ctrl: opaque(c, OBJECT_LABELS[name] ?? name) });
      }
    }
  }
  para.runs = mergeRuns(runs);
  return para;
}

function readText(t: Element, cs: number, runs: Run[]) {
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ kind: 'text', charShapeId: cs, text: buf });
    buf = '';
  };
  for (const n of Array.from(t.childNodes)) {
    if (n.nodeType === 3 || n.nodeType === 4) buf += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const el = n as Element;
      const ch = INLINE_CHARS[el.localName];
      if (ch !== undefined) buf += ch;
      else {
        flush();
        runs.push({ kind: 'control', charShapeId: cs, ctrl: opaque(el, el.localName, true) });
      }
    }
  }
  flush();
}
