import { describe, expect, it } from 'vitest';
import { conversationHtml, indexHtml, renderMarkdown } from './html.js';
import { normalizeConversation } from './normalize.js';

describe('html is safe', () => {
  it('escapes injected markup and drops dangerous links', () => {
    const h = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(2)>\n[klik](javascript:alert(3)) ![x](https://evil.example/t.png) [p](../../etc/passwd)');
    // injected markup may stay visible as text, but never as a tag or a live attribute/link
    expect(h).not.toMatch(/<script|<img src=x|<[^>]*onerror=|href="javascript:|src="https:\/\/evil|href="\.\.\//);
    expect(h).toContain('&lt;script&gt;');
  });
  it('renders the markdown subset', () => {
    const h = renderMarkdown('# Tytuł\n\n**gruby** i `kod`\n\n```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n![foto](attachments/f1_a%20b.png) https://example.com/a?b=1&c=2');
    expect(h).toContain('<h3>Tytuł</h3>');
    expect(h).toContain('<strong>gruby</strong>');
    expect(h).toContain('<code>kod</code>');
    expect(h).toContain('<pre><code data-lang="ts">const a = 1 &lt; 2;</code></pre>');
    expect(h).toContain('<td>1</td>');
    expect(h).toContain('<ul><li>x</li><li>y</li></ul>');
    expect(h).toContain('<img src="attachments/f1_a%20b.png"');
    expect(h).toContain('href="https://example.com/a?b=1&amp;c=2"');
  });
  it('conversation page and index carry a strict CSP and escaped titles', () => {
    const conv = normalizeConversation({ id: 'c1', title: '<b>x</b>', current_node: 'u', create_time: 1, update_time: 2, mapping: {
      u: { id: 'u', parent: null, children: [], message: { id: 'u', author: { role: 'user' }, create_time: 1_759_000_000, content: { content_type: 'text', parts: ['hej'] } } } } });
    const page = conversationHtml(conv, {}, '../../../../');
    expect(page).toContain("default-src 'none'");
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(page).toContain('href="../../../../index.html"');
    const idx = indexHtml([{ title: '"><script>', href: 'conversations/a b/conversation.html', updatedAt: null, createdAt: null, messages: 1, images: [], searchText: '' }]);
    expect(idx).not.toContain('"><script>');
    expect(idx).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
});

import { shortName } from './importer.js';
import { messageText } from './normalize.js';

describe('names and markers', () => {
  it('keeps attachment names short with id and extension', () => {
    const id = 'file_00000000eda471fc8a50e992db56cb45';
    const n = shortName(`${id}_user-4dhCJhKXYocW4V3HT0bQAgD4__9dc2587f-5e77-4b60-9925-0d66f5140d52_48c18159-cccc-4029-b4bb-f802be02916f.png`, id);
    expect(n.length).toBeLessThanOrEqual(100);
    expect(n.startsWith(id + '_')).toBe(true);
    expect(n.endsWith('.png')).toBe(true);
    expect(shortName('file_a_x.png', 'file_a')).toBe('file_a_x.png');
  });
  it('removes web-search citation tokens', () => {
    const { text } = messageText({ id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['IP65 i -40…+105°C. \uE200cite\uE202turn211934search0\uE202turn211934search24\uE201 Dalej.'] } });
    expect(text).toBe('IP65 i -40…+105°C.  Dalej.');
  });
});

import { neutralize } from './importer.js';

describe('security review fixes', () => {
  it('never emits UNC, absolute or remote image/link targets', () => {
    for (const md of ['![x](\\evil\share\a.png)', '![x](//evil/a.png)', '![x](/C:/x.png)', '![x](file://evil/a.png)', '![x](%5c%5cevil%5ca.png)',
      '[k](\\evil\s)', '![x](attachments/../../x.png)', '![x](conversations/a.png)', '![x](attachments/a.svg)']) {
      const h = renderMarkdown(md);
      expect(h, md).not.toMatch(/<img|href="[\/]|href="file:|evil/);
    }
    expect(renderMarkdown('![x](attachments/file_1_a.png)')).toContain('<img src="attachments/file_1_a.png"');
  });
  it('neutralises active-content attachments', () => {
    expect(neutralize('file_1_page.html')).toBe('file_1_page.html.txt');
    expect(neutralize('file_1_logo.svg')).toBe('file_1_logo.svg.txt');
    expect(neutralize('file_1_foto.png')).toBe('file_1_foto.png');
    expect(fileNameFor({ fileId: 'file_1', name: 'x.HTM', messageId: 'm' })).toBe('file_1_x.HTM.txt');
    for (const bad of ['a.xht', 'a.SVG', 'a.exe', 'a.bat', 'a.ps1', 'a.lnk', 'a.jnlp', 'a.html ', 'noext']) expect(neutralize(bad), bad).toMatch(/\.txt$/);
    for (const ok of ['a.pdf', 'a.docx', 'a.JPG', 'a.csv', 'a.zip']) expect(neutralize(ok)).toBe(ok);
  });
});
import { fileNameFor } from './importer.js';

import { mkdtempSync as mk, writeFileSync as wf, readdirSync as rd } from 'node:fs';
import { tmpdir as td } from 'node:os';
import { join as jn } from 'node:path';
import { adoptSaved } from './importer.js';
describe('one rule for files already on disk', () => {
  it('renames an old active-content attachment before reuse', () => {
    const d = mk(jn(td(), 'adopt-'));
    wf(jn(d, 'file_9_page.html'), '<script>1</script>');
    expect(adoptSaved(d, rd(d), 'file_9')).toBe('file_9_page.html.txt');
    expect(rd(d)).toEqual(['file_9_page.html.txt']);
  });
});
