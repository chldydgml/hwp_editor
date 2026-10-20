import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1100, height: 1000 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => errs.push(m.text()));
p.on('dialog', (d) => { errs.push('dialog: ' + d.message()); d.dismiss(); });
await p.goto('http://localhost:5198/');
await p.waitForSelector('.hwp-body');
for (const [i, f] of process.argv.slice(2).entries()) {
  const t0 = Date.now();
  await p.setInputFiles('#file-input', f);
  await p.waitForFunction(() => !/새 문서|여는 중/.test(document.getElementById('statusbar').textContent), null, { timeout: 30000 }).catch(() => {});
  console.log(f, Date.now() - t0, 'ms', await p.textContent('#statusbar'));
  await p.screenshot({ path: `${process.env.SP}/view${i}.png` });
}
console.log('errors', errs);
await b.close(); await server.close();
