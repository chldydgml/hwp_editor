/**
 * 편집기 컨트롤러.
 *
 * 글자 입력(한글 IME 조합 포함)은 브라우저의 contenteditable 에 맡기고,
 * 문단 나누기/합치기·붙여넣기·서식 변경 같은 구조적 편집은 모델에 적용한 뒤
 * 다시 그립니다. 그래서 DOM 이 브라우저 고유의 마크업으로 어긋나지 않습니다.
 */
import type { CharProps, HwpDocument, ParaProps, Section } from '../model/types';
import { internCharShape } from '../model/util';
import { extractParagraph } from './extract';
import {
  applyCharProps, applyParaProps, charPropsInRange, charShapeAt, cloneSections, comparePos, deleteRange,
  insertText, orderPos, paraLength, splitParagraph, type Pos,
} from './ops';
import { charCss, pageCss, renderParagraph } from './render';
import { domToPos, posToDom } from './selection';

export interface Selection {
  sec: number;
  anchor: Pos;
  focus: Pos;
}

interface Snapshot {
  sections: Section[];
  sel: Selection | null;
}

export type ToggleProp = 'bold' | 'italic' | 'underline' | 'strike' | 'superscript' | 'subscript';

export interface EditorState {
  char: CharProps;
  /** 선택 범위 안에서 값이 섞여 있는 속성 */
  mixed: Set<keyof CharProps>;
  para: ParaProps;
  sec: number;
}

const HISTORY_LIMIT = 200;

export class Editor {
  doc!: HwpDocument;
  private hosts: HTMLElement[] = [];
  private dirty = new Set<number>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private typing = false;
  private typingTimer = 0;
  private composing = false;
  private listeners = new Set<() => void>();

  constructor(private root: HTMLElement) {
    document.addEventListener('selectionchange', () => {
      if (this.currentSelection()) this.emit();
    });
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  // ───────────────────────── 문서 표시 ─────────────────────────

  load(doc: HwpDocument) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.renderAll();
    this.setSelection({ sec: 0, anchor: { para: 0, offset: 0 }, focus: { para: 0, offset: 0 } });
    this.emit();
  }

  private renderAll() {
    this.root.replaceChildren();
    this.hosts = this.doc.sections.map((s, i) => {
      const page = document.createElement('div');
      page.className = 'hwp-page';
      page.style.cssText = pageCss(s.page);
      const host = document.createElement('div');
      host.className = 'hwp-body';
      host.contentEditable = 'true';
      host.spellcheck = false;
      host.dataset.sec = String(i);
      this.attach(host, i);
      page.append(host);
      this.root.append(page);
      return host;
    });
    this.doc.sections.forEach((_, i) => this.renderSection(i));
  }

  private renderSection(i: number) {
    const s = this.doc.sections[i];
    const host = this.hosts[i];
    host.parentElement!.style.cssText = pageCss(s.page);
    host.replaceChildren(...s.paragraphs.map((p) => renderParagraph(this.doc, p)));
    this.dirty.delete(i);
  }

  /** 브라우저가 직접 바꾼 DOM 내용을 모델에 반영합니다. */
  sync() {
    for (const i of this.dirty) {
      const host = this.hosts[i];
      this.normalizeHost(host);
      this.doc.sections[i].paragraphs = Array.from(host.children).map((el) => extractParagraph(this.doc, el as HTMLElement));
      if (this.doc.sections[i].paragraphs.length === 0) this.doc.sections[i].paragraphs.push({ paraShapeId: 0, styleId: 0, runs: [] });
    }
    this.dirty.clear();
  }

  /** host 직속에 문단이 아닌 노드가 생기면 문단으로 감쌉니다. */
  private normalizeHost(host: HTMLElement) {
    let prev: HTMLElement | null = null;
    for (const n of Array.from(host.childNodes)) {
      if (n instanceof HTMLElement && (n.tagName === 'P' || n.tagName === 'DIV')) { prev = n; continue; }
      if (n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? '').trim()) { n.remove(); continue; }
      const p = document.createElement('p');
      p.className = 'hwp-p';
      if (prev) Object.assign(p.dataset, { ps: prev.dataset.ps, style: prev.dataset.style, endcs: prev.dataset.endcs });
      host.insertBefore(p, n);
      p.append(n);
      prev = p;
    }
  }

  // ───────────────────────── 선택 ─────────────────────────

  currentSelection(): Selection | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
    const sec = this.hosts.findIndex((h) => h.contains(sel.anchorNode));
    if (sec < 0 || !this.hosts[sec].contains(sel.focusNode)) return null;
    const anchor = domToPos(this.hosts[sec], sel.anchorNode, sel.anchorOffset);
    const focus = domToPos(this.hosts[sec], sel.focusNode, sel.focusOffset);
    return anchor && focus ? { sec, anchor, focus } : null;
  }

  setSelection(s: Selection) {
    const host = this.hosts[s.sec];
    if (!host) return;
    const [an, ao] = posToDom(host, s.anchor);
    const [fn, fo] = posToDom(host, s.focus);
    const sel = window.getSelection();
    sel?.setBaseAndExtent(an, ao, fn, fo);
    host.focus({ preventScroll: true });
  }

  // ───────────────────────── 편집 실행 / 되돌리기 ─────────────────────────

  private snapshot(): Snapshot {
    return { sections: cloneSections(this.doc.sections), sel: this.currentSelection() };
  }

  private pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** 모델 편집을 실행하고 해당 구역을 다시 그립니다. fn 은 새 선택 위치를 돌려줍니다. */
  exec(fn: (section: Section, start: Pos, end: Pos, sel: Selection) => Pos | [Pos, Pos] | void) {
    this.sync();
    const sel = this.currentSelection();
    if (!sel) return;
    this.endTyping();
    this.pushUndo();
    const [start, end] = orderPos(sel.anchor, sel.focus);
    const result = fn(this.doc.sections[sel.sec], start, end, sel);
    this.renderSection(sel.sec);
    if (Array.isArray(result)) this.setSelection({ sec: sel.sec, anchor: result[0], focus: result[1] });
    else if (result) this.setSelection({ sec: sel.sec, anchor: result, focus: result });
    else this.setSelection(sel);
    this.emit();
  }

  private beginTyping() {
    if (!this.typing) {
      this.sync();
      this.pushUndo();
      this.typing = true;
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = window.setTimeout(() => this.endTyping(), 1000);
  }

  private endTyping() {
    this.typing = false;
    clearTimeout(this.typingTimer);
  }

  private restore(s: Snapshot) {
    this.doc.sections = s.sections;
    this.renderAll();
    if (s.sel) this.setSelection(s.sel);
    this.emit();
  }

  undo() {
    this.sync();
    this.endTyping();
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    this.sync();
    this.endTyping();
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  // ───────────────────────── 서식 명령 ─────────────────────────

  state(): EditorState | null {
    this.sync();
    const sel = this.currentSelection();
    if (!sel) return null;
    const section = this.doc.sections[sel.sec];
    const [start, end] = orderPos(sel.anchor, sel.focus);
    const all = charPropsInRange(this.doc, section, start, end);
    const mixed = new Set<keyof CharProps>();
    for (const k of Object.keys(all[0]) as (keyof CharProps)[]) {
      const v = JSON.stringify(all[0][k]);
      if (all.some((p) => JSON.stringify(p[k]) !== v)) mixed.add(k);
    }
    const para = section.paragraphs[start.para];
    return { char: all[0], mixed, para: this.doc.paraShapes[para.paraShapeId].props, sec: sel.sec };
  }

  /** 글자 속성 변경. 선택이 없으면 다음 입력에 적용됩니다. */
  setChar(mutate: (p: CharProps) => void) {
    this.sync();
    const sel = this.currentSelection();
    if (!sel) return;
    if (comparePos(sel.anchor, sel.focus) === 0) {
      this.pendingFormat(sel, mutate);
      return;
    }
    this.exec((section, start, end) => {
      applyCharProps(this.doc, section, start, end, mutate);
      return [sel.anchor, sel.focus];
    });
  }

  toggle(prop: ToggleProp) {
    const st = this.state();
    if (!st) return;
    const on = !(st.char[prop] && !st.mixed.has(prop));
    this.setChar((p) => {
      p[prop] = on;
      if (on && prop === 'superscript') p.subscript = false;
      if (on && prop === 'subscript') p.superscript = false;
    });
  }

  /** 커서 위치에 서식이 적용된 빈 자리(폭 없는 공백)를 넣어 다음 입력이 그 서식을 따르게 합니다. */
  private pendingFormat(sel: Selection, mutate: (p: CharProps) => void) {
    const section = this.doc.sections[sel.sec];
    const p = section.paragraphs[sel.anchor.para];
    const base = charShapeAt(p, sel.anchor.offset);
    const props = structuredClone(this.doc.charShapes[base].props);
    mutate(props);
    const id = internCharShape(this.doc, props, base);
    const span = document.createElement('span');
    span.dataset.cs = String(id);
    span.style.cssText = charCss(props);
    span.textContent = '​';
    const range = window.getSelection()!.getRangeAt(0);
    // 다른 서식 span 안에 있으면 그 span 을 둘로 나눈 사이에 넣습니다.
    const container = range.startContainer;
    const outer = (container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as HTMLElement))?.closest('[data-cs]');
    if (outer && outer.parentElement?.classList.contains('hwp-p')) {
      const after = document.createRange();
      after.setStart(range.startContainer, range.startOffset);
      after.setEnd(outer, outer.childNodes.length);
      const tail = after.extractContents();
      outer.after(span);
      if (tail.textContent) {
        const clone = outer.cloneNode(false) as HTMLElement;
        clone.append(tail);
        span.after(clone);
      }
    } else range.insertNode(span);
    const s = window.getSelection()!;
    s.setBaseAndExtent(span.firstChild!, 1, span.firstChild!, 1);
    this.dirty.add(sel.sec);
    this.emit();
  }

  setPara(mutate: (p: ParaProps) => void) {
    this.exec((section, start, end, sel) => {
      applyParaProps(this.doc, section, start, end, mutate);
      return [sel.anchor, sel.focus];
    });
  }

  insertText(text: string) {
    this.exec((section, start, end) => insertText(section, deleteRange(section, start, end), text));
  }

  selectAll() {
    const sel = this.currentSelection();
    const sec = sel?.sec ?? 0;
    const paras = this.doc.sections[sec].paragraphs;
    this.sync();
    this.setSelection({ sec, anchor: { para: 0, offset: 0 }, focus: { para: paras.length - 1, offset: paraLength(paras[paras.length - 1]) } });
  }

  // ───────────────────────── 이벤트 ─────────────────────────

  private attach(host: HTMLElement, sec: number) {
    host.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    host.addEventListener('input', () => {
      this.dirty.add(sec);
      this.emit();
    });
    host.addEventListener('compositionstart', () => {
      this.composing = true;
      this.beginTyping();
    });
    host.addEventListener('compositionend', () => {
      this.composing = false;
      this.dirty.add(sec);
    });
    host.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) this.insertText(text.replace(/\r?\n/g, '\r'));
    });
    host.addEventListener('copy', (e) => this.onCopy(e, false));
    host.addEventListener('cut', (e) => this.onCopy(e, true));
    host.addEventListener('drop', (e) => e.preventDefault());
    host.addEventListener('dragstart', (e) => e.preventDefault());
    host.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    this.sync();
    const sel = this.currentSelection();
    if (!sel || comparePos(sel.anchor, sel.focus) === 0) return;
    e.preventDefault();
    const [start, end] = orderPos(sel.anchor, sel.focus);
    const lines: string[] = [];
    const paras = this.doc.sections[sel.sec].paragraphs;
    for (let i = start.para; i <= end.para; i++) {
      const p = paras[i];
      let pos = 0;
      let line = '';
      const from = i === start.para ? start.offset : 0;
      const to = i === end.para ? end.offset : Infinity;
      for (const r of p.runs) {
        const t = r.kind === 'text' ? r.text : '￼';
        for (const ch of t) {
          if (pos >= from && pos < to && ch !== '￼') line += ch;
          pos += ch.length;
        }
      }
      lines.push(line);
    }
    e.clipboardData?.setData('text/plain', lines.join('\r\n'));
    if (cut) this.exec((section, s, en) => deleteRange(section, s, en));
  }

  private onBeforeInput(e: InputEvent) {
    if (e.isComposing || this.composing) return;
    const t = e.inputType;
    const sel = this.currentSelection();
    if (!sel) return;
    const collapsed = comparePos(sel.anchor, sel.focus) === 0;
    const [start, end] = orderPos(sel.anchor, sel.focus);
    const multi = start.para !== end.para;
    const section = this.doc.sections[sel.sec];

    const take = (fn: Parameters<Editor['exec']>[0]) => {
      e.preventDefault();
      this.exec(fn);
    };

    switch (t) {
      case 'insertParagraph':
        return take((s, a, b) => splitParagraph(s, deleteRange(s, a, b)));
      case 'insertLineBreak':
        return take((s, a, b) => insertText(s, deleteRange(s, a, b), '\n'));
      case 'historyUndo': e.preventDefault(); return this.undo();
      case 'historyRedo': e.preventDefault(); return this.redo();
      case 'formatBold': e.preventDefault(); return this.toggle('bold');
      case 'formatItalic': e.preventDefault(); return this.toggle('italic');
      case 'formatUnderline': e.preventDefault(); return this.toggle('underline');
      case 'formatStrikeThrough': e.preventDefault(); return this.toggle('strike');
      case 'insertFromPaste': case 'insertFromDrop': case 'insertFromYank': case 'deleteByDrag': case 'deleteByCut':
        e.preventDefault();
        return;
    }
    if (t.startsWith('format')) { e.preventDefault(); return; }
    if (t.startsWith('delete')) {
      if (!collapsed) {
        if (multi || this.selectionHasObject()) return take((s, a, b) => deleteRange(s, a, b));
      } else if (t.endsWith('Backward') && start.offset === 0) {
        if (start.para === 0) { e.preventDefault(); return; }
        const prevLen = paraLength(section.paragraphs[start.para - 1]);
        return take((s) => deleteRange(s, { para: start.para - 1, offset: prevLen }, start));
      } else if (t.endsWith('Forward') && start.offset === paraLength(this.syncedPara(sel.sec, start.para))) {
        if (start.para >= section.paragraphs.length - 1) { e.preventDefault(); return; }
        return take((s) => deleteRange(s, start, { para: start.para + 1, offset: 0 }));
      }
      this.beginTyping();
      return;
    }
    if (t === 'insertText' || t === 'insertReplacementText') {
      if (!collapsed && (multi || this.selectionHasObject())) {
        const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        return take((s, a, b) => insertText(s, deleteRange(s, a, b), data));
      }
      this.beginTyping();
    }
  }

  private syncedPara(sec: number, para: number) {
    if (this.dirty.has(sec)) this.sync();
    return this.doc.sections[sec].paragraphs[para];
  }

  private selectionHasObject(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const frag = sel.getRangeAt(0).cloneContents();
    return !!frag.querySelector?.('.hwp-obj');
  }

  private onKeyDown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      this.insertText('\t');
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    const map: Record<string, () => void> = {
      b: () => this.toggle('bold'),
      i: () => this.toggle('italic'),
      u: () => this.toggle('underline'),
      z: () => (e.shiftKey ? this.redo() : this.undo()),
      y: () => this.redo(),
      a: () => this.selectAll(),
    };
    const fn = map[k];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }
}
