import { describe, expect, it } from 'vitest';
import { applyCharProps, deleteRange, insertText, splitParagraph, splitRuns } from '../src/editor/ops';
import type { HwpDocument, Section } from '../src/model/types';
import { defaultCharProps, defaultPage, defaultParaProps } from '../src/model/util';

const mkDoc = (): HwpDocument => ({
  meta: { title: '', creator: '', subject: '', description: '', keywords: '' },
  charShapes: [{ props: defaultCharProps() }, { props: { ...defaultCharProps(), bold: true } }],
  paraShapes: [{ props: defaultParaProps() }],
  styles: [],
  sections: [],
  source: { format: 'new' },
});
const mkSection = (...texts: string[]): Section => ({
  page: defaultPage(),
  paragraphs: texts.map((t) => ({ paraShapeId: 0, styleId: 0, runs: t ? [{ kind: 'text', charShapeId: 0, text: t }] : [] })),
});
const texts = (s: Section) => s.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'text' ? r.text : '#')).join(''));

describe('편집 연산', () => {
  it('splitRuns 는 개체를 1글자로 센다', () => {
    const [l, r] = splitRuns([
      { kind: 'text', charShapeId: 0, text: 'ab' },
      { kind: 'control', charShapeId: 0, ctrl: { label: '표' } },
      { kind: 'text', charShapeId: 1, text: 'cd' },
    ], 3);
    expect(l.map((x) => x.kind)).toEqual(['text', 'control']);
    expect(r).toEqual([{ kind: 'text', charShapeId: 1, text: 'cd' }]);
  });

  it('문단 나누기와 여러 문단 삭제', () => {
    const s = mkSection('가나다라', '마바사', '아자차');
    expect(splitParagraph(s, { para: 0, offset: 2 })).toEqual({ para: 1, offset: 0 });
    expect(texts(s)).toEqual(['가나', '다라', '마바사', '아자차']);
    expect(deleteRange(s, { para: 3, offset: 1 }, { para: 1, offset: 1 })).toEqual({ para: 1, offset: 1 });
    expect(texts(s)).toEqual(['가나', '다자차']);
  });

  it('여러 줄 텍스트 삽입은 문단을 만든다', () => {
    const s = mkSection('처음끝');
    const end = insertText(s, { para: 0, offset: 2 }, '하나\r둘\n셋');
    expect(texts(s)).toEqual(['처음하나', '둘\n셋끝']);
    expect(end).toEqual({ para: 1, offset: 3 });
  });

  it('범위 서식 적용은 런을 나누고 모양을 공유한다', () => {
    const doc = mkDoc();
    const s = mkSection('abcdef', 'ghi');
    applyCharProps(doc, s, { para: 0, offset: 2 }, { para: 1, offset: 1 }, (p) => { p.bold = true; });
    expect(s.paragraphs[0].runs).toEqual([
      { kind: 'text', charShapeId: 0, text: 'ab' },
      { kind: 'text', charShapeId: 1, text: 'cdef' },
    ]);
    expect(s.paragraphs[1].runs[0]).toEqual({ kind: 'text', charShapeId: 1, text: 'g' });
    expect(doc.charShapes).toHaveLength(2); // 기존 굵은 모양 재사용
  });
});
