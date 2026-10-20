import type { CharProps, CharShape, HwpDocument, PageDef, ParaProps, ParaShape, PerLang, Run } from './types';

export const perLang = <T>(v: T): PerLang<T> => [v, v, v, v, v, v, v];

export const defaultCharProps = (): CharProps => ({
  faces: perLang('함초롬바탕'),
  size: 1000,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  superscript: false,
  subscript: false,
  color: '#000000',
  shade: 'none',
  ratio: perLang(100),
  spacing: perLang(0),
  relSize: perLang(100),
  offset: perLang(0),
});

export const defaultParaProps = (): ParaProps => ({
  align: 'justify',
  lineSpacingType: 'percent',
  lineSpacing: 160,
  indent: 0,
  marginLeft: 0,
  marginRight: 0,
  spaceBefore: 0,
  spaceAfter: 0,
});

/** A4 세로, 한글 기본 여백 */
export const defaultPage = (): PageDef => ({
  width: 59528,
  height: 84186,
  landscape: false,
  marginLeft: 8504,
  marginRight: 8504,
  marginTop: 5668,
  marginBottom: 4252,
  marginHeader: 4252,
  marginFooter: 4252,
  marginGutter: 0,
});

/** 속성 비교용 키 */
export const propsKey = (p: CharProps | ParaProps): string => JSON.stringify(p, Object.keys(p).sort());

/**
 * 주어진 글자 속성과 같은 글자 모양을 찾고, 없으면 `baseId` 모양의 원본 데이터를
 * 바탕으로 새 모양을 추가해 그 번호를 돌려줍니다.
 */
export function internCharShape(doc: HwpDocument, props: CharProps, baseId: number): number {
  const base = doc.charShapes[baseId];
  if (base && propsKey(base.props) === propsKey(props)) return baseId;
  const key = propsKey(props);
  const found = doc.charShapes.findIndex((s) => propsKey(s.props) === key);
  if (found >= 0) return found;
  const shape: CharShape = { props: structuredClone(props), raw: base?.raw };
  doc.charShapes.push(shape);
  return doc.charShapes.length - 1;
}

export function internParaShape(doc: HwpDocument, props: ParaProps, baseId: number): number {
  const base = doc.paraShapes[baseId];
  if (base && propsKey(base.props) === propsKey(props)) return baseId;
  const key = propsKey(props);
  const found = doc.paraShapes.findIndex((s) => propsKey(s.props) === key);
  if (found >= 0) return found;
  const shape: ParaShape = { props: structuredClone(props), raw: base?.raw };
  doc.paraShapes.push(shape);
  return doc.paraShapes.length - 1;
}

export const runText = (r: Run): string => (r.kind === 'text' ? r.text : (r.ctrl.preview ?? ''));

/** 문서 전체의 일반 텍스트 (미리보기 저장용) */
export function plainText(doc: HwpDocument): string {
  return doc.sections
    .flatMap((s) => s.paragraphs.map((p) => p.runs.map(runText).join('')))
    .join('\r\n');
}

/** 같은 글자 모양의 연속된 텍스트 조각을 하나로 합칩니다. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (r.kind === 'text' && prev?.kind === 'text' && prev.charShapeId === r.charShapeId) {
      prev.text += r.text;
    } else if (r.kind !== 'text' || r.text.length > 0) {
      out.push(r.kind === 'text' ? { ...r } : r);
    }
  }
  return out;
}

export const hwpUnitToPt = (v: number) => v / 100;
export const ptToHwpUnit = (v: number) => Math.round(v * 100);
export const hwpUnitToMm = (v: number) => (v / 7200) * 25.4;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** '#RRGGBB' ↔ HWP COLORREF(0x00BBGGRR) */
export function colorrefToHex(c: number): string {
  const r = c & 0xff, g = (c >> 8) & 0xff, b = (c >> 16) & 0xff;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function hexToColorref(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  return (parseInt(m[1], 16) | (parseInt(m[2], 16) << 8) | (parseInt(m[3], 16) << 16)) >>> 0;
}
