import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { ConversationSummary, RawConversation } from './types.js';

/**
 * Read-only ChatGPT client running inside the operator's own logged-in browser profile.
 * - The operator logs in once (`login`, visible window). The plugin never sees the password.
 * - Data comes from the same JSON endpoints the ChatGPT web app uses (full timestamps, roles, branches),
 *   called from inside the page so cookies/Cloudflare state are the browser's own.
 * - Only GET requests. Polite pacing + backoff on 429/5xx.
 */

const BASE = 'https://chatgpt.com';

export class LoginRequired extends Error {}
/** Cloudflare answered with its challenge page (typical for a headless browser). Not a login problem. */
export class BrowserBlocked extends Error {}
/** The logged-in account has no access to the required workspace (e.g. a private account instead of Santander). */
export class WorkspaceNotAllowed extends Error {}

export interface Workspace {
  accountId: string;
  name: string;
  planType: string;
}

const WORKSPACE_PLANS = new Set(['business', 'enterprise', 'team', 'edu']);
const normName = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export interface ClientOptions {
  profileDir: string;
  headless: boolean;        // ChatGPT's Cloudflare blocks headless Chrome — keep false outside tests
  minimized?: boolean;      // a normal window, started minimized
  delayMs: number;          // pause between conversation requests
  /** Only this ChatGPT workspace (exact name, case-insensitive, paid workspace plan). All requests are scoped to it,
   *  so private conversations of the same person are never fetched. Unset = the account's default context. */
  workspace?: string;
  /** Browser channels to try in order (default chrome, msedge, chromium). Corporate PCs: msedge first. */
  browsers?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatGPTClient {
  private ctx!: BrowserContext;
  private page!: Page;
  private token: string | null = null;
  private accountId: string | null = null;
  /** Adaptive pacing: grows after HTTP 429 (up to 4 s), shrinks back while requests go through. */
  private pace = 0;
  private okStreak = 0;
  workspaceInfo: Workspace | null = null;

  constructor(private opts: ClientOptions) {}

  /**
   * Resolve and pin the required workspace. Throws WorkspaceNotAllowed when the account is not a member.
   * Called before anything is listed or downloaded.
   */
  async selectWorkspace(): Promise<Workspace | null> {
    if (!this.opts.workspace) return null;
    const want = normName(this.opts.workspace);
    const j = await this.getJson<{ accounts?: Record<string, { account?: Record<string, unknown> }> }>(
      '/backend-api/accounts/check/v4-2023-04-27');
    const found: Workspace[] = [];
    for (const a of Object.values(j.accounts ?? {})) {
      const acc = a.account ?? {};
      const id = typeof acc.account_id === 'string' ? acc.account_id : '';
      const name = typeof acc.name === 'string' ? acc.name : '';
      const plan = typeof acc.plan_type === 'string' ? acc.plan_type : '';
      if (id && acc.structure === 'workspace' && WORKSPACE_PLANS.has(plan) && !acc.is_deactivated && normName(name) === want) {
        found.push({ accountId: id, name, planType: plan });
      }
    }
    // the same workspace may be listed twice (default + by id): any one id is fine, they must all agree
    const ids = new Set(found.map((f) => f.accountId));
    if (ids.size !== 1) {
      throw new WorkspaceNotAllowed(
        ids.size === 0
          ? `To konto nie należy do obszaru roboczego „${this.opts.workspace}”. Zaloguj się kontem firmowym.`
          : `Znaleziono kilka obszarów o nazwie „${this.opts.workspace}” — nie wiadomo, który wybrać.`,
      );
    }
    this.accountId = found[0].accountId;
    this.workspaceInfo = found[0];
    return found[0];
  }

  async open(): Promise<void> {
    const launch = (channel?: string) => chromium.launchPersistentContext(this.opts.profileDir, {
      channel,
      timeout: 60_000,
      headless: this.opts.headless,
      viewport: { width: 1280, height: 900 },
      locale: 'pl-PL',
      acceptDownloads: true,
      // a regular browser: sign-in providers refuse windows that announce automation
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', ...(this.opts.minimized ? ['--start-minimized'] : [])],
    });
    // installed Chrome first (logins and Cloudflare treat it as a normal browser), then Edge, then Playwright's Chromium
    const channels = this.opts.browsers?.length ? this.opts.browsers
      : process.env.CHATGPT_BROWSER ? [process.env.CHATGPT_BROWSER] : ['chrome', 'msedge', 'chromium'];
    let lastErr: unknown;
    for (const ch of channels) {
      try {
        this.ctx = await launch(ch === 'chromium' ? undefined : ch);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.ctx) {
      const msg = lastErr instanceof Error ? lastErr.message : '';
      if (/Timeout/i.test(msg)) {
        throw new Error('Przeglądarka nie odpowiedziała. Zamknij okna Edge/Chrome otwarte wcześniej przez archiwizator (także na pasku zadań) i spróbuj ponownie.');
      }
      if (/Executable doesn't exist|not found|ENOENT/i.test(msg)) {
        throw new Error('Nie znaleziono przeglądarki Microsoft Edge ani Google Chrome na tym komputerze.');
      }
      throw lastErr instanceof Error ? lastErr : new Error('no browser available');
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await this.page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  /** Cookies of the logged-in session → file (0600). Lets a headless server reuse a login done on a desktop. */
  async exportSession(path: string): Promise<void> {
    const state = await this.ctx.storageState();
    const cookies = state.cookies.filter((c) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(c.domain.replace(/^\./, '')));
    writeFileSync(path, JSON.stringify({ exportedAt: new Date().toISOString(), cookies }), { mode: 0o600 });
  }

  /** Load cookies exported by exportSession into this profile, then verify the session works. */
  async importSession(path: string): Promise<boolean> {
    const s = JSON.parse(readFileSync(path, 'utf8')) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
    if (!Array.isArray(s.cookies) || s.cookies.length === 0) throw new Error('plik sesji nie zawiera ciasteczek');
    await this.ctx.addCookies(s.cookies);
    await this.page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return this.refreshToken().then(() => true, () => false);
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
  }

  /** Interactive: keep the window open until the operator is logged in (or timeout). */
  async waitForLogin(timeoutMs = 10 * 60_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.refreshToken().then(() => true, () => false)) return true;
      await sleep(3000);
    }
    return false;
  }

  private async refreshToken(): Promise<void> {
    const s = await this.page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('json')) return { status: r.status, token: null as string | null, html: !ct.includes('json') };
      const j = (await r.json().catch(() => ({}))) as { accessToken?: string };
      return { status: r.status, token: j.accessToken ?? null, html: false };
    });
    if (!s.token && s.html && (s.status === 403 || s.status === 503)) {
      throw new BrowserBlocked('Cloudflare zablokował przeglądarkę (strona „Cierpliwości...”). Uruchom import w zwykłym oknie (CHATGPT_HEADLESS=0).');
    }
    if (!s.token) throw new LoginRequired('not logged in to ChatGPT');
    this.token = s.token;
  }

  /** GET JSON from the backend API with token refresh and backoff. */
  async getJson<T>(path: string): Promise<T> {
    if (!this.token) await this.refreshToken();
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = await this.page.evaluate(
        async ({ path, token, accountId }) => {
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
          if (accountId) headers['ChatGPT-Account-Id'] = accountId;   // scope every request to the selected workspace
          const r = await fetch(path, { credentials: 'include', headers });
          const text = await r.text();
          return { status: r.status, text, retryAfter: r.headers.get('retry-after') };
        },
        { path, token: this.token, accountId: this.accountId },
      );
      if (res.status === 200) {
        if (this.pace && ++this.okStreak >= 15) { this.pace = Math.max(this.opts.delayMs, this.pace / 1.3); this.okStreak = 0; }
        return JSON.parse(res.text) as T;
      }
      if (res.status === 401 || res.status === 403) {
        if (attempt >= 2) throw new LoginRequired(`HTTP ${res.status} for ${path}`);
        await this.refreshToken();
        continue;
      }
      if (res.status === 404) throw new Error(`HTTP 404 for ${path}`);
      if (res.status === 429) {
        this.pace = Math.min(4000, Math.max(this.pace, this.opts.delayMs) * 1.6);
        this.okStreak = 0;
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.retryAfter) > 0 ? Number(res.retryAfter) * 1000 : Math.min(120_000, 3000 * 2 ** (attempt - 1));
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${path}: ${res.text.slice(0, 200)}`);
    }
    throw new Error(`gave up after retries: ${path}`);
  }

  /** Every conversation (active + archived), newest update first. */
  async listConversations(): Promise<ConversationSummary[]> {
    if (this.opts.workspace && !this.accountId) throw new WorkspaceNotAllowed('obszar roboczy nie został wybrany');
    const all = new Map<string, ConversationSummary>();
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const page = await this.getJson<{ items: ConversationSummary[]; total?: number }>(
          `/backend-api/conversations?offset=${offset}&limit=100&order=updated${archived ? '&is_archived=true' : ''}`,
        );
        for (const it of page.items ?? []) {
          const toUnix = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) / 1000 : null);
          all.set(it.id, { id: it.id, title: it.title ?? '', create_time: toUnix(it.create_time), update_time: toUnix(it.update_time), is_archived: archived });
        }
        if (!page.items || page.items.length < 100) break;
        await sleep(this.opts.delayMs / 2);
      }
    }
    return [...all.values()].sort((a, b) => (b.update_time ?? 0) - (a.update_time ?? 0));
  }

  async getConversation(id: string): Promise<RawConversation> {
    await sleep(Math.max(this.opts.delayMs, this.pace));
    const c = await this.getJson<RawConversation>(`/backend-api/conversation/${encodeURIComponent(id)}`);
    c.id = c.id || c.conversation_id || id;
    return c;
  }

  /** Bytes of an uploaded/generated file, or null when ChatGPT no longer has it. */
  async downloadFile(fileId: string, maxBytes = 50 * 1024 * 1024): Promise<{ data: Buffer; name?: string; mime?: string } | null> {
    let info: { download_url?: string; file_name?: string; status?: string };
    try {
      info = await this.getJson(`/backend-api/files/${encodeURIComponent(fileId)}/download`);
    } catch (e) {
      if (e instanceof LoginRequired) throw e;
      return null;
    }
    if (!info.download_url) return null;
    const r = await this.page.evaluate(
      async ({ url, max }) => {
        const resp = await fetch(url, { credentials: url.startsWith('/') || url.includes('chatgpt.com') ? 'include' : 'omit' });
        if (!resp.ok) return { ok: false, status: resp.status, b64: '', mime: '' };
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.byteLength > max) return { ok: false, status: 413, b64: '', mime: '' };
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { ok: true, status: 200, b64: btoa(s), mime: resp.headers.get('content-type') || '' };
      },
      { url: info.download_url, max: maxBytes },
    );
    if (!r.ok) return null;
    return { data: Buffer.from(r.b64, 'base64'), name: info.file_name, mime: r.mime || undefined };
  }

  /**
   * Fallback when the JSON endpoint refuses a conversation: open it, scroll to the very beginning
   * until no older messages load, and read the rendered turns. No per-message timestamps in this mode.
   */
  async captureFromDom(id: string): Promise<RawConversation> {
    await this.page.goto(`${BASE}/c/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.waitForSelector('[data-message-author-role]', { timeout: 30_000 });
    let last = -1;
    for (let i = 0; i < 200; i++) {
      const n = await this.page.evaluate(() => {
        const first = document.querySelector('[data-message-author-role]');
        let el: HTMLElement | null = first as HTMLElement | null;
        while (el && el.scrollHeight <= el.clientHeight + 2) el = el.parentElement;
        if (el) el.scrollTop = 0;
        return document.querySelectorAll('[data-message-author-role]').length;
      });
      if (n === last) {
        await sleep(1500);
        const again = await this.page.evaluate(() => document.querySelectorAll('[data-message-author-role]').length);
        if (again === n) break;
      }
      last = n;
      await sleep(700);
    }
    const turns = await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-message-author-role]')].map((el, i) => ({
        id: el.getAttribute('data-message-id') || `dom-${i}`,
        role: el.getAttribute('data-message-author-role') || 'assistant',
        text: el.innerText,
      })),
    );
    const title = (await this.page.title()).replace(/\s*[|-]\s*ChatGPT\s*$/i, '').trim();
    const mapping: RawConversation['mapping'] = {};
    let parent: string | null = null;
    for (const t of turns) {
      mapping[t.id] = { id: t.id, parent, children: [], message: { id: t.id, author: { role: t.role }, content: { content_type: 'text', parts: [t.text] } } };
      if (parent) mapping[parent].children!.push(t.id);
      parent = t.id;
    }
    return { id, title, mapping, current_node: parent, create_time: null, update_time: null };
  }
}
