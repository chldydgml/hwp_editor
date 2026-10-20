/** 서식 도구 모음 ↔ 편집기 연결 */
import type { Align } from '../model/types';
import { perLang } from '../model/util';
import type { Editor, ToggleProp } from '../editor/editor';

const FONTS = ['함초롬바탕', '함초롬돋움', '맑은 고딕', '바탕', '돋움', '굴림', '궁서', '나눔고딕', '나눔명조', 'Times New Roman', 'Arial'];
const SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 60, 72];
const LINE_SPACINGS = [100, 130, 150, 160, 180, 200, 250, 300];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fillSelect(sel: HTMLSelectElement, values: (string | number)[], label = (v: string | number) => String(v)) {
  sel.replaceChildren(...values.map((v) => new Option(label(v), String(v))));
}

/** 목록에 없는 값이면 임시 항목을 추가해 선택합니다. */
function selectValue(sel: HTMLSelectElement, value: string, mixed: boolean) {
  if (mixed) { sel.value = ''; return; }
  if (!Array.from(sel.options).some((o) => o.value === value)) sel.add(new Option(value, value));
  sel.value = value;
}

export function bindToolbar(editor: Editor) {
  const fontSel = $<HTMLSelectElement>('font-family');
  const sizeSel = $<HTMLSelectElement>('font-size');
  const lsSel = $<HTMLSelectElement>('line-spacing');
  const color = $<HTMLInputElement>('text-color');
  fillSelect(fontSel, FONTS);
  fillSelect(sizeSel, SIZES);
  fillSelect(lsSel, LINE_SPACINGS, (v) => `${v}%`);

  // 버튼을 눌러도 편집 영역의 선택이 풀리지 않도록
  $('toolbar').addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });

  const toggles: Record<string, ToggleProp> = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike' };
  const aligns: Record<string, Align> = { 'align-justify': 'justify', 'align-left': 'left', 'align-center': 'center', 'align-right': 'right' };
  $('toolbar').addEventListener('click', (e) => {
    const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (!cmd) return;
    if (cmd === 'undo') editor.undo();
    else if (cmd === 'redo') editor.redo();
    else if (toggles[cmd]) editor.toggle(toggles[cmd]);
    else if (aligns[cmd]) editor.setPara((p) => { p.align = aligns[cmd]; });
  });

  fontSel.addEventListener('change', () => {
    const face = fontSel.value;
    editor.setChar((p) => { p.faces = perLang(face); });
  });
  sizeSel.addEventListener('change', () => {
    const size = Math.round(parseFloat(sizeSel.value) * 100);
    editor.setChar((p) => { p.size = size; });
  });
  color.addEventListener('input', () => {
    const c = color.value.toUpperCase();
    editor.setChar((p) => { p.color = c; });
  });
  lsSel.addEventListener('change', () => {
    const v = parseInt(lsSel.value, 10);
    editor.setPara((p) => { p.lineSpacingType = 'percent'; p.lineSpacing = v; });
  });

  const update = () => {
    const st = editor.state();
    if (!st) return;
    const active = (cmd: string, on: boolean) =>
      document.querySelector(`#toolbar [data-cmd="${cmd}"]`)?.classList.toggle('active', on);
    for (const [cmd, prop] of Object.entries(toggles)) active(cmd, st.char[prop] && !st.mixed.has(prop));
    for (const [cmd, a] of Object.entries(aligns)) active(cmd, st.para.align === a);
    selectValue(fontSel, st.char.faces[0], st.mixed.has('faces'));
    selectValue(sizeSel, String(st.char.size / 100), st.mixed.has('size'));
    if (st.para.lineSpacingType === 'percent') selectValue(lsSel, String(st.para.lineSpacing), false);
    else lsSel.value = '';
    if (document.activeElement !== color) color.value = st.char.color.toLowerCase();
  };
  editor.onChange(update);
}
