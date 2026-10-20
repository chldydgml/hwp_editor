/**
 * 문서 모델 편집 연산 (DOM 과 무관한 순수 함수).
 * 문단 안 위치(offset)는 텍스트의 UTF-16 코드 단위 수이며, 개체(컨트롤)는 1로 셉니다.
 */
import type { CharProps, HwpDocument, ParaProps, Paragraph, Run, Section } from '../model/types';
import { internCharShape, internParaShape, mergeRuns } from '../model/util';

export interface Pos {
  para: number;
  offset: number;
}

export const runLength = (r: Run) => (r.kind === 'text' ? r.text.length : 1);
export const paraLength = (p: Paragraph) => p.runs.reduce((n, r) => n + runLength(r), 0);

export const comparePos = (a: Pos, b: Pos) => (a.para - b.para) || (a.offset - b.offset);
export const orderPos = (a: Pos, b: Pos): [Pos, Pos] => (comparePos(a, b) <= 0 ? [a, b] : [b, a]);

/** runs 를 [0, offset) 과 [offset, 끝) 으로 나눕니다. */
export function splitRuns(runs: Run[], offset: number): [Run[], Run[]] {
  const left: Run[] = [];
  const right: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const len = runLength(r);
    if (pos + len <= offset) left.push(r);
    else if (pos >= offset) right.push(r);
    else if (r.kind === 'text') {
      const cut = offset - pos;
      left.push({ ...r, text: r.text.slice(0, cut) });
      right.push({ ...r, text: r.text.slice(cut) });
    }
    pos += len;
  }
  return [left, right];
}

export function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  return splitRuns(splitRuns(runs, to)[0], from)[1];
}

/** offset 위치에서 입력될 글자가 가질 글자 모양 (앞 글자 기준) */
export function charShapeAt(p: Paragraph, offset: number): number {
  let pos = 0;
  let last = p.runs[0]?.charShapeId ?? p.endCharShapeId ?? 0;
  for (const r of p.runs) {
    if (pos >= offset) break;
    last = r.charShapeId;
    pos += runLength(r);
  }
  return last;
}

const cloneParagraph = (p: Paragraph, runs: Run[]): Paragraph => ({
  paraShapeId: p.paraShapeId,
  styleId: p.styleId,
  runs: mergeRuns(runs),
  endCharShapeId: p.endCharShapeId,
});

/** 선택 범위를 지우고 커서 위치를 돌려줍니다. */
export function deleteRange(section: Section, a: Pos, b: Pos): Pos {
  const [start, end] = orderPos(a, b);
  const sp = section.paragraphs[start.para];
  const ep = section.paragraphs[end.para];
  const left = splitRuns(sp.runs, start.offset)[0];
  const right = splitRuns(ep.runs, end.offset)[1];
  const merged = { ...cloneParagraph(sp, [...left, ...right]), pageBreak: sp.pageBreak, columnBreak: sp.columnBreak };
  if (merged.runs.length === 0) merged.endCharShapeId = charShapeAt(sp, start.offset);
  section.paragraphs.splice(start.para, end.para - start.para + 1, merged);
  return { ...start };
}

/** 문단을 나눕니다 (Enter). 새 커서 위치를 돌려줍니다. */
export function splitParagraph(section: Section, pos: Pos): Pos {
  const p = section.paragraphs[pos.para];
  const cs = charShapeAt(p, pos.offset);
  const [left, right] = splitRuns(p.runs, pos.offset);
  const a: Paragraph = { ...cloneParagraph(p, left), pageBreak: p.pageBreak, columnBreak: p.columnBreak, endCharShapeId: cs };
  const b: Paragraph = { ...cloneParagraph(p, right), endCharShapeId: right[0]?.charShapeId ?? cs };
  section.paragraphs.splice(pos.para, 1, a, b);
  return { para: pos.para + 1, offset: 0 };
}

/** 텍스트를 삽입합니다. '\n' 은 강제 줄바꿈, '\r' 또는 '\r\n' 은 문단 나누기로 처리합니다. */
export function insertText(section: Section, pos: Pos, text: string, charShapeId?: number): Pos {
  const lines = text.replace(/\r\n?/g, '\r').split('\r');
  let cur = pos;
  lines.forEach((line, i) => {
    if (i > 0) cur = splitParagraph(section, cur);
    if (!line) return;
    const p = section.paragraphs[cur.para];
    const cs = charShapeId ?? charShapeAt(p, cur.offset);
    const [left, right] = splitRuns(p.runs, cur.offset);
    p.runs = mergeRuns([...left, { kind: 'text', charShapeId: cs, text: line }, ...right]);
    cur = { para: cur.para, offset: cur.offset + line.length };
  });
  return cur;
}

/** 범위 안 글자들의 글자 모양을 바꿉니다. */
export function applyCharProps(doc: HwpDocument, section: Section, a: Pos, b: Pos, mutate: (p: CharProps) => void): void {
  const [start, end] = orderPos(a, b);
  for (let i = start.para; i <= end.para; i++) {
    const p = section.paragraphs[i];
    const from = i === start.para ? start.offset : 0;
    const to = i === end.para ? end.offset : paraLength(p);
    const [head, rest] = splitRuns(p.runs, from);
    const [mid, tail] = splitRuns(rest, to - from);
    const changed = mid.map((r) => {
      const props = structuredClone(doc.charShapes[r.charShapeId]?.props ?? doc.charShapes[0].props);
      mutate(props);
      return { ...r, charShapeId: internCharShape(doc, props, r.charShapeId) };
    });
    p.runs = mergeRuns([...head, ...changed, ...tail]);
    if (p.runs.length === 0) {
      // 빈 문단은 문단 끝 글자 모양을 바꿔 이후 입력에 적용되게 합니다.
      const props = structuredClone(doc.charShapes[p.endCharShapeId ?? 0]?.props ?? doc.charShapes[0].props);
      mutate(props);
      p.endCharShapeId = internCharShape(doc, props, p.endCharShapeId ?? 0);
    }
  }
}

/** 범위가 걸친 문단들의 문단 모양을 바꿉니다. */
export function applyParaProps(doc: HwpDocument, section: Section, a: Pos, b: Pos, mutate: (p: ParaProps) => void): void {
  const [start, end] = orderPos(a, b);
  for (let i = start.para; i <= end.para; i++) {
    const p = section.paragraphs[i];
    const props = structuredClone(doc.paraShapes[p.paraShapeId]?.props ?? doc.paraShapes[0].props);
    mutate(props);
    p.paraShapeId = internParaShape(doc, props, p.paraShapeId);
  }
}

/** 범위 안 글자들의 글자 속성 목록 (툴바 상태 판단용) */
export function charPropsInRange(doc: HwpDocument, section: Section, a: Pos, b: Pos): CharProps[] {
  const [start, end] = orderPos(a, b);
  if (comparePos(start, end) === 0) {
    const p = section.paragraphs[start.para];
    return [doc.charShapes[charShapeAt(p, start.offset)].props];
  }
  const out: CharProps[] = [];
  for (let i = start.para; i <= end.para; i++) {
    const p = section.paragraphs[i];
    const from = i === start.para ? start.offset : 0;
    const to = i === end.para ? end.offset : paraLength(p);
    for (const r of sliceRuns(p.runs, from, to)) out.push(doc.charShapes[r.charShapeId].props);
  }
  return out.length ? out : [doc.charShapes[0].props];
}

/** 히스토리용 복제 (개체 원본 데이터는 공유) */
export const cloneSections = (sections: Section[]): Section[] =>
  sections.map((s) => ({
    page: { ...s.page },
    raw: s.raw,
    paragraphs: s.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r })) })),
  }));
