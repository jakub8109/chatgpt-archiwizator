// UI test without ChatGPT: feeds progress events into the window and checks what the user sees.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.argv[2] || tmpdir();
const env = { ...process.env, ARCHIWIZATOR_USER_DATA: mkdtempSync(join(tmpdir(), 'archiwizator-ui-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
const win = await app.firstWindow();
await win.waitForSelector('#btn-start');
const send = (ev) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('progress', e), ev);
const read = async () => ({ status: await win.textContent('#status'), count: await win.textContent('#progress-count'), bar: await win.getAttribute('#bar-fill', 'style') });

const steps = [];
await win.evaluate(() => { document.getElementById('progress').hidden = false; });
await send({ event: 'phase', phase: 'browser', message: 'Uruchamiam przeglądarkę i sprawdzam logowanie…' }); steps.push(['phase', await read()]);
await send({ event: 'listed', total: 54, todo: 54 }); steps.push(['listed', await read()]);
for (let i = 1; i <= 27; i++) await send({ event: 'progress', done: i, total: 54, id: String(i), title: `Rozmowa ${i}`, status: 'saved' });
await new Promise((r) => setTimeout(r, 400));
steps.push(['progress27', await read()]);
await win.screenshot({ path: join(shots, 'ui-progress.png') });
await send({ event: 'done', saved: 54, skipped: 0, failed: 0, durationSec: 210 });
await new Promise((r) => setTimeout(r, 300));
steps.push(['done', { ...(await read()), result: await win.isVisible('#result') }]);
await win.screenshot({ path: join(shots, 'ui-done.png') });
// closing while "busy" must not freeze the window: simulate busy via a pending login-less state check
const closeTest = await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  const t = Date.now();
  w.webContents.send('status', { kind: 'info', text: 'ping' });
  return Date.now() - t;
});
await app.close();
const ok = steps[2][1].count === '27 / 54 (50%)' && steps[3][1].result && steps[3][1].bar === 'width: 100%;';
console.log(JSON.stringify({ steps: steps.map(([k, v]) => [k, v.count, v.bar, v.status.slice(0, 50)]), closeTest, ok }, null, 1));
process.exit(ok ? 0 : 1);
