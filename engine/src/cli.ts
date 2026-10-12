#!/usr/bin/env node
/**
 * JARVIS plugin entry point (see plugin.json). Jarvis runs the actions; the CLI exists for that and for debugging.
 *
 *   login [--export <file>]    open a browser window; log in to ChatGPT yourself (session kept in the profile dir;
 *                              --export also writes the session cookies to a file for a headless Jarvis server)
 *   session-import <file>      load a session exported by `login --export` (server side)
 *   sync [--full] [--limit N]  import new/changed conversations (resumes an interrupted run)
 *   import-export <zip|dir>    import the official ChatGPT data export
 *   rebuild-html               re-create the HTML view (index.html, galeria.html, pages) from the saved archive
 *   status                     what is stored, last run, pending work
 *
 * Environment:
 *   JARVIS_KNOWLEDGE_ROOT   folder that contains Knowledge/ (default: ./Knowledge)
 *   CHATGPT_PROFILE_DIR     browser profile with the ChatGPT session (default: ~/.jarvis/chatgpt-profile)
 *   CHATGPT_HEADLESS        1 = headless (blocked by Cloudflare on chatgpt.com; tests only). Default: normal window
 *   CHATGPT_MINIMIZED       0 = show the window during sync (default: started minimized)
 *   CHATGPT_DELAY_MS        pause between conversations (default 1500)
 *
 * Progress: one JSON object per line on stdout (ProgressEvent). Exit codes: 0 ok · 1 error · 2 done with failures · 3 login required · 4 browser blocked by Cloudflare.
 */
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatGPTClient } from './chatgpt.js';
import { importExport, rebuildHtml, syncLive } from './importer.js';
import { Store } from './store.js';

const env = process.env;
const knowledgeRoot = resolve(env.JARVIS_KNOWLEDGE_ROOT || 'Knowledge');
const profileDir = resolve(env.CHATGPT_PROFILE_DIR || join(homedir(), '.jarvis', 'chatgpt-profile'));
// ChatGPT's Cloudflare blocks headless Chrome, so the default is a normal (minimized) window
const headless = env.CHATGPT_HEADLESS === '1';
const minimized = env.CHATGPT_MINIMIZED !== '0';
const delayMs = Math.max(300, Number(env.CHATGPT_DELAY_MS) || 1500);
const workspace = env.CHATGPT_WORKSPACE?.trim() || undefined;   // e.g. Santander: only that workspace, refuse others

const out = (o: object) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'login': {
      const c = new ChatGPTClient({ profileDir, headless: false, delayMs });
      await c.open();
      out({ event: 'login_window', message: 'Zaloguj się do ChatGPT w otwartym oknie. Okno zamknie się samo po zalogowaniu.' });
      const ok = await c.waitForLogin();
      const ei = rest.indexOf('--export');
      if (ok && ei >= 0) {
        const file = resolve(rest[ei + 1] || 'chatgpt-session.json');
        await c.exportSession(file);
        out({ event: 'session_exported', file, message: 'Wgraj ten plik do Jarvisa (akcja session_import), potem go usuń — zawiera sesję ChatGPT.' });
      }
      await c.close();
      out({ event: ok ? 'logged_in' : 'login_timeout' });
      return ok ? 0 : 3;
    }
    case 'session-import': {
      const p = rest[0];
      if (!p) { out({ event: 'error', message: 'podaj plik sesji z login --export' }); return 1; }
      const c = new ChatGPTClient({ profileDir, headless, minimized, delayMs });
      await c.open();
      // the file holds live session cookies: it is removed after reading, whatever the outcome
      const ok = await c.importSession(resolve(p)).finally(() => { rmSync(resolve(p), { force: true }); return c.close(); });
      out({ event: ok ? 'logged_in' : 'login_required', message: ok ? 'Sesja wczytana — można importować.' : 'Sesja z pliku nie działa (wygasła?) — zaloguj się ponownie.' });
      return ok ? 0 : 3;
    }
    case 'sync': {
      const li = rest.indexOf('--limit');
      return syncLive({
        knowledgeRoot, profileDir, headless, minimized, delayMs, workspace,
        full: rest.includes('--full'),
        limit: li >= 0 ? Number(rest[li + 1]) || undefined : undefined,
      });
    }
    case 'import-export': {
      const p = rest[0];
      if (!p) { out({ event: 'error', message: 'podaj ścieżkę do pliku ZIP z eksportu ChatGPT' }); return 1; }
      return importExport(resolve(p), knowledgeRoot);
    }
    case 'rebuild-html': {
      const n = rebuildHtml(knowledgeRoot);
      out({ event: 'done', saved: n, skipped: 0, failed: 0, durationSec: 0, message: 'index.html i strony rozmów przebudowane' });
      return 0;
    }
    case 'status': {
      const s = new Store(knowledgeRoot);
      if (s.size) s.writeIndexMd();
      const st = s.loadState();
      out({
        event: 'status', root: s.root, conversations: s.size,
        lastRun: st ? { runId: st.runId, mode: st.mode, startedAt: st.startedAt, finishedAt: st.finishedAt ?? null, pending: st.todo.length, failed: Object.keys(st.failed).length } : null,
        profileDir,
      });
      return 0;
    }
    default:
      out({ event: 'error', message: `nieznana akcja: ${cmd ?? '(brak)'} — login | sync | import-export | status` });
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { out({ event: 'error', message: (e as Error).message }); process.exit(1); },
);
