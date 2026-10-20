// HWP_OUT 환경변수가 있으면 샘플 저장 결과를 파일로 남깁니다 (외부 검증 도구용).
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { readHwpx } from '../src/formats/hwpx/reader';
import { writeHwpx } from '../src/formats/hwpx/writer';
import { base64ToBytes, internCharShape } from '../src/model/util';
import { BLANK_HWPX_BASE64 } from '../src/templates/embedded';

it.skipIf(!process.env.HWP_OUT)('샘플 파일 출력', async () => {
  const doc = await readHwpx(base64ToBytes(BLANK_HWPX_BASE64));
  const bold = internCharShape(doc, { ...doc.charShapes[0].props, bold: true, size: 1600 }, 0);
  doc.sections[0].paragraphs = [
    { paraShapeId: 0, styleId: 0, runs: [{ kind: 'text', charShapeId: bold, text: '샘플 제목' }] },
    { paraShapeId: 1, styleId: 1, runs: [{ kind: 'text', charShapeId: 0, text: '본문 문단입니다.\t탭 뒤' }] },
  ];
  writeFileSync(`${process.env.HWP_OUT}/sample.hwpx`, await writeHwpx(doc));
});
