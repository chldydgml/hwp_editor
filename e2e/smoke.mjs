// 실제 브라우저(Chromium)에서 편집기를 조작해 열기·편집·저장 흐름을 확인합니다.
// 사용법: npm run e2e [-- 출력 폴더]
import { chromium } from 'playwright';
import { preview } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? 'e2e-out');
// 개발 서버는 첫 실행 때 의존성 최적화로 페이지를 다시 읽으므로 빌드 결과(preview)로 시험합니다.
const server = await preview({ preview: { port: 5199 }, logLevel: 'error' });
// CHROMIUM_PATH 로 브라우저 실행 파일을 지정할 수 있습니다.
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

const check = (cond, msg) => {
  if (!cond) { console.error('✗', msg); process.exitCode = 1; } else console.log('✓', msg);
};
const model = () => page.evaluate(() => {
  const ed = window.hwpEditor;
  ed.sync();
  return ed.doc.sections[0].paragraphs.map((p) => ({
    text: p.runs.map((r) => (r.kind === 'text' ? r.text : `[${r.ctrl.label}]`)).join(''),
    runs: p.runs.map((r) => ({ t: r.kind === 'text' ? r.text : '', ...ed.doc.charShapes[r.charShapeId].props })),
    para: ed.doc.paraShapes[p.paraShapeId].props,
  }));
});

try {
  await page.goto('http://localhost:5199/');
  await page.waitForSelector('.hwp-body');
  await page.click('.hwp-body');

  await page.keyboard.insertText('안녕하세요 한글 편집기');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('둘째 문단');
  let m = await model();
  check(m.length === 2 && m[0].text === '안녕하세요 한글 편집기' && m[1].text === '둘째 문단', 'Enter 로 문단 나누기');

  // 첫 문단의 '한글' 선택 후 굵게
  await page.evaluate(() => {
    const ed = window.hwpEditor;
    ed.setSelection({ sec: 0, anchor: { para: 0, offset: 6 }, focus: { para: 0, offset: 8 } });
  });
  await page.keyboard.press('Control+b');
  m = await model();
  const boldRun = m[0].runs.find((r) => r.t === '한글');
  check(boldRun?.bold === true && m[0].runs.filter((r) => r.bold).length === 1, 'Ctrl+B 로 선택 영역 굵게');

  // 툴바: 가운데 정렬 + 글자 크기
  await page.click('[data-cmd="align-center"]');
  await page.selectOption('#font-size', '20');
  m = await model();
  check(m[0].para.align === 'center', '가운데 정렬');
  check(m[0].runs.find((r) => r.t === '한글')?.size === 2000, '글자 크기 20pt');

  // 둘째 문단 처음에서 Backspace → 문단 합치기
  await page.evaluate(() => window.hwpEditor.setSelection({ sec: 0, anchor: { para: 1, offset: 0 }, focus: { para: 1, offset: 0 } }));
  await page.keyboard.press('Backspace');
  m = await model();
  check(m.length === 1 && m[0].text === '안녕하세요 한글 편집기둘째 문단', 'Backspace 로 문단 합치기');

  // 되돌리기
  await page.keyboard.press('Control+z');
  m = await model();
  check(m.length === 2, 'Ctrl+Z 되돌리기');

  // 접은 커서에서 굵게 켜고 입력
  await page.evaluate(() => window.hwpEditor.setSelection({ sec: 0, anchor: { para: 1, offset: 5 }, focus: { para: 1, offset: 5 } }));
  await page.keyboard.press('Control+b');
  await page.keyboard.insertText('굵은글');
  m = await model();
  check(m[1].text === '둘째 문단굵은글' && m[1].runs.find((r) => r.t === '굵은글')?.bold === true, '커서 위치 서식 후 입력');

  // Shift+Enter 줄바꿈, Tab
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('끝');
  m = await model();
  check(m[1].text === '둘째 문단굵은글\n\t끝', '강제 줄바꿈과 탭');

  // 저장 (HWPX, HWP)
  for (const [cmd, ext] of [['save-hwpx', 'hwpx'], ['save-hwp', 'hwp']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-cmd="${cmd}"]`)]);
    const path = `${outDir}/e2e.${ext}`;
    await dl.saveAs(path);
    // headless Chromium 은 비ASCII 다운로드 이름을 'download' 로 바꾸므로 내용(서명)으로 확인합니다.
    const head = readFileSync(path).subarray(0, 4).toString('hex');
    check(head === (ext === 'hwpx' ? '504b0304' : 'd0cf11e0'), `${ext.toUpperCase()} 저장 (${dl.suggestedFilename()})`);
  }

  // 저장한 파일 다시 열기
  for (const ext of ['hwpx', 'hwp']) {
    await page.setInputFiles('#file-input', `${outDir}/e2e.${ext}`);
    await page.waitForFunction((n) => document.getElementById('filename').textContent === n, `e2e.${ext}`);
    m = await model();
    check(m.length === 2 && m[0].text === '안녕하세요 한글 편집기' && m[0].para.align === 'center'
      && m[0].runs.find((r) => r.t === '한글')?.bold === true && m[1].text === '둘째 문단굵은글\n\t끝', `${ext.toUpperCase()} 다시 열기`);
  }
  await page.screenshot({ path: `${outDir}/screenshot.png`, fullPage: false });
  check(errors.length === 0, `브라우저 오류 없음 ${errors.join(' | ')}`);
} finally {
  await browser.close();
  await server.close();
}
