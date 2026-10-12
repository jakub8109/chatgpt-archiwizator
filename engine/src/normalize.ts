import type { FileRef, NormalizedConversation, NormalizedMessage, RawConversation, RawMessage, RawNode } from './types.js';

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

export function isoFromUnix(t: number | null | undefined): string | null {
  if (t === null || t === undefined || !Number.isFinite(t) || t <= 0) return null;
  return new Date(t * 1000).toISOString();
}

/** File ids come from untrusted data (API / export) and end up in file names: only [A-Za-z0-9_-], max 80. */
export function safeFileId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** file-service://file-abc123 or sediment://file_abc → file id */
export function fileIdFromPointer(pointer: string): string | null {
  const m = /^(?:file-service|sediment):\/\/(.+)$/.exec(pointer);
  return m ? safeFileId(m[1]) : null;
}

/** Text of a message plus any files it references. Unknown content types are kept as fenced JSON, never dropped. */
export function messageText(msg: RawMessage): { text: string; files: FileRef[] } {
  const c = msg.content ?? { content_type: 'text' };
  const files: FileRef[] = [];
  const out: string[] = [];

  for (const a of msg.metadata?.attachments ?? []) {
    const fid = safeFileId(a?.id);
    if (fid) files.push({ fileId: fid, name: typeof a.name === 'string' && a.name ? a.name : fid, mime: a.mime_type, size: a.size, messageId: msg.id });
  }

  switch (c.content_type) {
    case 'text':
    case 'multimodal_text':
      for (const p of c.parts ?? []) {
        if (typeof p === 'string') {
          if (p.length) out.push(p);
        } else if (p && typeof p === 'object') {
          const part = p as Record<string, unknown>;
          const ptr = typeof part.asset_pointer === 'string' ? fileIdFromPointer(part.asset_pointer) : null;
          if (ptr) {
            if (!files.some((f) => f.fileId === ptr)) {
              files.push({ fileId: ptr, name: `${ptr}.png`, mime: 'image/png', size: Number(part.size_bytes) || undefined, messageId: msg.id });
            }
            out.push(`![image](attachment:${ptr})`);   // resolved to the saved file path in markdown.ts
          } else if (typeof part.text === 'string') {
            out.push(part.text);
          } else {
            out.push('```json\n' + JSON.stringify(part, null, 2) + '\n```');
          }
        }
      }
      break;
    case 'code':
      out.push('```' + (c.language && c.language !== 'unknown' ? c.language : '') + '\n' + (c.text ?? '') + '\n```');
      break;
    case 'execution_output':
      out.push('```\n' + (c.text ?? '') + '\n```');
      break;
    case 'tether_quote':
    case 'tether_browsing_display':
      if (c.text || c.result) out.push('> ' + String(c.text ?? c.result).replace(/\n/g, '\n> '));
      break;
    case 'thoughts':
    case 'reasoning_recap':
      // model-internal reasoning summaries: kept, but marked
      if (Array.isArray(c.parts) && c.parts.length) out.push('<details><summary>reasoning</summary>\n\n' + c.parts.map(String).join('\n') + '\n</details>');
      else if (c.text) out.push('<details><summary>reasoning</summary>\n\n' + c.text + '\n</details>');
      break;
    default:
      if (c.text) out.push(c.text);
      else if (Array.isArray(c.parts) && c.parts.length) out.push(c.parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n'));
  }
  // web-search citation tokens (citeturn0search1) and other private-use markers are not readable text
  const text = out.join('\n\n').replace(/[^]*/g, '').replace(/[-]/g, '').trim();
  return { text, files };
}

/** Path root → leaf for the branch the user last saw (current_node), falling back to the newest leaf. */
export function visiblePath(mapping: Record<string, RawNode>, currentNode?: string | null): RawNode[] {
  let leafId = currentNode && mapping[currentNode] ? currentNode : null;
  if (!leafId) {
    let best: { id: string; t: number } | null = null;
    for (const n of Object.values(mapping)) {
      if (n.children && n.children.length) continue;
      const t = n.message?.create_time ?? 0;
      if (!best || t >= best.t) best = { id: n.id, t };
    }
    leafId = best?.id ?? null;
  }
  const path: RawNode[] = [];
  const seen = new Set<string>();
  let cur = leafId ? mapping[leafId] : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parent ? mapping[cur.parent] : undefined;
  }
  return path.reverse();
}

export function countBranches(mapping: Record<string, RawNode>): number {
  let leaves = 0;
  for (const n of Object.values(mapping)) if (!n.children || n.children.length === 0) leaves++;
  return Math.max(1, leaves);
}

export function normalizeConversation(raw: RawConversation): NormalizedConversation {
  const id = raw.conversation_id || raw.id;
  if (!id) throw new Error('conversation without id');
  const messages: NormalizedMessage[] = [];
  const files: FileRef[] = [];
  let model: string | undefined;

  for (const node of visiblePath(raw.mapping || {}, raw.current_node)) {
    const m = node.message;
    if (!m || !m.author || !ROLES.has(m.author.role)) continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    const { text, files: f } = messageText(m);
    // empty system scaffolding is noise; empty user/assistant turns with files are kept
    if (!text && f.length === 0) continue;
    if (m.author.role === 'system' && !text) continue;
    if (m.metadata?.model_slug && m.author.role === 'assistant') model = m.metadata.model_slug;
    messages.push({
      id: m.id,
      role: m.author.role as NormalizedMessage['role'],
      authorName: m.author.name || undefined,
      createdAt: isoFromUnix(m.create_time),
      model: m.author.role === 'assistant' ? (m.metadata?.model_slug as string | undefined) : undefined,
      text,
      files: f,
    });
    for (const x of f) if (!files.some((y) => y.fileId === x.fileId)) files.push(x);
  }

  return {
    id,
    title: (raw.title || '').trim() || 'Bez tytułu',
    createdAt: isoFromUnix(raw.create_time),
    updatedAt: isoFromUnix(raw.update_time),
    updateTime: raw.update_time ?? null,
    model: model || raw.default_model_slug || undefined,
    gizmoId: raw.gizmo_id || undefined,
    archived: Boolean(raw.is_archived),
    messages,
    branchCount: countBranches(raw.mapping || {}),
    files,
  };
}
