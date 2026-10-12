import { safeHref } from './html.js';
import type { NormalizedConversation } from './types.js';

const REASONING = new Set(['<details><summary>reasoning</summary>', '</details>']);   // our own markers (normalize.ts)

/**
 * Conversation text is untrusted, and Markdown viewers (VS Code preview, Obsidian) render images and raw HTML.
 * Outside code blocks/spans: raw HTML is escaped, and link/image targets (inline and reference-style) must pass
 * safeHref; images only from this archive. Our own `attachment:<id>` placeholders are kept for later resolution.
 */
export function sanitizeMarkdown(text: string): string {
  const out: string[] = [];
  let inFence: string | null = null;
  for (const line of text.split('\n')) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (inFence) { out.push(line); if (fence && line.trim().startsWith(inFence)) inFence = null; continue; }
    if (fence) { inFence = fence[1]; out.push(line); continue; }
    if (REASONING.has(line.trim())) { out.push(line); continue; }
    // reference-style definitions: [id]: target
    const def = /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
    if (def) { out.push(safeHref(def[2]) ? line : `${def[1].replace('[', '\\[')}(usunięto niebezpieczny adres)`); continue; }
    // split off inline code spans so they stay verbatim
    out.push(line.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : cleanSegment(seg))).join(''));
  }
  return out.join('\n');
}

function cleanSegment(seg: string): string {
  seg = seg.replace(/</g, '&lt;');
  return seg.replace(/(!?)\[([^\]]*)\]\(([^)\s]*)([^)]*)\)/g, (all, bang: string, label: string, target: string) => {
    if (/^attachment:[A-Za-z0-9_-]+$/.test(target)) return all;                        // ours, resolved below
    const h = safeHref(target);
    if (bang) return h && !/^(https?:|mailto:)/i.test(h) ? `![${label}](${h})` : `[obraz: ${label || 'bez opisu'}]`;
    return h ? `[${label}](${h})` : `${label} (usunięto niebezpieczny link)`;
  });
}

/** Link target safe for Markdown: encodeURI keeps ( ) which would end the link early. */
const linkTo = (p: string) => encodeURI(p).replace(/\(/g, '%28').replace(/\)/g, '%29');

const ROLE_LABEL: Record<string, string> = { user: 'Użytkownik', assistant: 'ChatGPT', system: 'System', tool: 'Narzędzie' };

function yamlStr(s: string): string {
  return JSON.stringify(s);   // JSON strings are valid YAML scalars
}

/**
 * Markdown for one conversation. `savedFiles` maps fileId -> path relative to the conversation folder
 * (only files that were actually downloaded); other references are kept as a visible note.
 */
export function toMarkdown(conv: NormalizedConversation, savedFiles: Record<string, string> = {}): string {
  const fm = [
    '---',
    `source: chatgpt`,
    `conversation_id: ${yamlStr(conv.id)}`,
    `title: ${yamlStr(conv.title)}`,
    `created: ${conv.createdAt ?? 'null'}`,
    `updated: ${conv.updatedAt ?? 'null'}`,
    `model: ${conv.model ? yamlStr(conv.model) : 'null'}`,
    `messages: ${conv.messages.length}`,
    `branches: ${conv.branchCount}`,
    `archived: ${conv.archived}`,
    `url: ${yamlStr('https://chatgpt.com/c/' + conv.id)}`,
    '---',
    '',
    `# ${conv.title.replace(/\n/g, ' ')}`,
    '',
  ];
  if (conv.branchCount > 1) {
    fm.push(`> Rozmowa ma ${conv.branchCount} gałęzie (edytowane/regenerowane odpowiedzi). Poniżej gałąź widoczna w ChatGPT; wszystkie są w \`raw.json\`.`, '');
  }

  const body: string[] = [];
  for (const m of conv.messages) {
    const label = ROLE_LABEL[m.role] ?? m.role;
    // local wall-clock time (the ISO/UTC timestamps stay in metadata.json and the front matter)
    const local = m.createdAt ? new Date(m.createdAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : null;
    const meta = [local, m.model].filter(Boolean).join(' · ');
    // message boundary: a rule + bold author line (headings inside answers stay untouched and never look like a new message)
    body.push('---', '', `<a id="msg-${m.id.replace(/[^A-Za-z0-9_-]/g, '')}"></a>**${label}**${meta ? ` · ${meta}` : ''}`, '');
    const text = sanitizeMarkdown(m.text).replace(/attachment:([A-Za-z0-9_-]+)/g, (_s, id: string) => (savedFiles[id] ? linkTo(savedFiles[id]) : `#brak-pliku-${id}`));
    body.push(text, '');
    const listed = m.files.filter((f) => !m.text.includes(`attachment:${f.fileId}`));
    if (listed.length) {
      body.push('**Załączniki:**', '');
      for (const f of listed) {
        const label = f.name.replace(/[[\]\\]/g, '\\$&');
        body.push(savedFiles[f.fileId] ? `- [${label}](${linkTo(savedFiles[f.fileId])})` : `- ${label} _(nie pobrano)_`);
      }
      body.push('');
    }
  }
  return fm.concat(body).join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
