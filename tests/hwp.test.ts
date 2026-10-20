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
