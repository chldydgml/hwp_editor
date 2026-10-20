/** 네임스페이스 접두사와 무관하게 localName 으로 다루는 XML 도우미 */

export const parseXml = (text: string): Document => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XML 파싱 오류: ' + err.textContent);
  return doc;
};

export const serializeXml = (node: Node): string => new XMLSerializer().serializeToString(node);

export function kids(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c);
  return out;
}

export function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}

/** 하위 전체에서 localName 으로 찾기 (문서 순서) */
export function descendants(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const root = el instanceof Element ? el : el.documentElement;
  if (!root) return out;
  const stack: Element[] = [];
  for (let c = root.lastElementChild; c; c = c.previousElementSibling) stack.push(c);
  if (el !== root && root.localName === name) out.push(root);
  while (stack.length) {
    const n = stack.pop()!;
    if (n.localName === name) out.push(n);
    for (let c = n.lastElementChild; c; c = c.previousElementSibling) stack.push(c);
  }
  return out;
}

export const descendant = (el: Element | Document, name: string): Element | null =>
  descendants(el, name)[0] ?? null;

export const attr = (el: Element | null | undefined, name: string, fallback = ''): string =>
  el?.getAttribute(name) ?? fallback;

export const intAttr = (el: Element | null | undefined, name: string, fallback = 0): number => {
  const v = el?.getAttribute(name);
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const escapeXml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();
export const decodeUtf8 = (b: Uint8Array): string => utf8Decoder.decode(b).replace(/^﻿/, '');
export const encodeUtf8 = (s: string): Uint8Array => utf8Encoder.encode(s);
