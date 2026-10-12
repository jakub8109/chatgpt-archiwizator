import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { conversationHtml, galleryHtml, IMAGE_EXT, indexHtml, type HtmlIndexItem } from './html.js';
import { mdEscape } from './markdown.js';
import type { NormalizedConversation } from './types.js';

/**
 * Knowledge/ChatGPT/
 *   index.json                      every conversation: id → folder, title, update_time, content hash
 *   state.json                      resume state of the current/last run
 *   conversations/YYYY/MM/<date>_<slug>_<id8>/
 *       conversation.md  metadata.json  raw.json  attachments/
 *   runs/<runId>.jsonl              progress log of each run
 *
 * A conversation's folder is fixed by its id the first time it is saved (looked up in index.json),
 * so a renamed conversation is updated in place — never duplicated.
 */

export interface IndexEntry {
  id: string;
  title: string;
  folder: string;              // relative to the ChatGPT root, forward slashes
  updateTime: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  messages: number;
  hash: string;                // sha256 of conversation.md
  savedAt: string;
  source: 'live' | 'export';
  images?: string[];           // saved images, relative to the ChatGPT root (gallery, thumbnails)
  searchText?: string;         // start of the text, for the search box in index.html
}

export interface RunState {
  runId: string;
  mode: string;
  startedAt: string;
  todo: string[];              // conversation ids still to fetch, in order
  done: number;
  failed: Record<string, { error: string; attempts: number }>;
  finishedAt?: string;
}

export function slugify(s: string, max = 60): string {
  const base = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base || 'rozmowa';
}

/** Safe single path segment for an attachment name (no traversal, no reserved characters). */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  readonly root: string;
  private index: Record<string, IndexEntry>;

  constructor(knowledgeRoot: string) {
    this.root = resolve(knowledgeRoot, 'ChatGPT');
    mkdirSync(join(this.root, 'conversations'), { recursive: true });
    mkdirSync(join(this.root, 'runs'), { recursive: true });
    this.index = readJson(join(this.root, 'index.json'), {} as Record<string, IndexEntry>);
  }

  get size(): number {
    return Object.keys(this.index).length;
  }

  entry(id: string): IndexEntry | undefined {
    return this.index[id];
  }

  /** True when the stored copy is at least as new as the remote one and still on disk. */
  isUpToDate(id: string, remoteUpdateTime: number | null): boolean {
    const e = this.index[id];
    if (!e) return false;
    if (!existsSync(join(this.root, e.folder, 'conversation.md'))) return false;
    if (remoteUpdateTime === null || e.updateTime === null) return false;
    return e.updateTime >= remoteUpdateTime;
  }

  folderFor(conv: NormalizedConversation): string {
    const known = this.index[conv.id];
    if (known) return known.folder;
    const d = conv.createdAt ? new Date(conv.createdAt) : null;
    const y = d ? String(d.getUTCFullYear()) : 'bez-daty';
    const mo = d ? String(d.getUTCMonth() + 1).padStart(2, '0') : '00';
    const day = d ? d.toISOString().slice(0, 10) : 'bez-daty';
    return ['conversations', y, mo, `${day}_${slugify(conv.title)}_${conv.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`].join('/');
  }

  /** Absolute path inside the store; refuses anything that escapes the root. */
  abs(rel: string): string {
    const p = resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`path escapes store: ${rel}`);
    return p;
  }

  attachmentPath(folder: string, fileName: string): { abs: string; rel: string } {
    const abs = this.abs(`${folder}/attachments/${fileName}`);
    return { abs, rel: relative(this.abs(folder), abs).split(sep).join('/') };
  }

  hasFile(abs: string): boolean {
    try {
      return statSync(abs).size > 0;
    } catch {
      return false;
    }
  }

  saveConversation(conv: NormalizedConversation, markdown: string, raw: unknown, source: 'live' | 'export',
                   savedFiles: Record<string, string> = {}): IndexEntry {
    const folder = this.folderFor(conv);
    const meta = {
      id: conv.id,
      title: conv.title,
      created: conv.createdAt,
      updated: conv.updatedAt,
      update_time: conv.updateTime,
      model: conv.model ?? null,
      gizmo_id: conv.gizmoId ?? null,
      archived: conv.archived,
      branches: conv.branchCount,
      messages: conv.messages.map((m) => ({ id: m.id, role: m.role, created: m.createdAt, model: m.model ?? null, files: m.files.map((f) => f.fileId) })),
      files: conv.files,
      url: `https://chatgpt.com/c/${conv.id}`,
      source,
      saved_at: new Date().toISOString(),
    };
    writeAtomic(this.abs(`${folder}/raw.json`), JSON.stringify(raw, null, 1));
    writeAtomic(this.abs(`${folder}/metadata.json`), JSON.stringify(meta, null, 2));
    writeAtomic(this.abs(`${folder}/conversation.md`), markdown);
    writeAtomic(this.abs(`${folder}/conversation.html`), conversationHtml(conv, savedFiles, '../'.repeat(folder.split('/').length)));
    const e: IndexEntry = {
      id: conv.id, title: conv.title, folder, updateTime: conv.updateTime, createdAt: conv.createdAt,
      updatedAt: conv.updatedAt, messages: conv.messages.length, hash: sha256(markdown), savedAt: meta.saved_at, source,
      images: Object.values(savedFiles).filter((f) => IMAGE_EXT.test(f)).map((f) => `${folder}/${f}`),
      searchText: conv.messages.map((m) => m.text.replace(/attachment:[A-Za-z0-9_-]+/g, '')).join(' ').replace(/\s+/g, ' ').slice(0, 20000),
    };
    this.index[conv.id] = e;
    this.flushIndex();
    return e;
  }

  /** index.html (topics, search) + galeria.html (all images). Written at the end of a run. */
  writeHtmlIndex(): void {
    const items: HtmlIndexItem[] = Object.values(this.index)
      .sort((a, b) => (b.updateTime ?? 0) - (a.updateTime ?? 0))
      .map((e) => ({ title: e.title, href: `${e.folder}/conversation.html`, updatedAt: e.updatedAt, createdAt: e.createdAt,
                     messages: e.messages, images: e.images ?? [], searchText: e.searchText ?? '' }));
    let workspace: string | undefined;
    try { workspace = JSON.parse(readFileSync(join(this.root, 'workspace.json'), 'utf8')).name; } catch { /* none */ }
    writeAtomic(join(this.root, 'index.html'), indexHtml(items, workspace));
    writeAtomic(join(this.root, 'galeria.html'), galleryHtml(items));
  }

  /** Update one index entry in place (HTML rebuild). */
  setEntry(e: IndexEntry): void {
    this.index[e.id] = e;
  }

  get entries(): IndexEntry[] {
    return Object.values(this.index);
  }

  flushIndex(): void {
    writeAtomic(join(this.root, 'index.json'), JSON.stringify(this.index, null, 1));
    this.writeIndexMd();
  }

  /** INDEX.md — table of contents for reading the archive (VS Code preview, Obsidian, any Markdown viewer). */
  writeIndexMd(): void {
    const all = Object.values(this.index).sort((a, b) => (b.updateTime ?? 0) - (a.updateTime ?? 0));
    const esc = mdEscape;   // titles are untrusted: every Markdown-significant character is escaped
    const link = (p: string) => encodeURI(p).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const lines = [
      '# ChatGPT — archiwum rozmów', '',
      `${all.length} rozmów · zaktualizowano ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
      '| Ostatnia zmiana | Rozmowa | Wiadomości | Utworzona |', '|---|---|---:|---|',
      ...all.map((e) => `| ${(e.updatedAt ?? '').slice(0, 10)} | [${esc(e.title)}](${link(e.folder + '/conversation.md')}) | ${e.messages} | ${(e.createdAt ?? '').slice(0, 10)} |`),
      '',
    ];
    writeAtomic(join(this.root, 'INDEX.md'), lines.join('\n'));
  }

  loadState(): RunState | null {
    return readJson<RunState | null>(join(this.root, 'state.json'), null);
  }

  saveState(s: RunState): void {
    writeAtomic(join(this.root, 'state.json'), JSON.stringify(s, null, 1));
  }

  runLog(runId: string): string {
    return join(this.root, 'runs', `${runId}.jsonl`);
  }

  /** Exclusive lock so two runs never write the same store. Stale locks (dead pid) are taken over. */
  lock(): () => void {
    const p = join(this.root, '.lock');
    if (existsSync(p)) {
      const pid = Number(readFileSync(p, 'utf8').trim());
      // signal 0 only tests for existence (also on Windows in Node); a lock older than 12 h is stale
      // even if its pid now belongs to some other process
      const fresh = Date.now() - statSync(p).mtimeMs < 12 * 3600_000;
      let alive = false;
      if (pid && fresh) {
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
      if (alive && pid !== process.pid) throw new Error(`another import is running (pid ${pid})`);
      rmSync(p, { force: true });
    }
    const fd = openSync(p, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => rmSync(p, { force: true });
  }
}
