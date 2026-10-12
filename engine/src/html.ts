/**
 * Offline HTML view of the archive: index.html (topics), one page per conversation, galeria.html (all images).
 * Opens from disk (file://) in any browser, no network, no external files.
 *
 * Safety: conversation text is untrusted. Everything is HTML-escaped first; only our own Markdown subset is turned
 * into tags afterwards. Link targets are limited to http(s)/mailto and local relative paths; images only from the
 * archive itself. The pages carry a CSP that allows no external loads and only our own inline script (by hash).
 */
import { createHash } from 'node:crypto';
import type { NormalizedConversation } from './types.js';

// no SVG: as a document it can run script (SVG is not on SAFE_EXT, so it is stored as .txt)
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/**
 * ALLOWLIST of passive attachment types that may keep their extension. Anything else (html, svg, xml, js, exe,
 * bat, ps1, lnk, …, or no extension) is stored with an extra .txt so opening it from the archive cannot run code.
 */
export const SAFE_EXT = /\.(png|jpe?g|gif|webp|bmp|pdf|txt|csv|tsv|md|log|json|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|7z|mp3|m4a|wav|ogg|mp4|mov|webm)$/i;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** href for a link: http(s), mailto, or a relative path inside the archive; anything else is dropped. */
function safeHref(u: string): string | null {
  const url = u.trim().replace(/&amp;/g, '&');
  // backslashes become UNC paths (\\host\share) on a file:// page: an SMB request that leaks the NTLM hash
  if (url.includes('\\') || /%5c/i.test(url) || /[\x00-\x1f]/.test(url)) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;   // javascript:, data:, file:, …
  if (url.startsWith('/') || url.split(/[?#]/)[0].split('/').some((seg) => seg === '..')) return null;
  return url;
}

/** Inline Markdown on ALREADY ESCAPED text. */
function inline(t: string): string {
  const codes: string[] = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, c: string) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const h = safeHref(src);
    // only images stored in this archive's attachments folder (never remote, absolute or UNC paths)
    if (!h || !/^attachments\/[^/]+$/.test(h) || !IMAGE_EXT.test(decodeURI(h.split(/[?#]/)[0]))) return alt ? `[${alt}]` : '';
    return `<a class="img" href="${esc(h)}" target="_blank"><img src="${esc(h)}" alt="${alt}" loading="lazy"></a>`;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, href: string) => {
    const h = safeHref(href);
    return h ? `<a href="${esc(h)}"${/^https?:/i.test(h) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${txt}</a>` : txt;
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) =>
    `${pre}<a href="${esc(url.replace(/&amp;/g, '&'))}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Markdown subset → HTML: fenced code, headings, quotes, lists, tables, rules, paragraphs, reasoning blocks. */
export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(esc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`); para.length = 0; } };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[2])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[3] ? ` data-lang="${esc(fence[3])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '<details><summary>reasoning</summary>') { flush(); out.push('<details class="reasoning"><summary>Tok rozumowania modelu</summary>'); i++; continue; }
    if (line.trim() === '</details>') { flush(); out.push('</details>'); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); const lvl = Math.min(6, h[1].length + 2); out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(esc(c.trim())));
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${inline(esc(x)).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--text:#1d2430;--muted:#667085;--line:#e3e7ee;--accent:#1f4fd6;--user:#eaf0ff;--code:#f3f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--text:#e6e9ef;--muted:#98a2b3;--line:#2c323c;--accent:#7aa2ff;--user:#22304f;--code:#262b33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Segoe UI",system-ui,sans-serif}
a{color:var(--accent)}header.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header.top h1{font-size:18px;margin:0;flex:1 1 auto;min-width:200px}header.top nav{display:flex;gap:14px;font-size:14px}
main{max-width:980px;margin:0 auto;padding:20px 16px 60px}.muted{color:var(--muted)}
.search{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 18px}.search input,.search select{font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
.search input[type=search]{flex:1 1 260px}.search label{display:flex;gap:6px;align-items:center;font-size:14px;color:var(--muted)}
.list{display:grid;gap:10px}.conv{display:flex;gap:14px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-decoration:none;color:inherit}
.conv:hover{border-color:var(--accent)}.conv .thumb{flex:none;width:64px;height:64px;border-radius:8px;object-fit:cover;background:var(--code)}
.conv .noimg{flex:none;width:64px;height:64px;border-radius:8px;background:var(--code);display:grid;place-items:center;color:var(--muted);font-size:22px}
.conv h2{font-size:16px;margin:0 0 2px}.conv .meta{font-size:13px;color:var(--muted)}
.msg{margin:14px 0;padding:12px 16px;border-radius:12px;background:var(--card);border:1px solid var(--line);overflow-wrap:anywhere}
.msg.user{background:var(--user);margin-left:48px}.msg.tool{font-size:13.5px;opacity:.9}.msg .who{font-size:12.5px;color:var(--muted);margin-bottom:4px}
.msg img{max-width:100%;max-height:420px;border-radius:8px;border:1px solid var(--line);display:block;margin:6px 0}
pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto;font-size:13px}code{font-family:Consolas,"Cascadia Mono",monospace;font-size:.92em}
p code,li code{background:var(--code);padding:1px 5px;border-radius:4px}.table{overflow-x:auto}table{border-collapse:collapse;margin:8px 0;font-size:14px}
th,td{border:1px solid var(--line);padding:5px 9px;text-align:left;vertical-align:top}blockquote{margin:6px 0;padding:2px 12px;border-left:3px solid var(--line);color:var(--muted)}
details.reasoning{font-size:13.5px;color:var(--muted);margin:6px 0}.files{margin-top:8px;font-size:14px}.files li{margin:2px 0}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.gallery a{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;text-decoration:none;color:inherit}
.gallery img{width:100%;height:150px;object-fit:cover;display:block}.gallery span{display:block;padding:6px 8px;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.intro{margin:0 0 16px}.empty{padding:30px;text-align:center;color:var(--muted)}footer{max-width:980px;margin:0 auto;padding:0 16px 30px;font-size:12.5px;color:var(--muted)}
`;

function page(title: string, body: string, opts: { root: string; script?: string; nav?: boolean }): string {
  const scriptHash = opts.script ? `'sha256-${createHash('sha256').update(opts.script).digest('base64')}'` : "'none'";
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src ${scriptHash}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><h1>${esc(title)}</h1>${opts.nav === false ? '' : `<nav><a href="${opts.root}index.html">Wszystkie rozmowy</a><a href="${opts.root}galeria.html">Galeria zdjęć</a></nav>`}</header>
${body}
<footer>Archiwum rozmów ChatGPT · wygenerowano ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</footer>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`;
}

const ROLE: Record<string, string> = { user: 'Ty', assistant: 'ChatGPT', system: 'System', tool: 'Narzędzie' };
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const rel = (p: string) => encodeURI(p).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/#/g, '%23').replace(/\?/g, '%3F');

/** One conversation. `savedFiles`: fileId → path relative to the conversation folder. `rootRel`: path back to the archive root. */
export function conversationHtml(conv: NormalizedConversation, savedFiles: Record<string, string>, rootRel: string): string {
  const msgs = conv.messages.map((m) => {
    const text = m.text.replace(/attachment:([A-Za-z0-9_-]+)/g, (_s, id: string) => (savedFiles[id] ? rel(savedFiles[id]) : '#'));
    const listed = m.files.filter((f) => !m.text.includes(`attachment:${f.fileId}`));
    const files = listed.length
      ? `<ul class="files">${listed.map((f) => {
          const p = savedFiles[f.fileId];
          if (!p) return `<li>${esc(f.name)} <span class="muted">(nie pobrano)</span></li>`;
          return IMAGE_EXT.test(p)
            ? `<li><a class="img" href="${rel(p)}" target="_blank"><img src="${rel(p)}" alt="${esc(f.name)}" loading="lazy"></a></li>`
            : `<li>📎 <a href="${rel(p)}" target="_blank">${esc(f.name)}</a></li>`;
        }).join('')}</ul>`
      : '';
    const who = [ROLE[m.role] ?? m.role, fmtTime(m.createdAt), m.model ?? ''].filter(Boolean).map((x) => esc(x)).join(' · ');
    return `<article class="msg ${m.role}" id="m-${esc(m.id)}"><div class="who">${who}</div>${renderMarkdown(text)}${files}</article>`;
  }).join('\n');
  const intro = `<p class="intro muted">Utworzona ${esc(fmtTime(conv.createdAt))} · ostatnia zmiana ${esc(fmtTime(conv.updatedAt))} · ${conv.messages.length} wiadomości${conv.branchCount > 1 ? ` · ${conv.branchCount} gałęzie (pokazana widoczna w ChatGPT)` : ''}</p>`;
  return page(conv.title, `<main>${intro}${msgs || '<p class="empty">Brak wiadomości.</p>'}</main>`, { root: rootRel });
}

export interface HtmlIndexItem {
  title: string;
  href: string;            // relative to the archive root
  updatedAt: string | null;
  createdAt: string | null;
  messages: number;
  images: string[];        // relative to the archive root
  searchText: string;      // lower-cased text for full-text search (trimmed)
}

const INDEX_SCRIPT = `(()=>{const q=document.getElementById('q'),y=document.getElementById('y'),full=document.getElementById('full'),cnt=document.getElementById('cnt');
const items=[...document.querySelectorAll('.conv')];const run=()=>{const t=q.value.trim().toLowerCase(),yy=y.value;let n=0;
for(const el of items){const hay=(full.checked?el.dataset.text:el.dataset.title)||'';const ok=(!t||hay.includes(t))&&(!yy||el.dataset.year===yy);el.hidden=!ok;if(ok)n++;}
cnt.textContent=n+' z '+items.length;};q.addEventListener('input',run);y.addEventListener('change',run);full.addEventListener('change',run);run();})();`;

export function indexHtml(items: HtmlIndexItem[], workspace?: string): string {
  const years = [...new Set(items.map((i) => (i.updatedAt ?? '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const list = items.map((i) => {
    const thumb = i.images[0] ? `<img class="thumb" src="${rel(i.images[0])}" alt="" loading="lazy">` : '<div class="noimg">💬</div>';
    const meta = [`${i.messages} wiadomości`, i.images.length ? `${i.images.length} zdjęć` : '', `zmiana ${fmtTime(i.updatedAt)}`].filter(Boolean).map(esc).join(' · ');
    return `<a class="conv" href="${rel(i.href)}" data-title="${esc(i.title.toLowerCase())}" data-text="${esc((i.title + ' ' + i.searchText).toLowerCase())}" data-year="${esc((i.updatedAt ?? '').slice(0, 4))}">${thumb}<div><h2>${esc(i.title)}</h2><div class="meta">${meta}</div></div></a>`;
  }).join('\n');
  const body = `<main>
<p class="intro muted">${items.length} rozmów${workspace ? ` · obszar roboczy ${esc(workspace)}` : ''} · od najnowszej</p>
<div class="search"><input type="search" id="q" placeholder="Szukaj rozmowy…" autofocus>
<select id="y"><option value="">Wszystkie lata</option>${years.map((y) => `<option>${esc(y)}</option>`).join('')}</select>
<label><input type="checkbox" id="full"> szukaj też w treści</label><span id="cnt" class="muted"></span></div>
<div class="list">${list || '<p class="empty">Archiwum jest puste.</p>'}</div></main>`;
  return page('Archiwum rozmów ChatGPT', body, { root: '', script: INDEX_SCRIPT });
}

export function galleryHtml(items: HtmlIndexItem[]): string {
  const imgs = items.flatMap((i) => i.images.map((src) => ({ src, title: i.title, href: i.href })));
  const body = `<main><p class="intro muted">${imgs.length} zdjęć z ${items.filter((i) => i.images.length).length} rozmów · kliknij, aby otworzyć rozmowę</p>
<div class="gallery">${imgs.map((g) => `<a href="${rel(g.href)}" title="${esc(g.title)}"><img src="${rel(g.src)}" alt="" loading="lazy"><span>${esc(g.title)}</span></a>`).join('\n') || '<p class="empty">Brak zdjęć.</p>'}</div></main>`;
  return page('Galeria zdjęć', body, { root: '' });
}
