import { LANGS, type HwpDocument, type HwpRecord, type OpaqueControl, type PageDef, type Paragraph, type PerLang, type Section } from '../../model/types';
import { base64ToBytes, plainText } from '../../model/util';
import { BLANK_HWP_BASE64 } from '../../templates/embedded';
import { deflate, readFileHeader, writeCompound } from './cfb';
import { buildCharShape, buildFaceName, buildParaShape, buildStyle, readFaceName } from './docinfo';
import { IDMAP, TAG, serializeRecords } from './records';
import { readHwp } from './reader';

interface Base {
  streams: Map<string, Uint8Array>;
  docInfo: HwpRecord[];
  compressed: boolean;
  version: number;
  charShape: Uint8Array;
  paraShape: Uint8Array;
  secd: OpaqueControl;
  cold: OpaqueControl;
}

let templateCache: Promise<Base> | null = null;

function hwpTemplate(): Promise<Base> {
  templateCache ??= (async () => {
    const bytes = base64ToBytes(BLANK_HWP_BASE64);
    const doc = await readHwp(bytes);
    const fh = readFileHeader(doc.source.hwpStreams!.get('FileHeader')!);
    return {
      streams: doc.source.hwpStreams!,
      docInfo: doc.source.hwpDocInfo!,
      compressed: fh.compressed,
      version: fh.version,
      charShape: doc.charShapes[0].raw!.hwp!,
      paraShape: doc.paraShapes[0].raw!.hwp!,
      secd: doc.sections[0].raw!.hwpSecd!,
      cold: doc.sections[0].raw!.hwpCold!,
    };
  })();
  return templateCache;
}

export async function writeHwp(doc: HwpDocument): Promise<Uint8Array> {
  const tpl = await hwpTemplate();
  const own = doc.source.format === 'hwp' && doc.source.hwpStreams && doc.source.hwpDocInfo;
  const streams = new Map(own ? doc.source.hwpStreams! : tpl.streams);
  const fh = readFileHeader(streams.get('FileHeader')!);
  const pack = (d: Uint8Array) => (fh.compressed ? deflate(d) : d);
  const docInfo = own ? doc.source.hwpDocInfo! : tpl.docInfo;

  streams.set('DocInfo', pack(serializeRecords(buildDocInfo(doc, docInfo, tpl))));
  for (const name of [...streams.keys()]) if (/^BodyText\/Section\d+$/.test(name)) streams.delete(name);
  doc.sections.forEach((s, i) => streams.set(`BodyText/Section${i}`, pack(serializeRecords(buildSection(s, tpl, fh.version)))));

  // 미리보기 텍스트 (UTF-16LE, NUL 종료)
  const prv = plainText(doc).slice(0, 1023) + '\0';
  const prvBytes = new Uint8Array(prv.length * 2);
  for (let i = 0; i < prv.length; i++) { prvBytes[i * 2] = prv.charCodeAt(i) & 0xff; prvBytes[i * 2 + 1] = prv.charCodeAt(i) >> 8; }
  streams.set('PrvText', prvBytes);
  return writeCompound(streams);
}

// ───────────────────────── DocInfo ─────────────────────────

function buildDocInfo(doc: HwpDocument, base: HwpRecord[], tpl: Base): HwpRecord[] {
  // 기존 글꼴 목록 (언어 그룹 순서)
  const idmap = base.find((r) => r.tag === TAG.ID_MAPPINGS)!;
  const counts = Array.from({ length: idmap.data.length >> 2 }, (_, i) => new DataView(idmap.data.buffer, idmap.data.byteOffset).getInt32(i * 4, true));
  const faceRecs = base.filter((r) => r.tag === TAG.FACE_NAME);
  const fonts: PerLang<{ name: string; rec: Uint8Array }[]> = [[], [], [], [], [], [], []];
  let fi = 0;
  for (let lang = 0; lang < 7; lang++) {
    for (let k = 0; k < (counts[IDMAP.fontHangul + lang] ?? 0) && fi < faceRecs.length; k++, fi++) {
      fonts[lang].push({ name: readFaceName(faceRecs[fi].data), rec: faceRecs[fi].data });
    }
  }
  const fontId = (lang: number, face: string) => {
    let id = fonts[lang].findIndex((f) => f.name === face);
    if (id < 0) { id = fonts[lang].length; fonts[lang].push({ name: face, rec: buildFaceName(face) }); }
    return id;
  };

  const own = doc.source.format === 'hwp';
  const charRecs = doc.charShapes.map((s) => {
    const ids = LANGS.map((_, li) => fontId(li, s.props.faces[li])) as PerLang<number>;
    return buildCharShape((own && s.raw?.hwp) || tpl.charShape, s.props, ids);
  });
  const paraRecs = doc.paraShapes.map((s) => buildParaShape((own && s.raw?.hwp) || tpl.paraShape, s.props));
  const styleRecs = doc.styles.map((s) => buildStyle(own ? s : { ...s, raw: undefined }));

  const newCounts = counts.slice();
  for (let lang = 0; lang < 7; lang++) newCounts[IDMAP.fontHangul + lang] = fonts[lang].length;
  newCounts[IDMAP.charShape] = charRecs.length;
  newCounts[IDMAP.paraShape] = paraRecs.length;
  newCounts[IDMAP.style] = styleRecs.length;
  const idmapData = new Uint8Array(idmap.data.length);
  const dv = new DataView(idmapData.buffer);
  newCounts.forEach((v, i) => dv.setInt32(i * 4, v, true));

  const replacement: Partial<Record<number, Uint8Array[]>> = {
    [TAG.FACE_NAME]: fonts.flatMap((l) => l.map((f) => f.rec)),
    [TAG.CHAR_SHAPE]: charRecs,
    [TAG.PARA_SHAPE]: paraRecs,
    [TAG.STYLE]: styleRecs,
  };
  const out: HwpRecord[] = [];
  const done = new Set<number>();
  for (const r of base) {
    const rep = replacement[r.tag];
    if (rep) {
      if (!done.has(r.tag)) { done.add(r.tag); for (const d of rep) out.push({ tag: r.tag, level: r.level, data: d }); }
      continue;
    }
    if (r.tag === TAG.ID_MAPPINGS) { out.push({ ...r, data: idmapData }); continue; }
    if (r.tag === TAG.DOCUMENT_PROPERTIES) {
      const d = r.data.slice();
      const v = new DataView(d.buffer);
      v.setUint16(0, doc.sections.length, true);
      if (d.length >= 26) { v.setUint32(14, 0, true); v.setUint32(18, 0, true); v.setUint32(22, 0, true); }
      out.push({ ...r, data: d });
      continue;
    }
    out.push(r);
  }
  return out;
}

// ───────────────────────── BodyText ─────────────────────────

function patchPageDef(records: HwpRecord[], page: PageDef): HwpRecord[] {
  return records.map((r) => {
    if (r.tag !== TAG.PAGE_DEF) return r;
    const d = r.data.slice();
    const v = new DataView(d.buffer);
    [page.width, page.height, page.marginLeft, page.marginRight, page.marginTop, page.marginBottom,
      page.marginHeader, page.marginFooter, page.marginGutter].forEach((x, i) => v.setUint32(i * 4, x, true));
    v.setUint32(36, (v.getUint32(36, true) & ~1) | (page.landscape ? 1 : 0), true);
    return { ...r, data: d };
  });
}

const TAB_CHARS = [9, 4000, 0, 0, 0x20, 0x20, 0x20, 9];
const CHAR_CODES: Record<string, number> = { '\n': 10, '­': 24, ' ': 30, ' ': 31 };

function paragraphRecords(p: Paragraph, head: OpaqueControl[], last: boolean, version: number): HwpRecord[] {
  const units: number[] = [];
  const shapes: [number, number][] = [];
  const ctrlRecs: HwpRecord[] = [];
  let mask = 0;
  const setShape = (cs: number) => {
    const prev = shapes[shapes.length - 1];
    if (!prev || prev[1] !== cs) {
      if (prev && prev[0] === units.length) prev[1] = cs;
      else shapes.push([units.length, cs]);
    }
  };
  const addCtrl = (c: OpaqueControl) => {
    if (!c.hwpChars) return;
    units.push(...c.hwpChars);
    mask |= 1 << c.hwpChars[0];
    if (c.hwpRecords) ctrlRecs.push(...c.hwpRecords);
  };
  setShape(p.runs[0]?.charShapeId ?? p.endCharShapeId ?? 0);
  for (const c of head) addCtrl(c);
  for (const r of p.runs) {
    if (r.kind === 'control') {
      if (!r.ctrl.hwpChars) continue; // 다른 포맷에서 온 개체는 아직 변환하지 않음
      setShape(r.charShapeId);
      addCtrl(r.ctrl);
      continue;
    }
    setShape(r.charShapeId);
    for (const ch of r.text) {
      if (ch === '\t') { units.push(...TAB_CHARS); mask |= 1 << 9; continue; }
      const code = CHAR_CODES[ch];
      if (code !== undefined) { units.push(code); mask |= 1 << code; continue; }
      const cp = ch.charCodeAt(0);
      if (cp < 32) continue;
      for (let k = 0; k < ch.length; k++) units.push(ch.charCodeAt(k));
    }
  }
  units.push(13);
  if (shapes.length === 0) shapes.push([0, 0]);

  const hasSecd = head.some((c) => c.label === '구역 정의');
  const hasCold = head.some((c) => c.label === '단 정의');
  const brk = (hasSecd ? 1 : 0) | (hasCold ? 2 : 0) | (p.pageBreak ? 4 : 0) | (p.columnBreak ? 8 : 0);
  const withMerge = version >= 0x05000302;
  const hdr = new Uint8Array(withMerge ? 24 : 22);
  const hv = new DataView(hdr.buffer);
  hv.setUint32(0, (units.length | (last ? 0x80000000 : 0)) >>> 0, true);
  hv.setUint32(4, mask >>> 0, true);
  hv.setUint16(8, p.paraShapeId, true);
  hv.setUint8(10, p.styleId);
  hv.setUint8(11, brk);
  hv.setUint16(12, shapes.length, true);

  const out: HwpRecord[] = [{ tag: TAG.PARA_HEADER, level: 0, data: hdr }];
  if (units.length > 1) {
    const t = new Uint8Array(units.length * 2);
    const tv = new DataView(t.buffer);
    units.forEach((u, i) => tv.setUint16(i * 2, u, true));
    out.push({ tag: TAG.PARA_TEXT, level: 1, data: t });
  }
  const cs = new Uint8Array(shapes.length * 8);
  const cv = new DataView(cs.buffer);
  shapes.forEach(([pos, id], i) => { cv.setUint32(i * 8, pos, true); cv.setUint32(i * 8 + 4, id, true); });
  out.push({ tag: TAG.PARA_CHAR_SHAPE, level: 1, data: cs });
  out.push(...ctrlRecs);
  return out;
}

function buildSection(section: Section, tpl: Base, version: number): HwpRecord[] {
  const secd = section.raw?.hwpSecd ?? tpl.secd;
  const cold = section.raw?.hwpCold ?? tpl.cold;
  const head: OpaqueControl[] = [
    { ...secd, label: '구역 정의', hwpRecords: patchPageDef(secd.hwpRecords ?? [], section.page) },
    { ...cold, label: '단 정의' },
  ];
  const paras = section.paragraphs.length ? section.paragraphs : [{ paraShapeId: 0, styleId: 0, runs: [] }];
  return paras.flatMap((p, i) => paragraphRecords(p, i === 0 ? head : [], i === paras.length - 1, version));
}

