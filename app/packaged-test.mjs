// Test of the BUILT app (release/win-unpacked): browser launch from the package, real listing, cancel + saved state.
//   node packaged-test.mjs <logged-in-profile-dir> <browser>
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [profile, browser = 'chrome'] = process.argv.slice(2);
const userData = mkdtempSync(join(tmpdir(), 'archiwizator-pkg-'));
const out = mkdtempSync(join(tmpdir(), 'archiwizator-pkg-out-'));
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ folder: out }));
const env = { ...process.env, ARCHIWIZATOR_USER_DATA: userData, ARCHIWIZATOR_BROWSERS: browser, ARCHIWIZATOR_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: join('release', 'win-unpacked', 'ChatGPT Archiwizator.exe'), env });
const win = await app.firstWindow();
await win.waitForSelector('#btn-start:not([disabled])');
await win.click('#btn-start');
const t0 = Date.now();
let seen = '';
while (Date.now() - t0 < 180_000) {
  seen = (await win.textContent('#progress-count')) || '';
  const m = /^(\d+) \//.exec(seen);
  if (m && Number(m[1]) >= 2) break;
  if (!(await win.isVisible('#btn-cancel')) && Date.now() - t0 > 5000) break;   // finished/failed early
  await new Promise((r) => setTimeout(r, 500));
}
await win.click('#btn-cancel').catch(() => undefined);
while (await win.isVisible('#btn-cancel')) await new Promise((r) => setTimeout(r, 500));
const status = await win.textContent('#status');
await app.close();
const state = existsSync(join(out, 'ChatGPT', 'state.json')) ? JSON.parse(readFileSync(join(out, 'ChatGPT', 'state.json'), 'utf8')) : null;
const r = { progressSeen: seen, status, saved: state?.done ?? 0, pendingForResume: state?.todo?.length ?? 0 };
console.log(JSON.stringify(r, null, 1));
process.exit(r.saved >= 2 && r.pendingForResume > 0 && /Przerwano/.test(status) ? 0 : 1);
