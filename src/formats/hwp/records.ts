import type { HwpRecord } from '../../model/types';

/** HWP 5.0 레코드 태그 (HWPTAG_BEGIN = 0x10) */
export const TAG = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  DOC_DATA: 27,
  DISTRIBUTE_DOC_DATA: 28,
  COMPATIBLE_DOCUMENT: 30,
  LAYOUT_COMPATIBILITY: 31,
  TRACKCHANGE: 32,
  MEMO_SHAPE: 92,
  FORBIDDEN_CHAR: 94,

  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE_SHAPE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  EQEDIT: 88,
} as const;

/** ID_MAPPINGS 항목 순서 */
export const IDMAP = {
  binData: 0, fontHangul: 1, fontLatin: 2, fontHanja: 3, fontJapanese: 4, fontOther: 5, fontSymbol: 6, fontUser: 7,
  borderFill: 8, charShape: 9, tabDef: 10, numbering: 11, bullet: 12, paraShape: 13, style: 14, memoShape: 15,
} as const;

export function parseRecords(data: Uint8Array): HwpRecord[] {
  const out: HwpRecord[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  while (pos + 4 <= data.length) {
    const h = dv.getUint32(pos, true);
    pos += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      size = dv.getUint32(pos, true);
      pos += 4;
    }
    out.push({ tag, level, data: data.subarray(pos, pos + size) });
    pos += size;
  }
  return out;
}

export function serializeRecords(records: HwpRecord[]): Uint8Array {
  let total = 0;
  for (const r of records) total += 4 + (r.data.length >= 0xfff ? 4 : 0) + r.data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;
  for (const r of records) {
    const big = r.data.length >= 0xfff;
    dv.setUint32(pos, ((big ? 0xfff : r.data.length) << 20) | ((r.level & 0x3ff) << 10) | (r.tag & 0x3ff), true);
    pos += 4;
    if (big) {
      dv.setUint32(pos, r.data.length, true);
      pos += 4;
    }
    out.set(r.data, pos);
    pos += r.data.length;
  }
  return out;
}

/** 작은 바이너리 읽기 도우미 */
export class Reader {
  private dv: DataView;
  pos = 0;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining() { return this.buf.length - this.pos; }
  u8() { return this.dv.getUint8(this.pos++); }
  i8() { return this.dv.getInt8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; }
  /** 길이(u16) + UTF-16LE 문자열 */
  str() {
    const n = this.u16();
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s;
  }
}

/** 작은 바이너리 쓰기 도우미 */
export class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  i8(v: number) { return this.u8(v); }
  u16(v: number) { this.parts.push(v & 0xff, (v >>> 8) & 0xff); return this; }
  i16(v: number) { return this.u16(v); }
  u32(v: number) { this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  i32(v: number) { return this.u32(v >>> 0); }
  str(s: string) { this.u16(s.length); for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); return this; }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  done() { return Uint8Array.from(this.parts); }
}

/** 컨트롤 ID(4바이트) → 문자열. 예: 0x73656364 → 'secd' */
export const ctrlIdToString = (id: number) =>
  String.fromCharCode((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);

export const ctrlIdOf = (data: Uint8Array) =>
  data.length >= 4 ? ctrlIdToString(new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true)) : '';
