import { LANGS, type Align, type CharProps, type LineSpacingType, type ParaProps, type PerLang, type Style } from '../../model/types';
import { defaultCharProps, defaultParaProps } from '../../model/util';
import { attr, descendants, intAttr, kid, kids, parseXml, serializeXml } from '../xml';
import { FONT_LANGS, NS } from './ns';

export type FontTable = PerLang<string[]>;

/** hh:fontfaces → 언어별 글꼴 이름 목록 (인덱스 = font id) */
export function readFonts(head: Element): FontTable {
  const table: FontTable = [[], [], [], [], [], [], []];
  for (const ff of descendants(head, 'fontface')) {
    const li = FONT_LANGS.indexOf(attr(ff, 'lang') as (typeof FONT_LANGS)[number]);
    if (li < 0) continue;
    for (const f of kids(ff, 'font')) table[li][intAttr(f, 'id')] = attr(f, 'face');
  }
  return table;
}

const langValues = (el: Element | null, fallback: number): PerLang<number> =>
  LANGS.map((l) => intAttr(el, l, fallback)) as PerLang<number>;

const colorAttr = (v: string, fallback: string) => {
  if (!v || v === 'none') return fallback;
  return v.length === 9 ? '#' + v.slice(3) : v.toUpperCase(); // #AARRGGBB → #RRGGBB
};

export function readCharPr(el: Element, fonts: FontTable): CharProps {
  const p = defaultCharProps();
  const ref = kid(el, 'fontRef');
  p.faces = LANGS.map((l, i) => fonts[i][intAttr(ref, l)] ?? fonts[i][0] ?? p.faces[i]) as PerLang<string>;
  p.size = intAttr(el, 'height', 1000);
  p.color = colorAttr(attr(el, 'textColor'), '#000000');
  p.shade = attr(el, 'shadeColor', 'none') === 'none' ? 'none' : colorAttr(attr(el, 'shadeColor'), 'none');
  p.ratio = langValues(kid(el, 'ratio'), 100);
  p.spacing = langValues(kid(el, 'spacing'), 0);
  p.relSize = langValues(kid(el, 'relSz'), 100);
  p.offset = langValues(kid(el, 'offset'), 0);
  p.bold = !!kid(el, 'bold');
  p.italic = !!kid(el, 'italic');
  p.underline = attr(kid(el, 'underline'), 'type', 'NONE') !== 'NONE';
  p.strike = !['NONE', ''].includes(attr(kid(el, 'strikeout'), 'shape', 'NONE'));
  p.superscript = !!kid(el, 'supscript');
  p.subscript = !!kid(el, 'subscript');
  return p;
}

const ALIGNS: Record<string, Align> = {
  JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'distribute', DISTRIBUTE_SPACE: 'divide',
};
const ALIGN_NAMES = Object.fromEntries(Object.entries(ALIGNS).map(([k, v]) => [v, k])) as Record<Align, string>;
const LS_TYPES: Record<string, LineSpacingType> = {
  PERCENT: 'percent', FIXED: 'fixed', BETWEEN_LINES: 'between', AT_LEAST: 'atLeast',
};
const LS_NAMES = Object.fromEntries(Object.entries(LS_TYPES).map(([k, v]) => [v, k])) as Record<LineSpacingType, string>;

/** hp:switch 가 있으면 hp:case(실제 HWPUNIT 값), 없으면 직접 자식(2배 값) */
function marginSource(el: Element): { margin: Element | null; spacing: Element | null; scale: number } {
  for (const sw of kids(el, 'switch')) {
    const c = kid(sw, 'case');
    if (c && kid(c, 'margin')) return { margin: kid(c, 'margin'), spacing: kid(c, 'lineSpacing'), scale: 1 };
  }
  return { margin: kid(el, 'margin'), spacing: kid(el, 'lineSpacing'), scale: 2 };
}

export function readParaPr(el: Element): ParaProps {
  const p = defaultParaProps();
  p.align = ALIGNS[attr(kid(el, 'align'), 'horizontal', 'JUSTIFY')] ?? 'justify';
  const { margin, spacing, scale } = marginSource(el);
  const m = (n: string) => Math.round(intAttr(kid(margin, n), 'value') / scale);
  p.indent = m('intent');
  p.marginLeft = m('left');
  p.marginRight = m('right');
  p.spaceBefore = m('prev');
  p.spaceAfter = m('next');
  p.lineSpacingType = LS_TYPES[attr(spacing, 'type', 'PERCENT')] ?? 'percent';
  const ls = intAttr(spacing, 'value', 160);
  p.lineSpacing = p.lineSpacingType === 'percent' ? ls : Math.round(ls / scale);
  return p;
}

export function readStyle(el: Element): Style {
  return {
    name: attr(el, 'name'),
    engName: attr(el, 'engName'),
    type: attr(el, 'type') === 'CHAR' ? 'char' : 'para',
    paraShapeId: intAttr(el, 'paraPrIDRef'),
    charShapeId: intAttr(el, 'charPrIDRef'),
    nextStyleId: intAttr(el, 'nextStyleIDRef'),
    raw: { hwpx: serializeXml(el) },
  };
}

// ───────────────────────── 쓰기 ─────────────────────────

const hh = (doc: Document, name: string) => doc.createElementNS(NS.hh, 'hh:' + name);

function ensureKid(el: Element, name: string, ns: string, prefix: string, before?: string[]): Element {
  let k = kid(el, name);
  if (k) return k;
  k = el.ownerDocument.createElementNS(ns, `${prefix}:${name}`);
  const ref = before ? Array.from(el.children).find((c) => before.includes(c.localName)) : null;
  el.insertBefore(k, ref ?? null);
  return k;
}

const setLang = (el: Element, values: readonly (number | string)[]) =>
  LANGS.forEach((l, i) => el.setAttribute(l, String(values[i])));

/** 원본 charPr(없으면 템플릿 기본) 위에 속성을 덮어써 새 charPr 요소를 만듭니다. */
export function buildCharPr(doc: Document, base: string, id: number, p: CharProps, fontIds: PerLang<number>): Element {
  const el = doc.importNode(parseXml(base).documentElement, true) as Element;
  el.setAttribute('id', String(id));
  el.setAttribute('height', String(p.size));
  el.setAttribute('textColor', p.color);
  el.setAttribute('shadeColor', p.shade);
  const order = ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold', 'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave', 'supscript', 'subscript'];
  const after = (name: string) => order.slice(order.indexOf(name) + 1);
  setLang(ensureKid(el, 'fontRef', NS.hh, 'hh', after('fontRef')), fontIds);
  setLang(ensureKid(el, 'ratio', NS.hh, 'hh', after('ratio')), p.ratio);
  setLang(ensureKid(el, 'spacing', NS.hh, 'hh', after('spacing')), p.spacing);
  setLang(ensureKid(el, 'relSz', NS.hh, 'hh', after('relSz')), p.relSize);
  setLang(ensureKid(el, 'offset', NS.hh, 'hh', after('offset')), p.offset);
  for (const [name, on] of [['italic', p.italic], ['bold', p.bold], ['supscript', p.superscript], ['subscript', p.subscript]] as const) {
    const cur = kid(el, name);
    if (on && !cur) ensureKid(el, name, NS.hh, 'hh', after(name));
    if (!on && cur) cur.remove();
  }
  // 밑줄/취소선 요소는 원본에 없고 꺼져 있으면 만들지 않습니다.
  if (p.underline || kid(el, 'underline')) {
    const ul = ensureKid(el, 'underline', NS.hh, 'hh', after('underline'));
    if (p.underline) {
      if (attr(ul, 'type', 'NONE') === 'NONE') ul.setAttribute('type', 'BOTTOM');
    } else ul.setAttribute('type', 'NONE');
    if (!ul.getAttribute('shape')) ul.setAttribute('shape', 'SOLID');
    if (!ul.getAttribute('color')) ul.setAttribute('color', '#000000');
  }
  if (p.strike || kid(el, 'strikeout')) {
    const so = ensureKid(el, 'strikeout', NS.hh, 'hh', after('strikeout'));
    if (p.strike) {
      if (['NONE', ''].includes(attr(so, 'shape', 'NONE'))) so.setAttribute('shape', 'SOLID');
    } else so.setAttribute('shape', 'NONE');
    if (!so.getAttribute('color')) so.setAttribute('color', '#000000');
  }
  return el;
}

function setMargin(margin: Element, p: ParaProps, scale: number) {
  const vals: [string, number][] = [
    ['intent', p.indent], ['left', p.marginLeft], ['right', p.marginRight], ['prev', p.spaceBefore], ['next', p.spaceAfter],
  ];
  for (const [n, v] of vals) {
    const c = ensureKid(margin, n, NS.hc, 'hc');
    c.setAttribute('value', String(v * scale));
    c.setAttribute('unit', 'HWPUNIT');
  }
}

function setSpacing(sp: Element, p: ParaProps, scale: number) {
  sp.setAttribute('type', LS_NAMES[p.lineSpacingType]);
  sp.setAttribute('value', String(p.lineSpacingType === 'percent' ? p.lineSpacing : p.lineSpacing * scale));
  sp.setAttribute('unit', 'HWPUNIT');
}

export function buildParaPr(doc: Document, base: string, id: number, p: ParaProps): Element {
  const el = doc.importNode(parseXml(base).documentElement, true) as Element;
  el.setAttribute('id', String(id));
  ensureKid(el, 'align', NS.hh, 'hh', ['heading', 'breakSetting', 'autoSpacing', 'switch', 'margin', 'lineSpacing', 'border'])
    .setAttribute('horizontal', ALIGN_NAMES[p.align]);
  const sw = kid(el, 'switch');
  if (sw) {
    const c = kid(sw, 'case');
    const d = kid(sw, 'default');
    if (c) {
      setMargin(ensureKid(c, 'margin', NS.hh, 'hh', ['lineSpacing']), p, 1);
      setSpacing(ensureKid(c, 'lineSpacing', NS.hh, 'hh'), p, 1);
    }
    if (d) {
      setMargin(ensureKid(d, 'margin', NS.hh, 'hh', ['lineSpacing']), p, 2);
      setSpacing(ensureKid(d, 'lineSpacing', NS.hh, 'hh'), p, 2);
    }
  } else {
    setMargin(ensureKid(el, 'margin', NS.hh, 'hh', ['lineSpacing', 'border']), p, 2);
    setSpacing(ensureKid(el, 'lineSpacing', NS.hh, 'hh', ['border']), p, 2);
  }
  return el;
}

export function buildStyle(doc: Document, s: Style, id: number): Element {
  const el = s.raw?.hwpx ? (doc.importNode(parseXml(s.raw.hwpx).documentElement, true) as Element) : hh(doc, 'style');
  el.setAttribute('id', String(id));
  el.setAttribute('type', s.type === 'char' ? 'CHAR' : 'PARA');
  el.setAttribute('name', s.name);
  el.setAttribute('engName', s.engName);
  el.setAttribute('paraPrIDRef', String(s.paraShapeId));
  el.setAttribute('charPrIDRef', String(s.charShapeId));
  el.setAttribute('nextStyleIDRef', String(s.nextStyleId));
  if (!el.getAttribute('langID')) el.setAttribute('langID', '1042');
  if (!el.getAttribute('lockForm')) el.setAttribute('lockForm', '0');
  return el;
}

/** 새 글꼴을 fontface 목록에 추가합니다 (기존 첫 글꼴 요소를 복제해 이름만 변경). */
export function addFont(fontface: Element, face: string, id: number): void {
  const doc = fontface.ownerDocument;
  const tpl = kid(fontface, 'font');
  const f = tpl ? (tpl.cloneNode(true) as Element) : doc.createElementNS(NS.hh, 'hh:font');
  f.setAttribute('id', String(id));
  f.setAttribute('face', face);
  f.setAttribute('type', 'TTF');
  f.setAttribute('isEmbedded', '0');
  for (const sub of kids(f, 'substFont')) sub.remove();
  fontface.appendChild(f);
  fontface.setAttribute('fontCnt', String(kids(fontface, 'font').length));
}
