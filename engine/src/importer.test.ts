import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { fileNameFor, findSaved, importExport } from './importer.js';
import { toMarkdown } from './markdown.js';
import { normalizeConversation, safeFileId, visiblePath } from './normalize.js';
import { safeFileName, slugify, Store } from './store.js';
import type { RawConversation } from './types.js';

function conv(id: string, title: string, update = 1_760_000_000): RawConversation {
  // root -> sys -> user -> (assistant A [old branch], assistant B [current]) ; B has an image + attachment
  return {
    id, conversation_id: id, title, create_time: 1_759_000_000, update_time: update, current_node: 'b',
    mapping: {
      root: { id: 'root', parent: null, children: ['sys'], message: null },
      sys: { id: 'sys', parent: 'root', children: ['u'], message: { id: 'sys', author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
      u: { id: 'u', parent: 'sys', children: ['a', 'b'], message: {
        id: 'u', author: { role: 'user' }, create_time: 1_759_000_100,
        content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG1', size_bytes: 3 }, 'Co jest na zdjęciu?'] },
        metadata: { attachments: [{ id: 'file-DOC1', name: 'oferta.pdf', mime_type: 'application/pdf' }] } } },
      a: { id: 'a', parent: 'u', children: [], message: { id: 'a', author: { role: 'assistant' }, create_time: 1_759_000_150, content: { content_type: 'text', parts: ['stara odpowiedź'] } } },
      b: { id: 'b', parent: 'u', children: [], message: { id: 'b', author: { role: 'assistant' }, create_time: 1_759_000_200, content: { content_type: 'text', parts: ['Kot na ' + 'parapecie.'] }, metadata: { model_slug: 'gpt-4o' } } },
    },
  };
}

describe('normalize', () => {
  it('follows the visible branch and keeps roles, order and timestamps', () => {
    const c = normalizeConversation(conv('c1', 'Test'));
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c.messages[1].text).toBe('Kot na parapecie.');
    expect(c.messages[0].createdAt).toBe(new Date(1_759_000_100 * 1000).toISOString());
    expect(c.branchCount).toBe(2);
    expect(c.model).toBe('gpt-4o');
    expect(c.files.map((f) => f.fileId).sort()).toEqual(['file-DOC1', 'file-IMG1']);
  });

  it('falls back to the newest leaf without current_node', () => {
    const raw = conv('c2', 'x');
    raw.current_node = null;
    expect(visiblePath(raw.mapping).at(-1)!.id).toBe('b');
  });
});

describe('markdown', () => {
  it('has front matter, role headings and resolved attachment links', () => {
    const c = normalizeConversation(conv('c1', 'Wycena: "pompa" ciepła'));
    const md = toMarkdown(c, { 'file-IMG1': 'attachments/file-IMG1_x.png' });
    expect(md).toMatch(/^---\nsource: chatgpt\nconversation_id: "c1"\ntitle: "Wycena: \\"pompa\\" ciepła"/);
    expect(md).toMatch(/\*\*Użytkownik\*\* · \d{2}\.\d{2}\.2025, \d{2}:\d{2}/);
    expect(md).toContain('**ChatGPT** · ');
    expect(md.match(/^---$/gm)!.length).toBe(2 + 2);   // front matter + one rule per message
    expect(md).toContain('```text\nKot na parapecie.\n```');   // message text is inert (fenced)
    expect(md).toContain('(attachments/file-IMG1_x.png)');
    expect(md).toContain(String.raw`- oferta\.pdf _(nie pobrano)_`);
    expect(md).toContain('# Wycena' + String.raw`\: \"pompa\" ciepła`);
    const md2 = toMarkdown(c, { 'file-IMG1': 'attachments/file-IMG1_Wklejony tekst(1).png' });
    expect(md2).toContain('(attachments/file-IMG1_Wklejony%20tekst%281%29.png)');
    expect(md).not.toContain('stara odpowiedź');
  });
});

describe('store safety', () => {
  it('slugs and file names are safe', () => {
    expect(slugify('Żółć — łąka / test?')).toBe('zolc-laka-test');
    expect(safeFileName('../../etc/passwd', 'f')).toBe('_.._etc_passwd');
    expect(safeFileName('..', 'fallback')).toBe('fallback');
    const s = new Store(mkdtempSync(join(tmpdir(), 'kn-')));
    expect(() => s.abs('../outside')).toThrow();
  });
});

describe('untrusted file ids', () => {
  it('never become paths', () => {
    expect(safeFileId('../../other/x')).toBeNull();
    expect(safeFileId('file-ABC_1')).toBe('file-ABC_1');
    expect(() => fileNameFor({ fileId: '../../x', name: 'a.png', messageId: 'm' })).toThrow();
    expect(fileNameFor({ fileId: 'file-A', name: '../../evil.png', messageId: 'm' })).not.toMatch(/[\\/]/);
    const raw = conv('c9', 't');
    raw.mapping.u.message!.metadata = { attachments: [{ id: '../../../etc/passwd', name: 'x' }] };
    expect(normalizeConversation(raw).files.map((f) => f.fileId)).toEqual(['file-IMG1']);
  });
});

describe('attachments with shared id prefixes', () => {
  it('are never mistaken for each other', () => {
    const a = 'file_00000000c66c71fc9a1', b = 'file_00000000783471fca22';
    const saved = [fileNameFor({ fileId: a, name: 'x.png', messageId: 'm' })];
    expect(saved[0]).toBe(`${a}_x.png`);
    expect(findSaved(saved, a)).toBe(saved[0]);
    expect(findSaved(saved, b)).toBeUndefined();
    expect(findSaved(['file_1234_x.png'], 'file_123')).toBeUndefined();
  });
});

describe('official export import', () => {
  function makeZip(dir: string, convs: RawConversation[]): string {
    const z = new AdmZip();
    z.addFile('conversations.json', Buffer.from(JSON.stringify(convs)));
    z.addFile('file-IMG1-photo.png', Buffer.from([1, 2, 3]));
    z.addFile('file-DOC1-oferta.pdf', Buffer.from('%PDF-1.4'));
    const p = join(dir, 'export.zip');
    z.writeZip(p);
    return p;
  }

  it('imports, downloads attachments, and does not duplicate on re-import or rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exp-'));
    const root = join(dir, 'Knowledge');
    expect(await importExport(makeZip(dir, [conv('c1', 'Pierwsza'), conv('c2', 'Druga')]), root)).toBe(0);

    const store = new Store(root);
    expect(store.size).toBe(2);
    const e = store.entry('c1')!;
    const folder = join(root, 'ChatGPT', e.folder);
    expect(readdirSync(join(folder, 'attachments')).sort()).toEqual(['file-DOC1-oferta.pdf', 'file-IMG1-photo.png']);
    const md = readFileSync(join(folder, 'conversation.md'), 'utf8');
    expect(md).toContain('(attachments/file-IMG1-photo.png)');
    expect(md).toContain(String.raw`[oferta\.pdf](attachments/file-DOC1-oferta.pdf)`);
    expect(JSON.parse(readFileSync(join(folder, 'metadata.json'), 'utf8')).messages).toHaveLength(2);

    // same export again: everything skipped
    const runsBefore = readdirSync(join(root, 'ChatGPT', 'runs')).length;
    expect(await importExport(makeZip(dir, [conv('c1', 'Pierwsza'), conv('c2', 'Druga')]), root)).toBe(0);
    const lastRun = readdirSync(join(root, 'ChatGPT', 'runs')).sort().at(-1)!;
    const done = readFileSync(join(root, 'ChatGPT', 'runs', lastRun), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.event === 'done');
    expect(readdirSync(join(root, 'ChatGPT', 'runs')).length).toBe(runsBefore + 1);
    expect(done).toMatchObject({ saved: 0, skipped: 2, failed: 0 });

    // renamed + updated conversation: same folder, new title, no second copy
    expect(await importExport(makeZip(dir, [conv('c1', 'Nowy tytuł', 1_770_000_000)]), root)).toBe(0);
    const s2 = new Store(root);
    expect(s2.size).toBe(2);
    expect(s2.entry('c1')!.folder).toBe(e.folder);
    expect(readFileSync(join(folder, 'conversation.md'), 'utf8')).toContain('# Nowy tytuł');
    expect(existsSync(join(root, 'ChatGPT', '.lock'))).toBe(false);
  });
});
