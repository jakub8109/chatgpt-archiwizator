// Security tests for the HTML archive and the Markdown files. String.raw keeps every backslash exactly as written.
import { describe, expect, it } from 'vitest';
import { renderMarkdown, safeHref } from './html.js';


const UNC = String.raw`\\evil\share\a.png`;

describe('targets: only http(s), mailto, attachments/<file>', () => {
  it('refuses UNC, backslashes, encoded traversal, absolute and foreign schemes', () => {
    const bad = [UNC, String.raw`..\x`, String.raw`attachments\x.png`, '%5c%5cevil%5cx.png', '%2e%2e/x', 'attachments/%2e%2e/x.png',
      'attachments/..%2fx.png', '%2f%2fevil/x', '//evil/x', '/C:/x.png', 'file://evil/x', 'javascript:alert(1)', 'data:text/html,x',
      'conversations/a.html', 'attachments/sub/x.png', 'attachments/./x.png', '%zz'];
    for (const u of bad) expect(safeHref(u), u).toBeNull();
    expect(safeHref('attachments/file_1_a%20b.png')).toBe('attachments/file_1_a%20b.png');
    expect(safeHref('https://example.com/x?a=1')).toBe('https://example.com/x?a=1');
    expect(safeHref('mailto:a@b.pl')).toBe('mailto:a@b.pl');
  });
});

describe('HTML pages', () => {
  it('never emit an image or link to a UNC/remote/escaped target', () => {
    for (const md of [`![x](${UNC})`, `[k](${UNC})`, '![x](//evil/a.png)', '![x](file://evil/a.png)', '![x](%5c%5cevil%5ca.png)',
      '![x](https://evil.example/a.png)', '![x](attachments/%2e%2e/a.png)', '![x](attachments/a.svg)']) {
      const h = renderMarkdown(md);
      expect(h, md).not.toMatch(/<img|href="(file:|\/|%5c|\\)|src="https:/i);
    }
    expect(renderMarkdown('![x](attachments/file_1_a.png)')).toContain('<img src="attachments/file_1_a.png"');
  });

  it('alt text with URLs and attributes cannot break out of the img tag', () => {
    const h = renderMarkdown(String.raw`![x https://a.example y srcset=\\evil\a.png onerror=alert(1)](attachments/file_1_a.png)`);
    expect((h.match(/<img/g) || []).length).toBe(1);
    const tag = /<img [^>]*>/.exec(h)![0];
    expect(tag).toMatch(/^<img src="attachments\/file_1_a.png" alt="[^"]*" loading="lazy">$/);
    // text inside the quoted alt value is inert; nothing may appear as an attribute outside it
    expect(tag.replace(/alt="[^"]*"/, 'alt=""')).not.toMatch(/srcset=|onerror=|<a /);
  });

  it('autolinks never land inside generated tags', () => {
    const h = renderMarkdown('[opis https://x.example/a](https://y.example/b) i https://z.example/c');
    expect(h).not.toMatch(/href="[^"]*<a /);
    expect(h).toContain('href="https://z.example/c"');
  });
});

describe('Markdown files (VS Code preview, Obsidian): untrusted text is never interpreted', () => {
  const ATTACKS = [
    `<img src="${UNC}"> tekst`,
    '``x` <img src=x onerror=alert(1)>``',
    '```js`\n<img src=x onerror=alert(1)>\n```',
    '````\n````\n<img src=x>',                                     // tries to close our fence
    '> [r]: ' + UNC + '\n> ![x][r]',                               // reference definition inside a blockquote
    '- [r]:\n  ' + UNC + '\n\n![x][r]',                            // destination on the next line, inside a list
    `![x](${UNC})`, '[x](&#92;&#92;evil&#92;a.png)', '[x](<//evil/a.png>)', '![a [b]](//evil/x.png)',
    '[x](\n' + UNC + ')',                                           // destination after a line break
  ];

  it('the whole message text sits inside one fence it cannot close', async () => {
    const { toMarkdown, fenced } = await import('./markdown.js');
    const { normalizeConversation } = await import('./normalize.js');
    for (const attack of ATTACKS) {
      const conv = normalizeConversation({ id: 'c', title: 't', current_node: 'm', mapping: {
        m: { id: 'm', parent: null, children: [], message: { id: 'm', author: { role: 'user' }, content: { content_type: 'text', parts: [attack] } } } } });
      const md = toMarkdown(conv, {});
      const block = fenced(attack.trim());
      expect(md, attack).toContain(block);
      // nothing of the attack exists outside that block
      const outside = md.replace(block, '');
      expect(outside, attack).not.toMatch(/evil|<img|onerror|&#92;/);
      // the fence is strictly longer than any backtick run in the text, so CommonMark cannot close it early
      const fence = block.split('\n')[0].replace('text', '');
      const longest = Math.max(0, ...[...attack.matchAll(/`+/g)].map((m) => m[0].length));
      expect(fence.length).toBeGreaterThan(longest);
      expect(fence.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('untrusted short strings outside the fence (title, file names) are fully escaped', async () => {
    const { mdEscape } = await import('./markdown.js');
    const e = mdEscape(`![x](${UNC}) <img src=x> [r]: //evil`);
    expect(e).not.toMatch(/(^|[^\\])[!\[\]()<>]/);   // every such character is backslash-escaped
  });
});
