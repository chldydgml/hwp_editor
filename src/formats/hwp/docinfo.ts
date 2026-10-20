import { LANGS, type Align, type CharProps, type LineSpacingType, type ParaProps, type PerLang, type Style } from '../../model/types';
import { colorrefToHex, defaultCharProps, defaultParaProps, hexToColorref } from '../../model/util';
import { Reader, Writer } from './records';

// ───────────────────────── FACE_NAME ─────────────────────────

export function readFaceName(data: Uint8Array): string {
  const r = new Reader(data);
  r.u8();
  return r.str();
}

/** 새 글꼴 FACE_NAME 레코드 (대체 글꼴/글꼴 유형 정보 없음) */
export function buildFaceName(face: string): Uint8Array {
  return new Writer().u8(0).str(face).done();
}

// ───────────────────────── CHAR_SHAPE ─────────────────────────
// faceId[7]:u16 @0, ratio[7]:u8 @14, spacing[7]:i8 @21, relSize[7]:u8 @28, offset[7]:i8 @35,
// baseSize:i32 @42, attr:u32 @46, shadowGap:i8×2 @50, textColor @52, underlineColor @56,
// shadeColor @60, shadowColor @64, borderFillId:u16 @68, strikeColor @70

export function readCharShape(data: Uint8Array, fonts: PerLang<string[]>): CharProps {
  const p = defaultCharProps();
  const r = new Reader(data);
  const ids = LANGS.map(() => r.u16());
  p.faces = ids.map((id, i) => fonts[i][id] ?? fonts[i][0] ?? p.faces[i]) as PerLang<string>;
  p.ratio = LANGS.map(() => r.u8()) as PerLang<number>;
  p.spacing = LANGS.map(() => r.i8()) as PerLang<number>;
  p.relSize = LANGS.map(() => r.u8()) as PerLang<number>;
  p.offset = LANGS.map(() => r.i8()) as PerLang<number>;
  p.size = r.i32();
  const attr = r.u32();
  r.skip(2);
  p.color = colorrefToHex(r.u32());
  r.u32();
  const shade = r.u32();
  p.shade = shade === 0xffffffff ? 'none' : colorrefToHex(shade);
  p.italic = !!(attr & 1);
  p.bold = !!(attr & 2);
  const ul = (attr >>> 2) & 3;
  p.underline = ul === 1 || ul === 3;
  p.strike = !!((attr >>> 18) & 7) || ul === 2;
  p.superscript = !!(attr & (1 << 15));
  p.subscript = !!(attr & (1 << 16));
  return p;
}

/** 원본 CHAR_SHAPE 페이로드(base)에 속성을 덮어씁니다. */
export function buildCharShape(base: Uint8Array, p: CharProps, fontIds: PerLang<number>): Uint8Array {
  const out = new Uint8Array(Math.max(base.length, 72));
  out.set(base);
  const dv = new DataView(out.buffer);
  LANGS.forEach((_, i) => {
    dv.setUint16(i * 2, fontIds[i], true);
    dv.setUint8(14 + i, p.ratio[i]);
    dv.setInt8(21 + i, p.spacing[i]);
    dv.setUint8(28 + i, p.relSize[i]);
    dv.setInt8(35 + i, p.offset[i]);
  });
  dv.setInt32(42, p.size, true);
  let attr = dv.getUint32(46, true);
  const set = (bit: number, on: boolean) => (attr = on ? attr | (1 << bit) : attr & ~(1 << bit));
  set(0, p.italic);
  set(1, p.bold);
  set(15, p.superscript);
  set(16, p.subscript);
  let ul = (attr >>> 2) & 3;
  const wasStrike = !!((attr >>> 18) & 7) || ul === 2;
  if (p.underline) { if (ul !== 1 && ul !== 3) ul = 1; } else if (ul !== 2) ul = 0;
  if (p.strike && !wasStrike) attr |= 1 << 18;
  if (!p.strike) { attr &= ~(7 << 18); attr &= ~(0xf << 26); if (ul === 2) ul = 0; }
  attr = (attr & ~(3 << 2)) | (ul << 2);
  dv.setUint32(46, attr >>> 0, true);
  dv.setUint32(52, hexToColorref(p.color), true);
  dv.setUint32(60, p.shade === 'none' ? 0xffffffff : hexToColorref(p.shade), true);
  return out;
}

// ───────────────────────── PARA_SHAPE ─────────────────────────
// attr1:u32 @0, left @4, right @8, indent @12, prev @16, next @20 (i32, 2배 값),
// lineSpacingOld @24, tabDef:u16 @28, numbering:u16 @30, borderFill:u16 @32, borderOffset:i16×4 @34,
// attr2:u32 @42, attr3:u32 @46, lineSpacing:u32 @50

const ALIGNS: Align[] = ['justify', 'left', 'right', 'center', 'distribute', 'divide'];
const LS_TYPES: LineSpacingType[] = ['percent', 'fixed', 'between', 'atLeast'];

export function readParaShape(data: Uint8Array): ParaProps {
  const p = defaultParaProps();
  const r = new Reader(data);
  const attr1 = r.u32();
  p.align = ALIGNS[(attr1 >>> 2) & 7] ?? 'justify';
  const half = (v: number) => (v >> 1);
  p.marginLeft = half(r.i32());
  p.marginRight = half(r.i32());
  p.indent = half(r.i32());
  p.spaceBefore = half(r.i32());
  p.spaceAfter = half(r.i32());
  const oldSpacing = r.i32();
  if (data.length >= 54) {
    r.pos = 46;
    const attr3 = r.u32();
    const ls = r.u32();
    p.lineSpacingType = LS_TYPES[attr3 & 0x1f] ?? 'percent';
    p.lineSpacing = p.lineSpacingType === 'percent' ? ls : half(ls);
  } else {
    p.lineSpacingType = LS_TYPES[attr1 & 3] ?? 'percent';
    p.lineSpacing = p.lineSpacingType === 'percent' ? oldSpacing : half(oldSpacing);
  }
  return p;
}

export function buildParaShape(base: Uint8Array, p: ParaProps): Uint8Array {
  const out = new Uint8Array(Math.max(base.length, 54));
  out.set(base);
  const dv = new DataView(out.buffer);
  let attr1 = dv.getUint32(0, true);
  attr1 = (attr1 & ~(7 << 2)) | (ALIGNS.indexOf(p.align) << 2);
  const lsType = LS_TYPES.indexOf(p.lineSpacingType);
  // 옛 줄 간격 종류(bit 0-1)에는 '최소'가 없어 백분율로 기록합니다.
  attr1 = (attr1 & ~3) | (lsType === 3 ? 0 : lsType);
  dv.setUint32(0, attr1 >>> 0, true);
  dv.setInt32(4, p.marginLeft * 2, true);
  dv.setInt32(8, p.marginRight * 2, true);
  dv.setInt32(12, p.indent * 2, true);
  dv.setInt32(16, p.spaceBefore * 2, true);
  dv.setInt32(20, p.spaceAfter * 2, true);
  const ls = p.lineSpacingType === 'percent' ? p.lineSpacing : p.lineSpacing * 2;
  dv.setInt32(24, lsType === 3 ? 100 : ls, true);
  dv.setUint32(46, (dv.getUint32(46, true) & ~0x1f) | lsType, true);
  dv.setUint32(50, ls, true);
  return out;
}

// ───────────────────────── STYLE ─────────────────────────

export function readStyle(data: Uint8Array): Style {
  const r = new Reader(data);
  const name = r.str();
  const engName = r.str();
  const attr = r.u8();
  const nextStyleId = r.u8();
  r.i16();
  const paraShapeId = r.u16();
  const charShapeId = r.u16();
  return { name, engName, type: (attr & 7) === 1 ? 'char' : 'para', paraShapeId, charShapeId, nextStyleId, raw: { hwp: data } };
}

export function buildStyle(s: Style): Uint8Array {
  const w = new Writer().str(s.name).str(s.engName);
  // 원본이 있으면 이름 뒤의 속성 바이트에서 종류/잠금 이외 비트를 유지
  let attr = s.type === 'char' ? 1 : 0;
  let langId = 1042;
  let tail: Uint8Array | undefined;
  if (s.raw?.hwp) {
    const r = new Reader(s.raw.hwp);
    r.str();
    r.str();
    attr = (r.u8() & ~7) | (s.type === 'char' ? 1 : 0);
    r.u8();
    langId = r.i16();
    r.u16();
    r.u16();
    tail = s.raw.hwp.subarray(r.pos);
  }
  w.u8(attr).u8(s.nextStyleId).i16(langId).u16(s.paraShapeId).u16(s.charShapeId);
  if (tail) w.bytes(tail);
  else w.u16(0);
  return w.done();
}
