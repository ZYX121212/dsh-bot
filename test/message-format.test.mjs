import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, parseInline, safeHttpUrl } from '../src/message-format.mjs';

const plain = nodes => nodes.map(node => node.children ? plain(node.children) : node.text).join('');
const links = nodes => nodes.flatMap(node => [ ...(node.type === 'link' ? [node] : []), ...(node.children ? links(node.children) : []) ]);

test('paragraphs, modest semantic headings and single newlines remain readable', () => {
  const blocks = parseMessage('# Hello **team**\n\nFirst line\nsecond line\n\n###### Small heading ##');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].children[1].type, 'strong');
  assert.equal(plain(blocks[1].children), 'First line\nsecond line');
  assert.equal(blocks[2].level, 6);
  assert.equal(plain(blocks[2].children), 'Small heading');
  assert.equal(plain(parseMessage('# C#')[0].children), 'C#');
});

test('ordered/unordered lists keep numbers and adjacent quotes stay together', () => {
  const blocks = parseMessage('- first\n* **second**\n3. three\n5) five\n> quote `x`\n>\n> next');
  assert.deepEqual(blocks.map(block => block.type), ['list', 'list', 'quote']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].start, 3);
  assert.deepEqual(blocks[1].items.map(item => item.value), [3, 5]);
  assert.equal(plain(blocks[2].children), 'quote x\n\nnext');
});

test('fenced code preserves exact whitespace, CRLF, blank lines and literal markup', () => {
  const code = '\tconst value = "<img src=x>";  \r\n\r\n  **literal**\r\n';
  const blocks = parseMessage(`Before\r\n\r\n\`\`\`js\r\n${code}\`\`\`\r\nAfter`);
  assert.equal(blocks[1].type, 'code');
  assert.equal(blocks[1].text, code);
  assert.equal(blocks[1].language, 'js');
  assert.equal(blocks[1].closed, true);
  assert.equal(plain(blocks[2].children), 'After');
});

test('unterminated streaming fences retain all received characters and settle on close', () => {
  for (const suffix of ['', 'x', '\n', '\tlet n = 1;  \n', '\n\n', '```partial']) {
    const blocks = parseMessage(`~~~ts\n${suffix}`);
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].text, suffix);
    assert.equal(blocks[0].closed, false);
  }
  assert.equal(parseMessage('```\n')[0].text, '');
  assert.equal(parseMessage('```')[0].closed, false);
  assert.equal(parseMessage('~~~\nx\n~~~~\n')[0].closed, true);
  const longer = parseMessage('````js\n```\nx\n````\n')[0];
  assert.equal(longer.text, '```\nx\n');
});

test('wrong fence markers, short markers and nonempty closing lines stay code', () => {
  const code = parseMessage('```js\nx\n~~~\n``\n```more\n```')[0];
  assert.equal(code.text, 'x\n~~~\n``\n```more\n');
  assert.equal(code.closed, true);
});

test('inline code is exact, strong can contain code and link labels can be strong', () => {
  const nodes = parseInline('Use **a ` x  `** and [**docs**](https://example.com/a_(b)).');
  assert.equal(nodes[1].type, 'strong');
  assert.equal(nodes[1].children[1].text, ' x  ');
  assert.equal(links(nodes)[0].href, 'https://example.com/a_(b)');
  assert.equal(links(nodes)[0].children[0].type, 'strong');
  assert.equal(parseInline('``a ` b``')[0].text, 'a ` b');
  assert.equal(plain(parseInline('\\**literal\\**')), '**literal**');
});

test('only validated absolute HTTP(S) destinations become anchors', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//example.com', '/relative', 'https://', 'https://example.com\\evil', 'https://exam\nple.com', '\u0000https://example.com']) assert.equal(safeHttpUrl(value), null, value);
  assert.equal(safeHttpUrl('HTTPS://example.com/a?x=1&y=2'), 'https://example.com/a?x=1&y=2');
  const unsafe = '[bad](javascript:alert(1)) and [data](data:text/html,evil)';
  assert.equal(links(parseInline(unsafe)).length, 0);
  assert.equal(plain(parseInline(unsafe)), unsafe);
  const nodes = parseInline('See https://example.com/test. [Docs](http://example.org)');
  assert.equal(links(nodes).length, 2);
  assert.equal(plain(nodes), 'See https://example.com/test. Docs');
});

test('unsupported Markdown and HTML remain inert readable text', () => {
  const source = '<script>alert(1)</script>\n<img src="https://evil.example/pixel">\n![tracking](https://evil.example/pixel)\n| a | b |\n~~no strike~~ and *no emphasis*';
  const blocks = parseMessage(source);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(plain(blocks[0].children), source);
  assert.ok(blocks.every(block => !['html', 'image'].includes(block.type)));
});

test('empty, null and partial delimiters are safe and lossless', () => {
  assert.deepEqual(parseMessage(null), []);
  assert.deepEqual(parseMessage(' \n\t\n'), []);
  for (const source of ['[unfinished', '**unfinished', '`unfinished', '##', '[x](https://', '***', '```js\n\t']) {
    const blocks = parseMessage(source);
    assert.ok(blocks.length > 0);
    if (blocks[0].type !== 'code') assert.equal(plain(blocks[0].children), source);
  }
});

test('malformed long inline inputs fall back without losing text or recursing deeply', { timeout: 2500 }, () => {
  for (const source of ['['.repeat(100000), '*x'.repeat(50000), '`'.repeat(20000) + 'x' + '`'.repeat(19999), '[x]('.repeat(15000)]) {
    assert.equal(plain(parseInline(source)), source);
  }
  const nested = '**[**[**[**[**[nested](https://a.test)**](https://a.test)**](https://a.test)**](https://a.test)**](https://a.test)**';
  assert.doesNotThrow(() => parseInline(nested));
});

test('block count budget preserves excess source as readable text', () => {
  const source = '# heading\n\n'.repeat(10002);
  const blocks = parseMessage(source);
  assert.equal(blocks.length, 10001);
  assert.equal(blocks.at(-1).type, 'paragraph');
  assert.ok(plain(blocks.at(-1).children).includes('# heading'));
});
