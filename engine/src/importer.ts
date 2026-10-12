import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { BrowserBlocked, ChatGPTClient, LoginRequired, WorkspaceNotAllowed, type ClientOptions } from './chatgpt.js';
import { conversationHtml, IMAGE_EXT, SAFE_EXT } from './html.js';
import { toMarkdown } from './markdown.js';
import { normalizeConversation, safeFileId } from './normalize.js';
import { safeFileName, Store, writeAtomic, type RunState } from './store.js';
import type { ConversationSummary, FileRef, NormalizedConversation, ProgressEvent, RawConversation } from './types.js';

export type Emit = (e: ProgressEvent) => void;

const ATTACHMENT_CONCURRENCY = 3;

/** Progress goes to the run log and to `onEvent` (an app UI) — or to stdout as JSON lines (Jarvis / CLI). */
export function makeEmitter(store: Store, runId: string, onEvent?: Emit): Emit {
  const log = store.runLog(runId);
  return (e) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
    appendFileSync(log, line + '\n');
    if (onEvent) onEvent(e);
    else process.stdout.write(line + '\n');
  };
}

export class Cancelled extends Error {}

export const newRunId = () =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + randomBytes(3).toString('hex');

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
};

export function fileNameFor(f: FileRef, name?: string, mime?: string): string {
  const id = safeFileId(f.fileId);
  if (!id) throw new Error('invalid file id');
  let n = safeFileName(name || f.name || id, id);
  if (!extname(n)) n += EXT_BY_MIME[(mime || f.mime || '').split(';')[0]] ?? '';
  // prefix with the file id so two different files with the same name never overwrite each other;
  // the whole name is sanitised again so nothing from the data can form a path
  // the FULL id: ChatGPT ids share long prefixes (file_0000000…), a shortened one would collide
  return neutralize(shortName(safeFileName(n.startsWith(id) ? n : `${id}_${n}`, id), id));
}

/** Only allowlisted passive types keep their extension; everything else becomes plain text (.txt). */
export function neutralize(name: string): string {
  return SAFE_EXT.test(name) ? name : `${name}.txt`;
}

/**
 * The single rule for a file already on disk, used by both archiving and the HTML rebuild:
 * a name not in the current safe form (too long, active content) is renamed before it is linked anywhere.
 */
export function adoptSaved(dir: string, onDisk: string[], fileId: string): string | undefined {
  const hit = findSaved(onDisk, fileId);
  if (!hit) return undefined;
  const safe = neutralize(shortName(hit, fileId));
  if (safe === hit) return hit;
  renameSync(join(dir, hit), join(dir, safe));
  return safe;
}

/** Windows/browsers break on paths over 260 characters: names are kept to MAX_NAME, id and extension preserved. */
const MAX_NAME = 100;
export function shortName(name: string, id: string): string {
  if (name.length <= MAX_NAME) return name;
  const ext = (extname(name).length <= 8 ? extname(name) : '').toLowerCase();
  const stem = name.slice(0, name.length - ext.length);
  const rest = stem.startsWith(id) ? stem.slice(id.length).replace(/^[_-]/, '') : stem;
  const room = MAX_NAME - id.length - 1 - ext.length;
  return room > 3 ? `${id}_${rest.slice(0, room)}${ext}` : `${id}${ext}`;
}

/** Already-downloaded file of this id in the folder (name starts with the full id + a separator, or is the id). */
export function findSaved(files: string[], fileId: string): string | undefined {
  return files.find((x) => x === fileId || x.startsWith(fileId + '_') || x.startsWith(fileId + '-') || x.startsWith(fileId + '.'));
}

/** Save one conversation (+ attachments via `fetchFile`). Returns the number of files saved. */
async function persist(
  store: Store, raw: RawConversation, conv: NormalizedConversation, source: 'live' | 'export',
  fetchFile: (f: FileRef) => Promise<{ data: Buffer; name?: string; mime?: string } | null>, emit: Emit,
): Promise<void> {
  const folder = store.folderFor(conv);
  const saved: Record<string, string> = {};
  // files already on disk (resume / incremental) are reused — no second download
  const existingDir = store.abs(`${folder}/attachments`);
  const onDisk = existsSync(existingDir) ? readdirSync(existingDir) : [];
  const todo: FileRef[] = [];
  for (const f of conv.files) {
    const hit = adoptSaved(existingDir, onDisk, f.fileId);
    if (hit && store.hasFile(join(existingDir, hit))) saved[f.fileId] = `attachments/${hit}`;
    else todo.push(f);
  }
  // download up to ATTACHMENT_CONCURRENCY files at a time (big conversations have dozens of images)
  let loginErr: unknown = null;
  const worker = async () => {
    for (let f = todo.shift(); f && !loginErr; f = todo.shift()) {
      try {
        const got = await fetchFile(f);
        if (!got) {
          emit({ event: 'warning', id: conv.id, message: `załącznik niedostępny: ${f.name}` });
          continue;
        }
        const name = fileNameFor(f, got.name, got.mime);
        const p = store.attachmentPath(folder, name);
        writeAtomic(p.abs, got.data);
        saved[f.fileId] = p.rel;
      } catch (e) {
        if (e instanceof LoginRequired) { loginErr = e; return; }
        emit({ event: 'warning', id: conv.id, message: `załącznik ${f.name}: ${(e as Error).message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: ATTACHMENT_CONCURRENCY }, worker));
  if (loginErr) throw loginErr;
  store.saveConversation(conv, toMarkdown(conv, saved), raw, source, saved);
}

export interface SyncOptions extends ClientOptions {
  knowledgeRoot: string;
  full: boolean;            // re-check every conversation, ignoring update_time
  limit?: number;           // stop after N conversations (testing)
  onEvent?: Emit;           // progress for an app UI (default: JSON lines on stdout)
  signal?: AbortSignal;     // cancel: the current conversation finishes, state is saved, the next run resumes
}

/** Live incremental sync. Resumes an unfinished run automatically. */
export async function syncLive(opts: SyncOptions): Promise<number> {
  const store = new Store(opts.knowledgeRoot);
  const unlock = store.lock();
  const started = Date.now();
  const prev = store.loadState();
  const resuming = prev && !prev.finishedAt && prev.todo.length > 0 && !opts.full;
  const runId = resuming ? prev!.runId : newRunId();
  const emit = makeEmitter(store, runId, opts.onEvent);
  const client = new ChatGPTClient(opts);
  let saved = 0, skipped = 0, failed = 0;
  try {
    emit({ event: 'start', mode: resuming ? 'resume' : opts.full ? 'full' : 'incremental', runId });
    emit({ event: 'phase', phase: 'browser', message: 'Uruchamiam przeglądarkę i sprawdzam logowanie…' });
    await client.open();
    const ws = await client.selectWorkspace();
    if (ws) {
      // one archive folder = one workspace: never mix two workspaces' conversations
      const wsFile = store.abs('workspace.json');
      const prevWs = existsSync(wsFile) ? (JSON.parse(readFileSync(wsFile, 'utf8')) as { accountId?: string; name?: string }) : null;
      if (prevWs?.accountId && prevWs.accountId !== ws.accountId) {
        throw new WorkspaceNotAllowed(`Ten folder zawiera archiwum innego obszaru („${prevWs.name}”). Wybierz inny folder.`);
      }
      if (!prevWs) writeAtomic(wsFile, JSON.stringify({ ...ws, firstSeen: new Date().toISOString() }, null, 2));
    }
    emit({ event: 'phase', phase: 'listing', message: 'Pobieram listę rozmów…' });
    const list = await client.listConversations();
    const byId = new Map(list.map((c) => [c.id, c]));

    let state: RunState;
    if (resuming) {
      state = prev!;
      // anything that changed since the interrupted run is added at the end
      for (const c of list) if (!state.todo.includes(c.id) && !store.isUpToDate(c.id, c.update_time)) state.todo.push(c.id);
    } else {
      const todo = list.filter((c) => opts.full || !store.isUpToDate(c.id, c.update_time)).map((c) => c.id);
      state = { runId, mode: opts.full ? 'full' : 'incremental', startedAt: new Date().toISOString(), todo, done: 0, failed: {} };
    }
    skipped = list.length - state.todo.length;          // already up to date
    if (opts.limit) state.todo = state.todo.slice(0, opts.limit);
    store.saveState(state);
    emit({ event: 'listed', total: list.length, todo: state.todo.length });

    const total = state.todo.length;
    if (total) emit({ event: 'phase', phase: 'downloading', message: `Archiwizuję ${total} rozmów — to może potrwać kilka minut, nie zamykaj aplikacji.` });
    let n = 0;
    while (state.todo.length) {
      if (opts.signal?.aborted) throw new Cancelled();
      const id = state.todo[0];
      const summary: ConversationSummary | undefined = byId.get(id);
      n++;
      try {
        let raw: RawConversation;
        const source = 'live' as const;
        try {
          raw = await client.getConversation(id);
        } catch (e) {
          if (e instanceof LoginRequired) throw e;
          if (/HTTP 404/.test(String(e))) {   // deleted in the meantime
            emit({ event: 'warning', id, message: 'rozmowa usunięta w ChatGPT — pominięta' });
            state.todo.shift(); store.saveState(state); continue;
          }
          // the page view cannot be pinned to a workspace: no DOM fallback when a workspace is enforced
          if (opts.workspace) throw e;
          emit({ event: 'warning', id, message: `API: ${(e as Error).message} — tryb zapasowy (przewijanie strony)` });
          raw = await client.captureFromDom(id);
        }
        if (summary) {
          raw.update_time ??= summary.update_time;
          raw.create_time ??= summary.create_time;
          raw.title ||= summary.title;
          raw.is_archived ??= summary.is_archived;
        }
        const conv = normalizeConversation(raw);
        await persist(store, raw, conv, source, (f) => client.downloadFile(f.fileId), emit);
        saved++;
        delete state.failed[id];
        emit({ event: 'progress', done: n, total, id, title: conv.title, status: 'saved' });
      } catch (e) {
        if (e instanceof LoginRequired) throw e;
        const f = state.failed[id] ?? { error: '', attempts: 0 };
        f.attempts++;
        f.error = (e as Error).message.slice(0, 300);
        state.failed[id] = f;
        failed++;
        emit({ event: 'progress', done: n, total, id, title: summary?.title ?? id, status: 'failed' });
      }
      state.todo.shift();
      state.done++;
      store.saveState(state);
    }
    state.finishedAt = new Date().toISOString();
    store.saveState(state);
    emit({ event: 'done', saved, skipped, failed, durationSec: Math.round((Date.now() - started) / 1000) });
    return failed ? 2 : 0;
  } catch (e) {
    if (e instanceof Cancelled) {
      emit({ event: 'cancelled', saved, message: 'Przerwano. Postęp zapisany — następne uruchomienie dokończy archiwizację.' });
      return 5;
    }
    if (e instanceof BrowserBlocked) {
      emit({ event: 'error', message: e.message });
      return 4;
    }
    if (e instanceof WorkspaceNotAllowed) {
      emit({ event: 'error', message: e.message });
      return 6;
    }
    if (e instanceof LoginRequired) {
      emit({ event: 'login_required', message: 'Sesja ChatGPT wygasła lub brak logowania — uruchom akcję „login”. Postęp zapisany, kolejne uruchomienie wznowi import.' });
      return 3;
    }
    emit({ event: 'error', message: (e as Error).message });
    return 1;
  } finally {
    await client.close();
    try { store.writeHtmlIndex(); } catch { /* the archive itself is saved; the HTML view is rebuilt next time */ }
    unlock();
  }
}

/**
 * Official ChatGPT export (Settings → Data controls → Export): a ZIP (or unpacked folder) with
 * conversations.json and the uploaded files. Same format as the live API, no browser needed.
 */
export async function importExport(path: string, knowledgeRoot: string): Promise<number> {
  const store = new Store(knowledgeRoot);
  const unlock = store.lock();
  const runId = newRunId();
  const emit = makeEmitter(store, runId);
  const started = Date.now();
  let saved = 0, skipped = 0, failed = 0;
  try {
    emit({ event: 'start', mode: 'export', runId });
    let readEntry: (name: string) => Buffer | null;
    let names: string[];
    if (statSync(path).isDirectory()) {
      names = readdirSync(path, { recursive: true }).map(String).map((s) => s.split('\\').join('/'));
      readEntry = (n) => (names.includes(n) ? readFileSync(join(path, n)) : null);
    } else {
      const zip = new AdmZip(path);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);
      names = entries.map((e) => e.entryName);
      const map = new Map(entries.map((e) => [e.entryName, e]));
      readEntry = (n) => map.get(n)?.getData() ?? null;   // read into memory; never extracted to disk by name
    }
    const convName = names.find((n) => /(^|\/)conversations\.json$/.test(n));
    if (!convName) throw new Error('w eksporcie brak conversations.json');
    const list = JSON.parse(readEntry(convName)!.toString('utf8')) as RawConversation[];
    const prefix = convName.replace(/conversations\.json$/, '');
    emit({ event: 'listed', total: list.length, todo: list.length });

    let n = 0;
    for (const raw of list) {
      n++;
      try {
        const conv = normalizeConversation(raw);
        if (store.isUpToDate(conv.id, conv.updateTime)) {
          skipped++;
          emit({ event: 'progress', done: n, total: list.length, id: conv.id, title: conv.title, status: 'skipped' });
          continue;
        }
        await persist(store, raw, conv, 'export', async (f) => {
          const hit = names.find((x) => x.startsWith(prefix) && findSaved([x.slice(prefix.length)], f.fileId));
          const data = hit ? readEntry(hit) : null;
          return data ? { data, name: hit!.slice(prefix.length).split('/').pop() || f.name } : null;
        }, emit);
        saved++;
        emit({ event: 'progress', done: n, total: list.length, id: conv.id, title: conv.title, status: 'saved' });
      } catch (e) {
        failed++;
        emit({ event: 'warning', message: `rozmowa ${n}: ${(e as Error).message}` });
      }
    }
    emit({ event: 'done', saved, skipped, failed, durationSec: Math.round((Date.now() - started) / 1000) });
    return failed ? 2 : 0;
  } catch (e) {
    emit({ event: 'error', message: (e as Error).message });
    return 1;
  } finally {
    try { store.writeHtmlIndex(); } catch { /* rebuilt next time */ }
    unlock();
  }
}

/**
 * HTML view for an existing archive (made before HTML existed, or after a format change): re-renders every
 * conversation from raw.json and the attachments already on disk. Nothing is downloaded.
 */
export function rebuildHtml(knowledgeRoot: string, onEvent?: Emit): number {
  const store = new Store(knowledgeRoot);
  const unlock = store.lock();
  let n = 0;
  try {
    const all = store.entries;
    for (const e of all) {
      try {
        const raw = JSON.parse(readFileSync(store.abs(`${e.folder}/raw.json`), 'utf8')) as RawConversation;
        const conv = normalizeConversation(raw);
        const dir = store.abs(`${e.folder}/attachments`);
        const onDisk = existsSync(dir) ? readdirSync(dir) : [];
        const saved: Record<string, string> = {};
        for (const f of conv.files) {
          const hit = adoptSaved(dir, onDisk, f.fileId);
          if (hit) saved[f.fileId] = `attachments/${hit}`;
        }
        writeAtomic(store.abs(`${e.folder}/conversation.md`), toMarkdown(conv, saved));
        writeAtomic(store.abs(`${e.folder}/conversation.html`), conversationHtml(conv, saved, '../'.repeat(e.folder.split('/').length)));
        store.setEntry({
          ...e,
          images: Object.values(saved).filter((f) => IMAGE_EXT.test(f)).map((f) => `${e.folder}/${f}`),
          searchText: conv.messages.map((m) => m.text.replace(/attachment:[A-Za-z0-9_-]+/g, '')).join(' ').replace(/\s+/g, ' ').slice(0, 20000),
        });
        n++;
        onEvent?.({ event: 'progress', done: n, total: all.length, id: e.id, title: e.title, status: 'saved' });
      } catch (err) {
        onEvent?.({ event: 'warning', id: e.id, message: `HTML: ${(err as Error).message}` });
      }
    }
    store.flushIndex();
    store.writeHtmlIndex();
    return n;
  } finally {
    unlock();
  }
}
