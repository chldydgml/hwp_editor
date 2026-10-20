// HWP_CORPUS 환경변수의 폴더(하위 포함)에 있는 실제 .hwp/.hwpx 파일로 왕복 변환을 검사합니다.
// 결과 파일은 HWP_OUT 폴더가 있으면 그곳에 저장합니다.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDocument, saveDocument } from '../src/io/files';
import type { HwpDocument } from '../src/model/types';

const root = process.env.HWP_CORPUS;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.hwpx?$/i.test(f) ? [p] : [];
  });
const files = root ? walk(root) : [];

/** 개체 미리보기를 제외한 본문 텍스트 */
const bodyText = (d: HwpDocument) =>
  d.sections.map((s) => s.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'text' ? r.text : '')).join('')).join('\n')).join('\n\n');
const objectCount = (d: HwpDocument) =>
  d.sections.reduce((n, s) => n + s.paragraphs.reduce((m, p) => m + p.runs.filter((r) => r.kind === 'control').length, 0), 0);

describe.skipIf(!root)('실제 문서 왕복 변환', () => {
  for (const file of files) {
    it(basename(file), async () => {
      let doc: HwpDocument;
      try {
        doc = await openDocument(new Uint8Array(readFileSync(file)));
      } catch (e) {
        if (/암호|배포용/.test((e as Error).message)) return; // 지원하지 않는 보호 문서
        throw e;
      }
      const same = file.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp';
      const other = same === 'hwp' ? 'hwpx' : 'hwp';
      const text = bodyText(doc);

      const sameBytes = await saveDocument(doc, same);
      const back = await openDocument(sameBytes);
      expect(bodyText(back)).toBe(text);
      expect(objectCount(back)).toBe(objectCount(doc));

      const otherBytes = await saveDocument(doc, other);
      const cross = await openDocument(otherBytes);
      expect(bodyText(cross)).toBe(text);

      if (process.env.HWP_OUT) {
        writeFileSync(join(process.env.HWP_OUT, `${basename(file)}.${same}`), sameBytes);
        writeFileSync(join(process.env.HWP_OUT, `${basename(file)}.x.${other}`), otherBytes);
      }
    });
  }
});
