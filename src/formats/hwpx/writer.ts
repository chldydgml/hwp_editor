import JSZip from 'jszip';
import { LANGS, type HwpDocument, type PageDef, type Paragraph, type PerLang, type Run, type Section } from '../../model/types';
import { base64ToBytes, plainText } from '../../model/util';
import { BLANK_HWPX_BASE64 } from '../../templates/embedded';
import { decodeUtf8, descendant, descendants, encodeUtf8, escapeXml, kid, kids, parseXml, serializeXml } from '../xml';
import { addFont, buildCharPr, buildParaPr, buildStyle, readFonts } from './header';
import { FONT_LANGS, NS, NS_DECLS, normalizeRootNs, stripKnownNs } from './ns';
import { unzipHwpx, type HwpxPackage } from './reader';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

interface Template {
  pkg: HwpxPackage;
  charPr: string;
  paraPr: string;
  secPr: string;
  colPr: string;
}

let templateCache: Promise<Template> | null = null;

/** 내장 빈 HWPX 템플릿 (교차 포맷 저장 시 기본 요소로 사용) */
export function hwpxTemplate(): Promise<Template> {
  templateCache ??= (async () => {
    const pkg = await unzipHwpx(base64ToBytes(BLANK_HWPX_BASE64));
    const head = parseXml(decodeUtf8(pkg.files.get(pkg.headerPath)!));
    const sec = parseXml(decodeUtf8(pkg.files.get(pkg.sectionPaths[0])!));
    const colCtrl = descendants(sec, 'ctrl').find((c) => c.firstElementChild?.localName === 'colPr')!;
    return {
      pkg,
      charPr: serializeXml(descendant(head, 'charPr')!),
      paraPr: serializeXml(descendant(head, 'paraPr')!),
      secPr: serializeXml(descendant(sec, 'secPr')!),
      colPr: serializeXml(colCtrl),
    };
  })();
  return templateCache;
}

export async function writeHwpx(doc: HwpDocument): Promise<Uint8Array> {
  const tpl = await hwpxTemplate();
  const ownFiles = doc.source.format !== 'hwp' && doc.source.hwpxFiles;
  const files = new Map(ownFiles || tpl.pkg.files);
  const headerPath = 'Contents/header.xml';

  files.set(headerPath, encodeUtf8(buildHeader(doc, decodeUtf8(files.get(headerPath)!), tpl)));

  // 기존 구역 파일 제거 후 다시 작성
  for (const name of [...files.keys()]) if (/^Contents\/section\d+\.xml$/.test(name)) files.delete(name);
  doc.sections.forEach((s, i) => files.set(`Contents/section${i}.xml`, encodeUtf8(buildSection(s, tpl))));

  files.set('Contents/content.hpf', encodeUtf8(buildContentHpf(doc, decodeUtf8(files.get('Contents/content.hpf')!))));
  files.set('Preview/PrvText.txt', encodeUtf8(plainText(doc).slice(0, 1024)));
  if (files.has('settings.xml')) files.set('settings.xml', encodeUtf8(resetCaret(decodeUtf8(files.get('settings.xml')!))));

  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  for (const [name, data] of files) {
    if (name === 'mimetype') continue;
    zip.file(name, data, { compression: 'DEFLATE' });
  }
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/hwp+zip' });
}

// ───────────────────────── header.xml ─────────────────────────

function replaceChildren(list: Element, items: Element[]) {
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const it of items) list.appendChild(it);
  list.setAttribute('itemCnt', String(items.length));
}

function ensureList(head: Element, name: string, before: string[]): Element {
  const refList = kid(head, 'refList')!;
  let el = kid(refList, name);
  if (!el) {
    el = head.ownerDocument.createElementNS(NS.hh, 'hh:' + name);
    const ref = Array.from(refList.children).find((c) => before.includes(c.localName));
    refList.insertBefore(el, ref ?? null);
  }
  return el;
}

function buildHeader(doc: HwpDocument, headerXml: string, tpl: Template): string {
  const xml = parseXml(headerXml);
  const head = xml.documentElement;
  head.setAttribute('secCnt', String(doc.sections.length));

  // 글꼴: 필요한 이름이 없으면 언어 그룹마다 추가
  const fonts = readFonts(head);
  const fontfaces = descendants(head, 'fontface');
  const fontId = (lang: number, face: string): number => {
    let id = fonts[lang].indexOf(face);
    if (id >= 0) return id;
    id = fonts[lang].length;
    fonts[lang].push(face);
    const ff = fontfaces.find((f) => f.getAttribute('lang') === FONT_LANGS[lang]);
    if (ff) addFont(ff, face, id);
    return id;
  };

  const charEls = doc.charShapes.map((s, i) => {
    const ids = LANGS.map((_, li) => fontId(li, s.props.faces[li])) as PerLang<number>;
    return buildCharPr(xml, s.raw?.hwpx ?? tpl.charPr, i, s.props, ids);
  });
  const paraEls = doc.paraShapes.map((s, i) => buildParaPr(xml, s.raw?.hwpx ?? tpl.paraPr, i, s.props));
  const styleEls = doc.styles.map((s, i) => buildStyle(xml, s, i));

  replaceChildren(ensureList(head, 'charProperties', ['tabProperties', 'numberings', 'bullets', 'paraProperties', 'styles']), charEls);
  replaceChildren(ensureList(head, 'paraProperties', ['styles', 'memoProperties', 'trackChanges', 'trackChangeAuthors']), paraEls);
  replaceChildren(ensureList(head, 'styles', ['memoProperties', 'trackChanges', 'trackChangeAuthors']), styleEls);
  return XML_DECL + normalizeRootNs(serializeXml(head));
}

// ───────────────────────── section*.xml ─────────────────────────

function patchSecPr(secPrXml: string, page: PageDef): string {
  const el = parseXml(secPrXml).documentElement;
  const pp = kid(el, 'pagePr');
  if (pp) {
    pp.setAttribute('landscape', page.landscape ? 'NARROWLY' : 'WIDELY');
    pp.setAttribute('width', String(page.width));
    pp.setAttribute('height', String(page.height));
    const m = kid(pp, 'margin');
    if (m) {
      m.setAttribute('header', String(page.marginHeader));
      m.setAttribute('footer', String(page.marginFooter));
      m.setAttribute('gutter', String(page.marginGutter));
      m.setAttribute('left', String(page.marginLeft));
      m.setAttribute('right', String(page.marginRight));
      m.setAttribute('top', String(page.marginTop));
      m.setAttribute('bottom', String(page.marginBottom));
    }
  }
  return serializeXml(el);
}

const TEXT_ELEMENTS: Record<string, string> = {
  '\t': '<hp:tab/>', '\n': '<hp:lineBreak/>', ' ': '<hp:nbSpace/>', ' ': '<hp:fwSpace/>', '­': '<hp:hyphen/>',
};

// XML 1.0에서 허용되지 않는 제어 문자 제거
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const textXml = (text: string): string =>
  text
    .replace(INVALID_XML, '')
    .split(/([\t\n  ­])/)
    .map((part) => TEXT_ELEMENTS[part] ?? escapeXml(part))
    .join('');

function runsXml(runs: Run[], head: string): string {
  let out = '';
  let i = 0;
  let first = true;
  while (i < runs.length || first) {
    const cs = runs[i]?.charShapeId ?? 0;
    let body = first ? head : '';
    first = false;
    let inT = false;
    const openT = () => { if (!inT) { body += '<hp:t>'; inT = true; } };
    const closeT = () => { if (inT) { body += '</hp:t>'; inT = false; } };
    while (i < runs.length && runs[i].charShapeId === cs) {
      const r = runs[i++];
      if (r.kind === 'text') {
        openT();
        body += textXml(r.text);
      } else if (r.ctrl.hwpx) {
        if (r.ctrl.hwpxInText) openT();
        else closeT();
        body += stripKnownNs(r.ctrl.hwpx);
      }
    }
    closeT();
    out += `<hp:run charPrIDRef="${cs}">${body}</hp:run>`;
  }
  return out;
}

let paraSeq = 0;

function paragraphXml(p: Paragraph, head: string): string {
  const runs = p.runs.filter((r) => r.kind === 'text' || r.ctrl.hwpx);
  let body: string;
  if (runs.length === 0) {
    body = `<hp:run charPrIDRef="${p.endCharShapeId ?? 0}">${head}<hp:t/></hp:run>`;
  } else {
    body = runsXml(runs, head);
  }
  const attrs = `id="${paraSeq++}" paraPrIDRef="${p.paraShapeId}" styleIDRef="${p.styleId}" pageBreak="${p.pageBreak ? 1 : 0}" columnBreak="${p.columnBreak ? 1 : 0}" merged="0"`;
  return `<hp:p ${attrs}>${body}</hp:p>`;
}

function buildSection(section: Section, tpl: Template): string {
  paraSeq = 0;
  const secPr = stripKnownNs(patchSecPr(section.raw?.hwpxSecPr ?? tpl.secPr, section.page));
  const colPr = stripKnownNs(section.raw?.hwpxColPr ?? tpl.colPr);
  const paras = section.paragraphs.length ? section.paragraphs : [{ paraShapeId: 0, styleId: 0, runs: [] }];
  const body = paras.map((p, i) => paragraphXml(p, i === 0 ? secPr + colPr : '')).join('');
  return `${XML_DECL}<hs:sec ${NS_DECLS}>${body}</hs:sec>`;
}

// ───────────────────────── content.hpf / settings.xml ─────────────────────────

function buildContentHpf(doc: HwpDocument, hpfXml: string): string {
  const xml = parseXml(hpfXml);
  const pkg = xml.documentElement;
  const manifest = descendant(xml, 'manifest')!;
  const spine = descendant(xml, 'spine')!;
  const isSection = (href: string) => /section\d+\.xml$/.test(href);
  const sectionIds = new Set<string>();
  for (const item of kids(manifest, 'item')) {
    if (isSection(item.getAttribute('href') ?? '')) {
      sectionIds.add(item.getAttribute('id') ?? '');
      item.remove();
    }
  }
  for (const ref of kids(spine, 'itemref')) if (sectionIds.has(ref.getAttribute('idref') ?? '')) ref.remove();
  const headerItem = kids(manifest, 'item').find((i) => /header\.xml$/.test(i.getAttribute('href') ?? ''));
  const headerRef = kids(spine, 'itemref').find((r) => r.getAttribute('idref') === headerItem?.getAttribute('id'));
  let afterItem: Element | null = headerItem ?? null;
  let afterRef: Element | null = headerRef ?? null;
  doc.sections.forEach((_, i) => {
    const item = xml.createElementNS(NS.opf, 'opf:item');
    item.setAttribute('id', `section${i}`);
    item.setAttribute('href', `Contents/section${i}.xml`);
    item.setAttribute('media-type', 'application/xml');
    manifest.insertBefore(item, afterItem ? afterItem.nextSibling : manifest.firstChild);
    afterItem = item;
    const ref = xml.createElementNS(NS.opf, 'opf:itemref');
    ref.setAttribute('idref', `section${i}`);
    ref.setAttribute('linear', 'yes');
    spine.insertBefore(ref, afterRef ? afterRef.nextSibling : spine.firstChild);
    afterRef = ref;
  });

  const metadata = descendant(xml, 'metadata');
  if (metadata) {
    const title = kid(metadata, 'title');
    if (title) title.textContent = doc.meta.title;
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const values: Record<string, string> = {
      creator: doc.meta.creator, subject: doc.meta.subject, description: doc.meta.description,
      keyword: doc.meta.keywords, lastsaveby: doc.meta.creator, ModifiedDate: now,
    };
    if (doc.source.format !== 'hwpx') values.CreatedDate = now;
    for (const m of kids(metadata, 'meta')) {
      const n = m.getAttribute('name') ?? '';
      if (n in values) m.textContent = values[n];
    }
  }
  return XML_DECL + serializeXml(pkg);
}

function resetCaret(settingsXml: string): string {
  const xml = parseXml(settingsXml);
  const caret = descendant(xml, 'CaretPosition');
  if (caret) {
    caret.setAttribute('listIDRef', '0');
    caret.setAttribute('paraIDRef', '0');
    caret.setAttribute('pos', '0');
  }
  return XML_DECL + serializeXml(xml.documentElement);
}
