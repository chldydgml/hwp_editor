/** OWPML(HWPX) 네임스페이스 — 한컴오피스가 문서 루트에 선언하는 전체 집합 */
export const NS = {
  ha: 'http://www.hancom.co.kr/hwpml/2011/app',
  hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  hp10: 'http://www.hancom.co.kr/hwpml/2016/paragraph',
  hs: 'http://www.hancom.co.kr/hwpml/2011/section',
  hc: 'http://www.hancom.co.kr/hwpml/2011/core',
  hh: 'http://www.hancom.co.kr/hwpml/2011/head',
  hhs: 'http://www.hancom.co.kr/hwpml/2011/history',
  hm: 'http://www.hancom.co.kr/hwpml/2011/master-page',
  hpf: 'http://www.hancom.co.kr/schema/2011/hpf',
  dc: 'http://purl.org/dc/elements/1.1/',
  opf: 'http://www.idpf.org/2007/opf/',
  ooxmlchart: 'http://www.hancom.co.kr/hwpml/2016/ooxmlchart',
  hwpunitchar: 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar',
  epub: 'http://www.idpf.org/2007/ops',
  config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
} as const;

export const NS_DECLS = Object.entries(NS)
  .map(([p, u]) => `xmlns:${p}="${u}"`)
  .join(' ');

const KNOWN = new Set(Object.entries(NS).map(([p, u]) => `${p}=${u}`));

/** 문서 루트에 이미 선언된 표준 네임스페이스의 중복 선언을 조각에서 제거합니다. */
export const stripKnownNs = (xml: string): string =>
  xml.replace(/ xmlns:([A-Za-z0-9]+)="([^"]*)"/g, (m, p, u) => (KNOWN.has(`${p}=${u}`) ? '' : m));

/** HWPX 언어 그룹 이름 (fontface lang 속성) */
export const FONT_LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const;

/** 모든 표준 네임스페이스를 루트 요소에만 한 번 선언하도록 정리합니다. */
export const normalizeRootNs = (xml: string): string =>
  stripKnownNs(xml).replace(/^(<[A-Za-z0-9:]+)/, `$1 ${NS_DECLS}`);
