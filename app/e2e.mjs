// End-to-end test on a real account (developer machine only): copies an already logged-in browser profile,
// presets the output folder, clicks "Rozpocznij archiwizację" and checks the archive. Usage:
//   node e2e.mjs <logged-in-profile-dir> <browser: chrome|msedge> <screenshot-dir>
import { _electron as electron } from 'playwright-core';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [profile, browser = 'chrome', shots = tmpdir()] = process.argv.slice(2);
const userData = mkdtempSync(join(tmpdir(), 'archiwizator-e2e-'));
const out = mkdtempSync(join(tmpdir(), 'archiwizator-out-'));
// copy file by file; Chrome protects some helper files (EPERM) that the session does not need
const skip = /Singleton|lockfile|[\\/]Cache[\\/]|Code Cache|GPUCache|Account Web Data/;
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (skip.test(s)) continue;
    if (e.isDirectory()) copyTree(s, d);
    else { try { cpSync(s, d); } catch { /* protected helper file */ } }
  }
};
// use the logged-in profile in place (a copy loses the session: cookies are bound to the original profile)
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ folder: out }));

const env = { ...process.env, ARCHIWIZATOR_USER_DATA: userData, ARCHIWIZATOR_BROWSERS: browser, ARCHIWIZATOR_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], env });
const win = await app.firstWindow();
await win.waitForSelector('#btn-start:not([disabled])');
await win.click('#btn-start');
let mid = false;
const t0 = Date.now();
while (Date.now() - t0 < 15 * 60_000) {
  if (await win.isVisible('#result')) break;
  // the run is over when the start button is usable again
  if (Date.now() - t0 > 3000 && !(await win.isDisabled('#btn-start')) && !(await win.isVisible('#btn-cancel'))) break;
  if (!mid && /(\d+) \/ (\d+)/.test((await win.textContent('#progress-count')) || '')) {
    const [, d] = /(\d+) \//.exec(await win.textContent('#progress-count'));
    if (Number(d) >= 3) { await win.screenshot({ path: join(shots, 'app-progress.png') }); mid = true; }
  }
  if ((Date.now() - t0) % 10_000 < 1000) console.error(`[${Math.round((Date.now() - t0) / 1000)}s] cancel=${await win.isVisible('#btn-cancel')} ${await win.textContent('#progress-count')} | ${(await win.textContent('#status')).slice(0, 90)}`);
  await new Promise((r) => setTimeout(r, 1000));
}
await win.screenshot({ path: join(shots, 'app-done.png') });
const result = { status: await win.textContent('#status'), result: (await win.isVisible('#result')) ? await win.textContent('#result-text') : null };
await app.close();
const idx = join(out, 'ChatGPT', 'index.json');
result.archived = existsSync(idx) ? Object.keys(JSON.parse(readFileSync(idx, 'utf8'))).length : 0;
result.workspace = existsSync(join(out, 'ChatGPT', 'workspace.json')) ? JSON.parse(readFileSync(join(out, 'ChatGPT', 'workspace.json'), 'utf8')).name : null;
result.indexMd = existsSync(join(out, 'ChatGPT', 'INDEX.md'));
result.out = out;
console.log(JSON.stringify(result, null, 1));
process.exit(result.archived > 0 && result.workspace === 'Santander' ? 0 : 1);
