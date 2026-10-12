/**
 * ChatGPT Archiwizator — portable desktop app (Electron).
 * Twórca: Jakub Lipiński.
 *
 * Archives the user's conversations from the ChatGPT workspace "Santander" into a folder the user picks.
 * - Only the Santander workspace: other accounts/workspaces are refused, every request is scoped to it.
 * - Login happens in a normal Edge/Chrome window; the app never sees the password.
 * - Everything stays on this computer: no server, no telemetry.
 * Engine: ../engine (shared with the JARVIS chatgpt-importer plugin).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import {
  BrowserBlocked, ChatGPTClient, LoginRequired, rebuildHtml, Store, syncLive, WorkspaceNotAllowed, type ProgressEvent,
} from '../../engine/src/index.js';

const WORKSPACE = 'Santander';                 // fixed: the app works only for this workspace
const BROWSERS = process.env.ARCHIWIZATOR_BROWSERS?.split(',')   // tests only
  ?? ['msedge', 'chrome'];                     // Edge is on every company PC; Chrome as a fallback
const AUTHOR = 'Jakub Lipiński';
const DELAY_MS = 1000;                        // base pause between conversations; the engine slows down by itself on HTTP 429

if (process.env.ARCHIWIZATOR_USER_DATA) app.setPath('userData', process.env.ARCHIWIZATOR_USER_DATA);   // tests only
const userData = app.getPath('userData');
const profileDir = process.env.ARCHIWIZATOR_PROFILE || join(userData, 'browser-profile');   // override: tests only
const settingsFile = join(userData, 'settings.json');

type Settings = { folder?: string; lastRun?: { at: string; saved: number; total: number } };
const loadSettings = (): Settings => { try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const saveSettings = (s: Settings) => { mkdirSync(userData, { recursive: true }); writeFileSync(settingsFile, JSON.stringify(s, null, 2)); };

let win: BrowserWindow | null = null;
let busy: 'login' | 'archive' | null = null;
let abort: AbortController | null = null;

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);
const status = (kind: 'info' | 'wait' | 'ok' | 'error', text: string) => send('status', { kind, text });

function archiveRoot(folder: string) { return join(folder, 'ChatGPT'); }

function folderInfo(folder?: string) {
  if (!folder) return null;
  let writable = true;
  try { accessSync(folder, constants.W_OK); } catch { writable = false; }
  let conversations = 0;
  if (existsSync(join(archiveRoot(folder), 'index.json'))) {
    try { conversations = Object.keys(JSON.parse(readFileSync(join(archiveRoot(folder), 'index.json'), 'utf8'))).length; } catch { /* ignore */ }
  }
  return { folder, writable, conversations, archive: archiveRoot(folder) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 720, minWidth: 620, minHeight: 600,
    title: 'ChatGPT Archiwizator',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    icon: join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Closing while busy: ask without blocking (a sync dialog would freeze the archive and the window),
  // then stop after the current conversation so the saved state stays consistent.
  let asking = false;
  let quitting = false;
  win.on('close', (e) => {
    if (!busy || quitting) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    dialog.showMessageBox(win!, {
      type: 'warning', buttons: ['Kontynuuj pracę', 'Przerwij i zamknij'], defaultId: 0, cancelId: 0,
      title: 'Archiwizacja w toku',
      message: busy === 'archive' ? 'Trwa archiwizacja rozmów.' : 'Trwa logowanie.',
      detail: 'Jeśli zamkniesz teraz, postęp zostanie zapisany i następne uruchomienie dokończy pracę.',
    }).then(async ({ response }) => {
      asking = false;
      if (response !== 1) return;
      quitting = true;
      status('wait', 'Zapisuję postęp i zamykam… Proszę czekać.');
      abort?.abort();
      for (let i = 0; i < 120 && busy; i++) await new Promise((r) => setTimeout(r, 500));   // up to 60 s
      win?.destroy();
    });
  });
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(), author: AUTHOR, workspace: WORKSPACE, settings: loadSettings(), folderInfo: folderInfo(loadSettings().folder),
}));

ipcMain.handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Wybierz folder, w którym zapisać rozmowy', properties: ['openDirectory', 'createDirectory'],
    defaultPath: loadSettings().folder || app.getPath('documents'),
  });
  if (r.canceled || !r.filePaths[0]) return folderInfo(loadSettings().folder);
  const info = folderInfo(r.filePaths[0]);
  if (info && !info.writable) {
    dialog.showMessageBoxSync(win!, { type: 'error', title: 'Brak dostępu', message: 'Nie można zapisywać w tym folderze.', detail: 'Wybierz inny folder (np. w Dokumentach).' });
    return folderInfo(loadSettings().folder);
  }
  saveSettings({ ...loadSettings(), folder: r.filePaths[0] });
  return info;
});

ipcMain.handle('login', async () => {
  if (busy) return { ok: false, message: 'Poczekaj — trwa inna operacja.' };
  busy = 'login';
  const client = new ChatGPTClient({ profileDir, headless: false, delayMs: DELAY_MS, workspace: WORKSPACE, browsers: BROWSERS });
  try {
    status('wait', 'Otwieram przeglądarkę… Zaloguj się do ChatGPT kontem firmowym w oknie, które się pojawi.');
    await client.open();
    status('wait', 'Czekam na zalogowanie (do 10 minut). Po zalogowaniu okno zamknie się samo.');
    if (!(await client.waitForLogin())) return { ok: false, message: 'Nie zalogowano w ciągu 10 minut. Spróbuj ponownie.' };
    status('wait', 'Sprawdzam obszar roboczy…');
    const ws = await client.selectWorkspace();
    return { ok: true, message: `Zalogowano — obszar roboczy: ${ws?.name} (${ws?.planType}).`, workspace: ws?.name };
  } catch (e) {
    if (e instanceof WorkspaceNotAllowed) return { ok: false, message: e.message };
    if (e instanceof BrowserBlocked) return { ok: false, message: e.message };
    return { ok: false, message: `Logowanie nie powiodło się: ${(e as Error).message}` };
  } finally {
    await client.close();
    busy = null;
  }
});

ipcMain.handle('archive:start', async (_e, opts: { full?: boolean }) => {
  const folder = loadSettings().folder;
  if (busy) return { ok: false, code: -1, message: 'Poczekaj — trwa inna operacja.' };
  if (!folder || !folderInfo(folder)?.writable) return { ok: false, code: -1, message: 'Najpierw wybierz folder zapisu.' };
  busy = 'archive';
  abort = new AbortController();
  let last: ProgressEvent | null = null;
  try {
    const code = await syncLive({
      knowledgeRoot: folder, profileDir, headless: false, minimized: true, delayMs: DELAY_MS,
      workspace: WORKSPACE, browsers: BROWSERS, full: Boolean(opts?.full), signal: abort.signal,
      onEvent: (ev) => { last = ev; send('progress', ev); },
    });
    // archives made by an older version have no HTML pages yet: build them from what is on disk (no download)
    try {
      const idx = join(archiveRoot(folder), 'index.json');
      if (existsSync(idx)) {
        const entries = Object.values(JSON.parse(readFileSync(idx, 'utf8'))) as { folder: string }[];
        if (entries.some((e) => !existsSync(join(archiveRoot(folder), e.folder, 'conversation.html')))) {
          status('wait', 'Przygotowuję stronę archiwum (HTML)… Proszę czekać.');
          rebuildHtml(folder);
        }
      }
    } catch { /* the archive is saved; the HTML view is rebuilt next time */ }
    const done = last as ProgressEvent | null;
    if (done && done.event === 'done') {
      saveSettings({ ...loadSettings(), lastRun: { at: new Date().toISOString(), saved: done.saved, total: done.saved + done.skipped + done.failed } });
    }
    return { ok: code === 0 || code === 2, code, folderInfo: folderInfo(folder) };
  } catch (e) {
    if (e instanceof LoginRequired) return { ok: false, code: 3 };
    return { ok: false, code: 1, message: (e as Error).message };
  } finally {
    busy = null;
    abort = null;
  }
});

ipcMain.handle('archive:cancel', () => { abort?.abort(); return true; });

ipcMain.handle('open:archive', () => {
  const f = loadSettings().folder;
  if (f && existsSync(archiveRoot(f))) return shell.openPath(archiveRoot(f));
  return 'brak archiwum';
});
ipcMain.handle('open:index', () => {
  const f = loadSettings().folder;
  const p = f ? join(archiveRoot(f), 'index.html') : '';
  return p && existsSync(p) ? shell.openPath(p) : 'brak spisu';
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}

// exposed for the smoke test only
export const _test = { folderInfo, WORKSPACE, BROWSERS };
void Store;
