// Security tests for the HTML archive and the Markdown files. String.raw keeps every backslash exactly as written.
import { describe, expect, it } from 'vitest';
import { renderMarkdown, safeHref } from './html.js';
import { sanitizeMarkdown } from './markdown.js';

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

describe('Markdown files (VS Code preview, Obsidian)', () => {
  it('escape raw HTML and drop unsafe targets outside code, keep code and our markers', () => {
    const md = sanitizeMarkdown([
      `<img src="${UNC}"> tekst`, `![x](${UNC})`, '[k](file://evil/x)', `[ref]: ${UNC}`, '![r](https://evil.example/t.png)',
      '![ok](attachment:file_1)', '[dobry](https://example.com)', '`<b>kod</b>`',
      '```html', '<script>zostaje w bloku kodu</script>', '```', '<details><summary>reasoning</summary>', '</details>',
    ].join('\n'));
    expect(md).not.toMatch(/^<img|\]\(\\\\|\]\(file:|^\[ref\]: \\\\|!\[r\]\(https:/m);
    expect(md).toContain('&lt;img');
    expect(md).toContain('![ok](attachment:file_1)');
    expect(md).toContain('[dobry](https://example.com)');
    expect(md).toContain('`<b>kod</b>`');
    expect(md).toContain('<script>zostaje w bloku kodu</script>');
    expect(md).toContain('<details><summary>reasoning</summary>');
  });
});
