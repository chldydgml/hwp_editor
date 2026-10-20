import './styles.css';
import { Editor } from './editor/editor';
import { detectFormat, download, newDocument, openDocument, saveDocument, type FileFormat } from './io/files';
import { plainText } from './model/util';
import { bindToolbar } from './ui/toolbar';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('statusbar');
const filenameEl = $('filename');
const fileInput = $<HTMLInputElement>('file-input');

const editor = new Editor($('workspace'));
bindToolbar(editor);

let baseName = '새 문서';
let sourceFormat: FileFormat | null = null;

function setStatus(msg: string) {
  status.textContent = msg;
}

function updateInfo() {
  const d = editor.doc;
  if (!d) return;
  const chars = plainText(d).replace(/\r\n/g, '').length;
  const fmt = sourceFormat ? sourceFormat.toUpperCase() : '새 문서';
  const paras = d.sections.reduce((n, s) => n + s.paragraphs.length, 0);
  setStatus(`${fmt} · 구역 ${d.sections.length} · 문단 ${paras} · 글자 ${chars}`);
}
editor.onChange(updateInfo);

async function createNew() {
  editor.load(await newDocument());
  baseName = '새 문서';
  sourceFormat = null;
  filenameEl.textContent = baseName;
  updateInfo();
}

async function openFile(file: File) {
  try {
    setStatus(`${file.name} 여는 중…`);
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await openDocument(data);
    editor.load(doc);
    baseName = file.name.replace(/\.(hwpx?|HWPX?)$/, '');
    sourceFormat = detectFormat(data);
    filenameEl.textContent = file.name;
    updateInfo();
  } catch (err) {
    console.error(err);
    setStatus('열기 실패');
    alert(`파일을 열 수 없습니다.\n${(err as Error).message}`);
  }
}

async function save(format: FileFormat) {
  try {
    editor.sync();
    setStatus('저장 중…');
    const bytes = await saveDocument(editor.doc, format);
    const name = `${baseName}.${format}`;
    download(bytes, name);
    filenameEl.textContent = name;
    updateInfo();
  } catch (err) {
    console.error(err);
    setStatus('저장 실패');
    alert(`저장하지 못했습니다.\n${(err as Error).message}`);
  }
}

const commands: Record<string, () => void> = {
  new: () => void createNew(),
  open: () => fileInput.click(),
  'save-hwpx': () => void save('hwpx'),
  'save-hwp': () => void save('hwp'),
};

document.querySelector('.menubar')!.addEventListener('click', (e) => {
  const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
  if (cmd && commands[cmd]) commands[cmd]();
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = '';
});

// 파일 끌어다 놓기
const workspace = $('workspace');
workspace.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); workspace.classList.add('dragging'); }
});
workspace.addEventListener('dragleave', () => workspace.classList.remove('dragging'));
workspace.addEventListener('drop', (e) => {
  workspace.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) { e.preventDefault(); void openFile(f); }
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); void save(e.shiftKey ? 'hwp' : 'hwpx'); }
  else if (k === 'o') { e.preventDefault(); fileInput.click(); }
});
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void createNew(); }
});

void createNew();

// 테스트·디버깅용
(window as unknown as { hwpEditor: Editor }).hwpEditor = editor;
