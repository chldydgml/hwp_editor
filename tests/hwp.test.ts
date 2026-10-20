import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readHwp } from '../src/formats/hwp/reader';
import { base64ToBytes } from '../src/model/util';
import { BLANK_HWP_BASE64 } from '../src/templates/embedded';

const fixture = (name: string) => new Uint8Array(readFileSync(`${process.cwd()}/tests/fixtures/${name}`));

describe('HWP 읽기', () => {
  it('빈 템플릿', async () => {
    const doc = await readHwp(base64ToBytes(BLANK_HWP_BASE64));
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].page.width).toBe(59528);
    expect(doc.sections[0].page.marginLeft).toBe(8504);
    expect(doc.charShapes).toHaveLength(7);
    expect(doc.paraShapes).toHaveLength(20);
    expect(doc.styles[0].name).toBe('바탕글');
    expect(doc.paraShapes[1].props.marginLeft).toBe(1500);
    expect(doc.charShapes[0].props.faces[0]).toBe('함초롬바탕');
    expect(doc.sections[0].raw?.hwpSecd).toBeDefined();
    expect(doc.sections[0].raw?.hwpCold).toBeDefined();
    expect(doc.sections[0].paragraphs[0].runs).toHaveLength(0);
  });

  it('텍스트와 글자 모양', async () => {
    const doc = await readHwp(fixture('sample.hwp'));
    const ps = doc.sections[0].paragraphs;
    const text = (i: number) => ps[i].runs.map((r) => (r.kind === 'text' ? r.text : '')).join('');
    expect(text(0)).toBe('샘플 제목');
    expect(text(1)).toBe('본문 문단입니다.\t탭 뒤');
    const cs = doc.charShapes[ps[0].runs[0].charShapeId].props;
    expect(cs.bold).toBe(true);
    expect(cs.size).toBe(1600);
    expect(doc.paraShapes[ps[1].paraShapeId].props.marginLeft).toBe(1500);
  });
});

import { writeHwp } from '../src/formats/hwp/writer';
import { readHwpx } from '../src/formats/hwpx/reader';
import { internCharShape, internParaShape } from '../src/model/util';
import { BLANK_HWPX_BASE64 } from '../src/templates/embedded';
import type { HwpDocument } from '../src/model/types';

const textOf = (doc: HwpDocument) => doc.sections[0].paragraphs.map((p) => p.runs.map((r) => (r.kind === 'text' ? r.text : `[${r.ctrl.label}]`)).join(''));

describe('HWP 쓰기', () => {
  for (const [name, open] of [
    ['HWP 원본', () => readHwp(fixture('sample.hwp'))],
    ['HWPX 원본(교차 변환)', () => readHwpx(base64ToBytes(BLANK_HWPX_BASE64))],
  ] as const) {
    it(`${name}을 편집 후 HWP로 저장하고 다시 읽는다`, async () => {
      const doc = await open();
      const big = internCharShape(doc, { ...doc.charShapes[0].props, bold: true, italic: true, underline: true, size: 2000, color: '#FF0000', faces: ['맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕'] }, 0);
      const right = internParaShape(doc, { ...doc.paraShapes[0].props, align: 'right', lineSpacingType: 'fixed', lineSpacing: 2000, indent: -1000 }, 0);
      doc.sections[0].paragraphs = [
        { paraShapeId: right, styleId: 0, runs: [{ kind: 'text', charShapeId: big, text: '가나다 ABC' }, { kind: 'text', charShapeId: 0, text: '\t보통\n둘째 줄 😀' }] },
        { paraShapeId: 0, styleId: 0, runs: [], pageBreak: true },
        { paraShapeId: 0, styleId: 0, runs: [{ kind: 'text', charShapeId: 0, text: '끝' }] },
      ];
      doc.sections[0].page.landscape = true;
      doc.sections[0].page.marginLeft = 5000;

      const back = await readHwp(await writeHwp(doc));
      expect(textOf(back)).toEqual(['가나다 ABC\t보통\n둘째 줄 😀', '', '끝']);
      const p0 = back.sections[0].paragraphs[0];
      const c = back.charShapes[p0.runs[0].charShapeId].props;
      expect([c.bold, c.italic, c.underline, c.size, c.color, c.faces[0]]).toEqual([true, true, true, 2000, '#FF0000', '맑은 고딕']);
      const ps = back.paraShapes[p0.paraShapeId].props;
      expect([ps.align, ps.lineSpacingType, ps.lineSpacing, ps.indent]).toEqual(['right', 'fixed', 2000, -1000]);
      expect(back.sections[0].paragraphs[1].pageBreak).toBe(true);
      expect(back.sections[0].page.landscape).toBe(true);
      expect(back.sections[0].page.marginLeft).toBe(5000);
      expect(back.styles[0].name).toBe('바탕글');
    });
  }
});

import { readCompound } from '../src/formats/hwp/cfb';
import { buildCompoundFile } from '../src/formats/hwp/cfbWriter';

describe('CFB 작성기', () => {
  it('작은/큰 스트림과 하위 저장소를 기록하고 다시 읽는다', () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const streams = new Map<string, Uint8Array>([
      ['FileHeader', new Uint8Array(256).fill(7)],
      ['BodyText/Section0', big],
      ['BodyText/Section1', new Uint8Array([1, 2, 3])],
      ['BinData/BIN0001.png', new Uint8Array(5000).fill(9)],
      ['\u0005HwpSummaryInformation', new Uint8Array(100).fill(5)],
      ['Empty', new Uint8Array(0)],
    ]);
    const back = readCompound(buildCompoundFile(streams));
    for (const [k, v] of streams) expect(back.get(k), k).toEqual(v);
  });
});
