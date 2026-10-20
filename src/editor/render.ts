/** 문서 모델 → 편집용 DOM */
import type { CharProps, ControlRun, HwpDocument, PageDef, ParaProps, Paragraph } from '../model/types';

/** 한글 글꼴 이름 → 웹 대체 글꼴 */
const FONT_FALLBACK: [RegExp, string][] = [
  [/돋움|고딕|굴림|gothic|dotum|gulim|sans/i, "'Noto Sans KR', 'Malgun Gothic', sans-serif"],
  [/바탕|명조|궁서|batang|myeongjo|serif/i, "'Noto Serif KR', 'Batang', serif"],
];

export function fontStack(face: string): string {
  const fb = FONT_FALLBACK.find(([re]) => re.test(face))?.[1] ?? "'Noto Serif KR', serif";
  return `'${face.replace(/'/g, '')}', ${fb}`;
}

const pt = (hwpunit: number) => `${+(hwpunit / 100).toFixed(2)}pt`;

export function charCss(p: CharProps): string {
  const css: string[] = [];
  css.push(`font-family:${fontStack(p.faces[0])}`);
  css.push(`font-size:${pt((p.size * p.relSize[0]) / 100)}`);
  if (p.bold) css.push('font-weight:bold');
  if (p.italic) css.push('font-style:italic');
  const deco = [p.underline && 'underline', p.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (p.color !== '#000000') css.push(`color:${p.color}`);
  if (p.shade !== 'none') css.push(`background-color:${p.shade}`);
  if (p.superscript) css.push('vertical-align:super;font-size:smaller');
  else if (p.subscript) css.push('vertical-align:sub;font-size:smaller');
  if (p.spacing[0]) css.push(`letter-spacing:${p.spacing[0] / 100}em`);
  return css.join(';');
}

export function paraCss(p: ParaProps): string {
  const css: string[] = [];
  const align = p.align === 'distribute' || p.align === 'divide' ? 'justify' : p.align;
  css.push(`text-align:${align}`);
  if (p.align === 'distribute' || p.align === 'divide') css.push('text-align-last:justify');
  let left = p.marginLeft;
  if (p.indent < 0) {
    // 내어쓰기: 둘째 줄부터 들여씀
    left += -p.indent;
    css.push(`text-indent:${pt(p.indent)}`);
  } else if (p.indent > 0) css.push(`text-indent:${pt(p.indent)}`);
  if (left) css.push(`padding-left:${pt(left)}`);
  if (p.marginRight) css.push(`padding-right:${pt(p.marginRight)}`);
  if (p.spaceBefore) css.push(`margin-top:${pt(p.spaceBefore)}`);
  if (p.spaceAfter) css.push(`margin-bottom:${pt(p.spaceAfter)}`);
  switch (p.lineSpacingType) {
    case 'percent': css.push(`line-height:${p.lineSpacing / 100}`); break;
    case 'fixed': case 'atLeast': css.push(`line-height:${pt(p.lineSpacing)}`); break;
    case 'between': css.push(`line-height:calc(1em + ${pt(p.lineSpacing)})`); break;
  }
  return css.join(';');
}

/** 용지 크기(가로 방향이면 폭/높이 교환)와 여백 */
export function pageBox(page: PageDef) {
  const [w, h] = page.landscape ? [page.height, page.width] : [page.width, page.height];
  return {
    width: w,
    height: h,
    paddingTop: page.marginTop + page.marginHeader,
    paddingBottom: page.marginBottom + page.marginFooter,
    paddingLeft: page.marginLeft + page.marginGutter,
    paddingRight: page.marginRight,
  };
}

export function pageCss(page: PageDef): string {
  const b = pageBox(page);
  return [
    `width:${pt(b.width)}`,
    `min-height:${pt(b.height)}`,
    `padding:${pt(b.paddingTop)} ${pt(b.paddingRight)} ${pt(b.paddingBottom)} ${pt(b.paddingLeft)}`,
    `--page-body-height:${pt(b.height - b.paddingTop - b.paddingBottom)}`,
  ].join(';');
}

/** 개체 DOM ↔ 모델 연결 */
export const controlRuns = new WeakMap<Element, ControlRun>();

function renderControl(run: ControlRun): HTMLElement {
  const el = document.createElement('span');
  el.className = 'hwp-obj';
  el.contentEditable = 'false';
  el.dataset.cs = String(run.charShapeId);
  el.title = `${run.ctrl.label}${run.ctrl.preview ? ': ' + run.ctrl.preview : ''} (보존됨 — 편집 미지원)`;
  const label = document.createElement('b');
  label.textContent = run.ctrl.label;
  el.append(label);
  if (run.ctrl.preview) el.append(' ' + run.ctrl.preview.slice(0, 40) + (run.ctrl.preview.length > 40 ? '…' : ''));
  controlRuns.set(el, run);
  return el;
}

/** 문단 하나를 <p> 로 그립니다. */
export function renderParagraph(doc: HwpDocument, p: Paragraph): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = 'hwp-p';
  el.dataset.ps = String(p.paraShapeId);
  el.dataset.style = String(p.styleId);
  el.dataset.endcs = String(p.endCharShapeId ?? p.runs[0]?.charShapeId ?? 0);
  if (p.pageBreak) el.dataset.pagebreak = '1';
  if (p.columnBreak) el.dataset.colbreak = '1';
  el.style.cssText = paraCss(doc.paraShapes[p.paraShapeId]?.props ?? doc.paraShapes[0].props);
  for (const r of p.runs) {
    if (r.kind === 'control') { el.append(renderControl(r)); continue; }
    const span = document.createElement('span');
    span.dataset.cs = String(r.charShapeId);
    span.style.cssText = charCss(doc.charShapes[r.charShapeId]?.props ?? doc.charShapes[0].props);
    const parts = r.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) span.append(document.createElement('br'));
      if (part) span.append(part);
    });
    el.append(span);
  }
  // 빈 문단이나 줄바꿈으로 끝나는 문단은 커서 자리를 위한 <br> 추가
  const last = p.runs[p.runs.length - 1];
  if (!last || (last.kind === 'text' && last.text.endsWith('\n'))) {
    const br = document.createElement('br');
    br.dataset.placeholder = '1';
    el.append(br);
  }
  return el;
}
