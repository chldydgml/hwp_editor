import { describe, expect, it } from 'vitest';
import { readHwpx } from '../src/formats/hwpx/reader';
import { writeHwpx } from '../src/formats/hwpx/writer';
import { base64ToBytes, internCharShape, internParaShape } from '../src/model/util';
import { BLANK_HWPX_BASE64 } from '../src/templates/embedded';
import JSZip from 'jszip';

const blank = () => readHwpx(base64ToBytes(BLANK_HWPX_BASE64));

describe('HWPX', () => {
  it('빈 템플릿을 읽는다', async () => {
    const doc = await blank();
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].page.width).toBe(59528);
    expect(doc.sections[0].page.landscape).toBe(false);
    expect(doc.charShapes.length).toBe(7);
    expect(doc.paraShapes.length).toBe(20);
    expect(doc.styles[0].name).toBe('바탕글');
    expect(doc.paraShapes[1].props.marginLeft).toBe(1500);
    expect(doc.sections[0].raw?.hwpxSecPr).toContain('pagePr');
    expect(doc.sections[0].raw?.hwpxColPr).toContain('colPr');
  });

  it('편집한 문서를 저장하고 다시 읽으면 내용과 서식이 유지된다', async () => {
    const doc = await blank();
    const bold = internCharShape(doc, { ...doc.charShapes[0].props, bold: true, size: 1600, faces: ['맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕', '맑은 고딕'] }, 0);
    const center = internParaShape(doc, { ...doc.paraShapes[0].props, align: 'center', lineSpacing: 200 }, 0);
    doc.sections[0].paragraphs = [
      { paraShapeId: center, styleId: 0, runs: [{ kind: 'text', charShapeId: bold, text: '제목 <테스트> & "따옴표"' }] },
      { paraShapeId: 0, styleId: 0, runs: [
        { kind: 'text', charShapeId: 0, text: '일반\t탭' },
        { kind: 'text', charShapeId: bold, text: '굵게\n줄바꿈' },
      ] },
      { paraShapeId: 0, styleId: 0, runs: [] },
    ];
    doc.sections[0].page.landscape = true;
    doc.meta.title = '테스트 문서';

    const bytes = await writeHwpx(doc);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zip.file('mimetype')!.async('string')).toBe('application/hwp+zip');

    const back = await readHwpx(bytes);
    const ps = back.sections[0].paragraphs;
    expect(ps).toHaveLength(3);
    const t0 = ps[0].runs[0];
    expect(t0.kind === 'text' && t0.text).toBe('제목 <테스트> & "따옴표"');
    expect(back.charShapes[t0.charShapeId].props.bold).toBe(true);
    expect(back.charShapes[t0.charShapeId].props.size).toBe(1600);
    expect(back.charShapes[t0.charShapeId].props.faces[0]).toBe('맑은 고딕');
    expect(back.paraShapes[ps[0].paraShapeId].props.align).toBe('center');
    expect(back.paraShapes[ps[0].paraShapeId].props.lineSpacing).toBe(200);
    expect(ps[1].runs.map((r) => (r.kind === 'text' ? r.text : '')).join('|')).toBe('일반\t탭|굵게\n줄바꿈');
    expect(ps[2].runs).toHaveLength(0);
    expect(back.sections[0].page.landscape).toBe(true);
    expect(back.meta.title).toBe('테스트 문서');
    expect(back.paraShapes[1].props.marginLeft).toBe(1500);
  });

  it('알 수 없는 개체는 원본 XML 그대로 보존한다', async () => {
    const doc = await blank();
    const tbl = '<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" id="1" rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl>';
    doc.sections[0].paragraphs[0].runs = [
      { kind: 'text', charShapeId: 0, text: '앞' },
      { kind: 'control', charShapeId: 0, ctrl: { label: '표', hwpx: tbl } },
      { kind: 'text', charShapeId: 0, text: '뒤' },
    ];
    const back = await readHwpx(await writeHwpx(doc));
    const runs = back.sections[0].paragraphs[0].runs;
    expect(runs.map((r) => r.kind)).toEqual(['text', 'control', 'text']);
    const c = runs[1];
    expect(c.kind === 'control' && c.ctrl.label).toBe('표');
    expect(c.kind === 'control' && c.ctrl.preview).toBe('셀');
  });
});
