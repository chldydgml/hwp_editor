/** 편집용 DOM → 문서 모델 (브라우저가 직접 처리한 입력을 모델에 반영) */
import type { CharProps, HwpDocument, Paragraph, Run } from '../model/types';
import { internCharShape, mergeRuns } from '../model/util';
import { controlRuns } from './render';

const BOLD_TAGS = new Set(['B', 'STRONG']);
const ITALIC_TAGS = new Set(['I', 'EM']);
const STRIKE_TAGS = new Set(['S', 'STRIKE', 'DEL']);

/** data-cs 가 없는 요소(붙여넣기·브라우저 생성)의 서식을 글자 속성에 덮어씁니다. */
function applyOverrides(props: CharProps, el: HTMLElement): void {
  if (BOLD_TAGS.has(el.tagName)) props.bold = true;
  if (ITALIC_TAGS.has(el.tagName)) props.italic = true;
  if (el.tagName === 'U') props.underline = true;
  if (STRIKE_TAGS.has(el.tagName)) props.strike = true;
  if (el.tagName === 'SUP') props.superscript = true;
  if (el.tagName === 'SUB') props.subscript = true;
  const s = el.style;
  if (s.fontWeight) props.bold = s.fontWeight === 'bold' || +s.fontWeight >= 600;
  if (s.fontStyle) props.italic = s.fontStyle === 'italic';
}

/** 문단 요소의 내용을 모델 문단으로 변환합니다. */
export function extractParagraph(doc: HwpDocument, el: HTMLElement): Paragraph {
  const runs: Run[] = [];
  const endcs = +(el.dataset.endcs ?? 0);
  let lastCs = endcs;

  const shapeOf = (node: Node): number => {
    // 가장 가까운 data-cs 요소 + 그 안쪽 서식 태그
    const chain: HTMLElement[] = [];
    let cur = node.parentElement;
    let base: number | null = null;
    while (cur && cur !== el) {
      if (cur.dataset.cs !== undefined) { base = +cur.dataset.cs; break; }
      chain.push(cur);
      cur = cur.parentElement;
    }
    const id = base ?? lastCs;
    if (chain.length === 0) return id;
    const props = structuredClone(doc.charShapes[id]?.props ?? doc.charShapes[0].props);
    for (const c of chain.reverse()) applyOverrides(props, c);
    return internCharShape(doc, props, id);
  };

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.nodeValue ?? '').replace(/​/g, '');
        if (!text) continue;
        lastCs = shapeOf(child);
        runs.push({ kind: 'text', charShapeId: lastCs, text });
      } else if (child instanceof HTMLElement) {
        const ctrl = controlRuns.get(child);
        if (ctrl) { runs.push(ctrl); lastCs = ctrl.charShapeId; continue; }
        if (child.tagName === 'BR') {
          if (child.dataset.placeholder || isTrailingBr(child, el)) continue;
          runs.push({ kind: 'text', charShapeId: shapeOf(child.firstChild ?? child), text: '\n' });
          continue;
        }
        walk(child);
      }
    }
  };
  walk(el);

  const merged = mergeRuns(runs);
  return {
    paraShapeId: +(el.dataset.ps ?? 0),
    styleId: +(el.dataset.style ?? 0),
    runs: merged,
    pageBreak: el.dataset.pagebreak === '1' || undefined,
    columnBreak: el.dataset.colbreak === '1' || undefined,
    endCharShapeId: merged.length ? merged[merged.length - 1].charShapeId : endcs,
  };
}

/** 블록 끝의 <br> 은 브라우저가 커서 자리로 넣은 것이므로 무시합니다. */
function isTrailingBr(br: Element, block: Element): boolean {
  let n: Node | null = br;
  while (n && n !== block) {
    let s = n.nextSibling;
    while (s && s.nodeType === Node.TEXT_NODE && !(s.nodeValue ?? '').replace(/​/g, '')) s = s.nextSibling;
    if (s) return false;
    n = n.parentNode;
  }
  return true;
}
