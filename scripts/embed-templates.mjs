// src/templates/*.hwp(x) 빈 문서 템플릿을 base64 문자열 모듈로 변환합니다.
// 사용법: node scripts/embed-templates.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../src/templates/', import.meta.url);
const b64 = (name) => readFileSync(new URL(name, dir)).toString('base64');
const out = `// 자동 생성 파일 — scripts/embed-templates.mjs 로 다시 만드세요.
// blank.hwpx 는 python-hwpx(Apache-2.0)의 Skeleton.hwpx, blank.hwp 는 그것을 HWP 5.0으로 변환한 파일입니다.
export const BLANK_HWPX_BASE64 = '${b64('blank.hwpx')}';
export const BLANK_HWP_BASE64 = '${b64('blank.hwp')}';
`;
writeFileSync(new URL('embedded.ts', dir), out);
console.log('src/templates/embedded.ts 생성 완료');
