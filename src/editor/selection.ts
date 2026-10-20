/** DOM 선택 위치 ↔ 모델 위치(문단 번호, 문단 내 오프셋) 변환 */
import type { Pos } from './ops';

const ZWSP = /​/g;
const textUnits = (s: string) => s.replace(ZWSP, '').length;

const isObject = (n: Node): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('hwp-obj');
const isPlaceholder = (n: Node) => n instanceof HTMLElement && n.tagName === 'BR' && !!n.dataset.placeholder;

/** host 의 직계 자식 중 node 를 포함하는 문단 번호 */
function paraIndexOf(host: HTMLElement, node: Node): number {
  let n: Node | null = node;
  while (n && n.parentNode !== host) n = n.parentNode;
  return n ? Array.prototype.indexOf.call(host.childNodes, n) : -1;
}

function unitsBefore(p: Node, target: Node, offset: number): number {
  let count = 0;
  let done = false;
  const visit = (n: Node) => {
    if (done) return;
    if (n === target) {
      if (n.nodeType === Node.TEXT_NODE) count += textUnits((n.nodeValue ?? '').slice(0, offset));
      else for (let i = 0; i < offset && i < n.childNodes.length; i++) visit(n.childNodes[i]);
      done = true;
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) count += textUnits(n.nodeValue ?? '');
    else if (isObject(n)) count += 1;
    else if (n instanceof HTMLElement && n.tagName === 'BR') count += isPlaceholder(n) ? 0 : 1;
    else n.childNodes.forEach(visit);
  };
  if (p === target) {
    for (let i = 0; i < offset && i < p.childNodes.length; i++) visit(p.childNodes[i]);
  } else p.childNodes.forEach(visit);
  return count;
}

export function domToPos(host: HTMLElement, node: Node, offset: number): Pos | null {
  if (node === host) {
    const n = host.childNodes.length;
    if (n === 0) return { para: 0, offset: 0 };
    if (offset >= n) return { para: n - 1, offset: unitsBefore(host.childNodes[n - 1], host.childNodes[n - 1], host.childNodes[n - 1].childNodes.length) };
    return { para: offset, offset: 0 };
  }
  if (!host.contains(node)) return null;
  const para = paraIndexOf(host, node);
  if (para < 0) return null;
  return { para, offset: unitsBefore(host.childNodes[para], node, offset) };
}

/** 텍스트 노드 안에서 ZWSP 를 건너뛴 단위 오프셋 → 실제 문자 오프셋 */
function rawOffset(text: string, units: number): number {
  let u = 0;
  for (let i = 0; i < text.length; i++) {
    if (u === units && text[i] !== '​') return i;
    if (text[i] !== '​') u++;
  }
  return text.length;
}

export function posToDom(host: HTMLElement, pos: Pos): [Node, number] {
  const p = host.childNodes[Math.min(pos.para, host.childNodes.length - 1)];
  if (!p) return [host, 0];
  let remaining = pos.offset;
  let result: [Node, number] | null = null;
  const visit = (n: Node) => {
    if (result) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.nodeValue ?? '';
      const len = textUnits(t);
      if (remaining <= len && len > 0) { result = [n, rawOffset(t, remaining)]; return; }
      remaining -= len;
    } else if (isObject(n) || (n instanceof HTMLElement && n.tagName === 'BR')) {
      if (isPlaceholder(n)) return;
      if (remaining === 0) { result = [n.parentNode!, Array.prototype.indexOf.call(n.parentNode!.childNodes, n)]; return; }
      remaining -= 1;
    } else n.childNodes.forEach(visit);
  };
  p.childNodes.forEach(visit);
  if (result) return result;
  // 끝 위치: 자리표시 <br> 앞
  const ph = Array.from(p.childNodes).findIndex(isPlaceholder);
  return [p, ph >= 0 ? ph : p.childNodes.length];
}
