// Smoke test: start the app, check the window and the bridge, take a screenshot. Does not log in or archive.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shot = process.argv[2] || join(tmpdir(), 'archiwizator.png');
const userData = mkdtempSync(join(tmpdir(), 'archiwizator-smoke-'));
const env = { ...process.env, ARCHIWIZATOR_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;   // set by VS Code terminals; would start Electron as plain Node
const app = await electron.launch({ args: ['.'], env });
const win = await app.firstWindow();
await win.waitForSelector('#btn-start');
const checks = {
  title: await win.title(),
  author: (await win.textContent('footer')).includes('Jakub Lipiński'),
  workspace: await win.textContent('#ws'),
  version: await win.textContent('#ver'),
  startDisabledWithoutFolder: await win.isDisabled('#btn-start'),
  bridge: await win.evaluate(() => Object.keys(window.archiver || {}).sort().join(',')),
  noNode: await win.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'),
  status: await win.textContent('#status'),
};
await win.screenshot({ path: shot });
await app.close();
console.log(JSON.stringify(checks, null, 1));
const ok = checks.author && checks.workspace === 'Santander' && checks.startDisabledWithoutFolder && checks.noNode && checks.bridge.includes('login');
process.exit(ok ? 0 : 1);
