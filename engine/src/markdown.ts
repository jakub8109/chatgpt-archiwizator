import type { NormalizedConversation } from './types.js';

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
    const text = m.text.replace(/attachment:([A-Za-z0-9_-]+)/g, (_s, id: string) => (savedFiles[id] ? linkTo(savedFiles[id]) : `#brak-pliku-${id}`));
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
