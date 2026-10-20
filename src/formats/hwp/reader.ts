import type { CharShape, HwpDocument, HwpRecord, OpaqueControl, PageDef, Paragraph, ParaShape, PerLang, Run, Section, Style } from '../../model/types';
import { defaultPage, mergeRuns } from '../../model/util';
import { inflate, readCompound, readFileHeader } from './cfb';
import { readCharShape, readFaceName, readParaShape, readStyle } from './docinfo';
import { IDMAP, Reader, TAG, ctrlIdOf, parseRecords } from './records';

/** 컨트롤 ID → 표시 이름 */
const CTRL_LABELS: Record<string, string> = {
  'tbl ': '표', 'gso ': '그리기 개체', 'eqed': '수식', 'secd': '구역 정의', 'cold': '단 정의',
  head: '머리말', foot: '꼬리말', 'fn  ': '각주', 'en  ': '미주', atno: '번호', nwno: '새 번호',
  pghd: '감추기', pgct: '홀/짝수 조정', pgnp: '쪽 번호', idxm: '찾아보기', bokm: '책갈피',
  tcps: '글자 겹침', tdut: '덧말', tcmt: '숨은 설명', form: '양식 개체',
};
const SHAPE_LABELS: Record<string, string> = {
  $pic: '그림', $rec: '사각형', $lin: '선', $ell: '타원', $con: '묶음 개체', $pol: '다각형', $cur: '곡선',
  $arc: '호', $ole: 'OLE 개체', $vid: '동영상', $tat: '글맵시',
};

/** 확장 컨트롤 문자 (CTRL_HEADER 레코드가 따라옴) */
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
/** 인라인 컨트롤 문자 (8 WCHAR, 레코드 없음) */
const INLINE = new Set([4, 5, 6, 7, 8, 9, 19, 20]);

export async function readHwp(data: Uint8Array | ArrayBuffer): Promise<HwpDocument> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const streams = readCompound(bytes);
  const fh = streams.get('FileHeader');
  if (!fh) throw new Error('HWP 파일 헤더(FileHeader)가 없습니다.');
  const header = readFileHeader(fh);
  if (header.encrypted) throw new Error('암호가 걸린 HWP 문서는 열 수 없습니다.');
  if (header.distribution) throw new Error('배포용 HWP 문서는 열 수 없습니다.');
  const unpack = (d: Uint8Array) => (header.compressed ? inflate(d) : d);

  const docInfoStream = streams.get('DocInfo');
  if (!docInfoStream) throw new Error('HWP 문서 정보(DocInfo)가 없습니다.');
  const docInfo = parseRecords(unpack(docInfoStream));

  // ── DocInfo
  let counts: number[] = [];
  const faceRecs: string[] = [];
  const charRecs: Uint8Array[] = [];
  const paraRecs: Uint8Array[] = [];
  const styleRecs: Uint8Array[] = [];
  for (const r of docInfo) {
    switch (r.tag) {
      case TAG.ID_MAPPINGS: {
        const rd = new Reader(r.data);
        counts = Array.from({ length: Math.floor(r.data.length / 4) }, () => rd.i32());
        break;
      }
      case TAG.FACE_NAME: faceRecs.push(readFaceName(r.data)); break;
      case TAG.CHAR_SHAPE: charRecs.push(r.data); break;
      case TAG.PARA_SHAPE: paraRecs.push(r.data); break;
      case TAG.STYLE: styleRecs.push(r.data); break;
    }
  }
  const fonts: PerLang<string[]> = [[], [], [], [], [], [], []];
  let fi = 0;
  for (let lang = 0; lang < 7; lang++) {
    const n = counts[IDMAP.fontHangul + lang] ?? 0;
    for (let k = 0; k < n && fi < faceRecs.length; k++) fonts[lang].push(faceRecs[fi++]);
  }

  const charShapes: CharShape[] = charRecs.map((d) => ({ props: readCharShape(d, fonts), raw: { hwp: d } }));
  const paraShapes: ParaShape[] = paraRecs.map((d) => ({ props: readParaShape(d), raw: { hwp: d } }));
  const styles: Style[] = styleRecs.map(readStyle);

  // ── BodyText
  const sections: Section[] = [];
  for (let i = 0; streams.has(`BodyText/Section${i}`); i++) {
    sections.push(readSection(parseRecords(unpack(streams.get(`BodyText/Section${i}`)!))));
  }
  if (sections.length === 0) throw new Error('HWP 본문(BodyText)이 없습니다.');

  return {
    meta: { title: '', creator: '', subject: '', description: '', keywords: '' },
    charShapes,
    paraShapes,
    styles,
    sections,
    source: { format: 'hwp', hwpStreams: streams, hwpDocInfo: docInfo, hwpVersion: header.version },
  };
}

/** 레코드 목록에서 [start] 레코드와 그보다 레벨이 깊은 후속 레코드(하위 트리)의 끝 인덱스 */
function subtreeEnd(recs: HwpRecord[], start: number): number {
  const level = recs[start].level;
  let i = start + 1;
  while (i < recs.length && recs[i].level > level) i++;
  return i;
}

function readSection(recs: HwpRecord[]): Section {
  const section: Section = { page: defaultPage(), paragraphs: [], raw: {} };
  let i = 0;
  while (i < recs.length) {
    if (recs[i].tag !== TAG.PARA_HEADER || recs[i].level !== 0) { i++; continue; }
    const end = subtreeEnd(recs, i);
    section.paragraphs.push(readParagraph(recs.slice(i, end), section));
    i = end;
  }
  if (section.paragraphs.length === 0) section.paragraphs.push({ paraShapeId: 0, styleId: 0, runs: [] });
  return section;
}

/** 하위 트리의 문단 텍스트를 모아 미리보기 문자열을 만듭니다. */
function previewText(recs: HwpRecord[]): string | undefined {
  let s = '';
  for (const r of recs) {
    if (r.tag !== TAG.PARA_TEXT) continue;
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    for (let p = 0; p + 1 < r.data.length; ) {
      const c = dv.getUint16(p, true);
      if (c >= 32) { s += String.fromCharCode(c); p += 2; }
      else if (EXTENDED.has(c) || INLINE.has(c)) p += 16;
      else p += 2;
    }
    s += ' ';
  }
  return s.trim().slice(0, 200) || undefined;
}

function controlLabel(id: string, recs: HwpRecord[]): string {
  if (id === 'gso ') {
    const sc = recs.find((r) => r.tag === TAG.SHAPE_COMPONENT);
    if (sc) return SHAPE_LABELS[ctrlIdOf(sc.data)] ?? '그리기 개체';
  }
  if (id.startsWith('%')) return '필드';
  return CTRL_LABELS[id] ?? '컨트롤';
}

export function readPageDef(data: Uint8Array): PageDef {
  const r = new Reader(data);
  const page = defaultPage();
  page.width = r.u32();
  page.height = r.u32();
  page.marginLeft = r.u32();
  page.marginRight = r.u32();
  page.marginTop = r.u32();
  page.marginBottom = r.u32();
  page.marginHeader = r.u32();
  page.marginFooter = r.u32();
  page.marginGutter = r.u32();
  page.landscape = !!(r.u32() & 1);
  return page;
}

function readParagraph(recs: HwpRecord[], section: Section): Paragraph {
  const hr = new Reader(recs[0].data);
  hr.u32(); // 글자 수
  hr.u32(); // 컨트롤 마스크
  const paraShapeId = hr.u16();
  const styleId = hr.u8();
  const brk = hr.u8();
  const para: Paragraph = {
    paraShapeId,
    styleId,
    runs: [],
    pageBreak: !!(brk & 4) || undefined,
    columnBreak: !!(brk & 8) || undefined,
  };

  let text = new Uint16Array(0);
  let shapes: [number, number][] = [[0, 0]];
  const ctrls: { id: string; recs: HwpRecord[] }[] = [];
  const baseLevel = recs[0].level;
  for (let i = 1; i < recs.length; ) {
    const r = recs[i];
    if (r.level !== baseLevel + 1) { i++; continue; }
    if (r.tag === TAG.PARA_TEXT) {
      text = new Uint16Array(r.data.length >> 1);
      const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      for (let k = 0; k < text.length; k++) text[k] = dv.getUint16(k * 2, true);
    } else if (r.tag === TAG.PARA_CHAR_SHAPE) {
      const rd = new Reader(r.data);
      shapes = [];
      while (rd.remaining >= 8) shapes.push([rd.u32(), rd.u32()]);
    } else if (r.tag === TAG.CTRL_HEADER) {
      const end = subtreeEnd(recs, i);
      // 레벨을 문단 기준 상대값으로 저장
      ctrls.push({ id: ctrlIdOf(r.data), recs: recs.slice(i, end).map((x) => ({ ...x, level: x.level - baseLevel })) });
      i = end;
      continue;
    }
    i++;
  }

  const shapeAt = (pos: number) => {
    let id = shapes[0]?.[1] ?? 0;
    for (const [start, cs] of shapes) if (start <= pos) id = cs;
    return id;
  };
  para.endCharShapeId = shapeAt(Math.max(0, text.length - 1));

  const runs: Run[] = [];
  let buf = '';
  let bufShape = -1;
  const flush = () => {
    if (buf) runs.push({ kind: 'text', charShapeId: bufShape, text: buf });
    buf = '';
  };
  const addChar = (pos: number, ch: string) => {
    const cs = shapeAt(pos);
    if (cs !== bufShape) { flush(); bufShape = cs; }
    buf += ch;
  };
  let ctrlIndex = 0;
  for (let pos = 0; pos < text.length; ) {
    const c = text[pos];
    if (c >= 32) { addChar(pos, String.fromCharCode(c)); pos++; continue; }
    if (c === 13) break;
    if (c === 10) { addChar(pos, '\n'); pos++; continue; }
    if (c === 9) { addChar(pos, '\t'); pos += 8; continue; }
    if (c === 24) { addChar(pos, '­'); pos++; continue; }
    if (c === 30) { addChar(pos, ' '); pos++; continue; }
    if (c === 31) { addChar(pos, ' '); pos++; continue; }
    if (EXTENDED.has(c) || INLINE.has(c)) {
      const chars = text.slice(pos, pos + 8);
      const cs = shapeAt(pos);
      if (EXTENDED.has(c)) {
        const ctrl = ctrls[ctrlIndex++];
        const id = ctrl?.id ?? '';
        if (id === 'secd' && section.raw && !section.raw.hwpSecd) {
          section.raw.hwpSecd = { label: '구역 정의', hwpChars: chars, hwpRecords: ctrl.recs };
          const pd = ctrl.recs.find((r) => r.tag === TAG.PAGE_DEF);
          if (pd) section.page = readPageDef(pd.data);
        } else if (id === 'cold' && section.raw && !section.raw.hwpCold && section.paragraphs.length === 0) {
          section.raw.hwpCold = { label: '단 정의', hwpChars: chars, hwpRecords: ctrl.recs };
        } else {
          flush();
          const recsOf = ctrl?.recs ?? [];
          const oc: OpaqueControl = { label: controlLabel(id, recsOf), preview: previewText(recsOf), hwpChars: chars, hwpRecords: recsOf };
          runs.push({ kind: 'control', charShapeId: cs, ctrl: oc });
        }
      } else {
        flush();
        runs.push({ kind: 'control', charShapeId: cs, ctrl: { label: c === 4 ? '필드 끝' : '컨트롤', hwpChars: chars } });
      }
      pos += 8;
      continue;
    }
    pos++; // 사용하지 않는 문자
  }
  flush();
  para.runs = mergeRuns(runs);
  return para;
}
