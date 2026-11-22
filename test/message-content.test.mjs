import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const output = await build({ entryPoints: [fileURLToPath(new URL('../src/message-content.jsx', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(require.resolve('react')).href, external: true })); } }] });
const { default: MessageContent, MessageContent: NamedMessageContent } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const render = props => renderToStaticMarkup(React.createElement(MessageContent, props));

test('default/named export renders semantic subset with isolated root', () => {
  assert.equal(MessageContent, NamedMessageContent);
  const markup = render({ text: '# Heading\n\n**Strong** and `code`\n- One\n- Two\n4. Four\n> Quote' });
  assert.match(markup, /class="dt-message-markdown"/);
  assert.match(markup, /<h1>Heading<\/h1>/);
  assert.match(markup, /<strong>Strong<\/strong>/);
  assert.match(markup, /<code class="dt-md-inline-code">code<\/code>/);
  assert.match(markup, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(markup, /<ol start="4"><li value="4">Four<\/li><\/ol>/);
  assert.match(markup, /<blockquote><p>Quote<\/p><\/blockquote>/);
});

test('HTML, scripts, SVG and external image Markdown can never create active elements', () => {
  const markup = render({ text: '<script>alert(1)</script>\n<svg onload="alert(1)"></svg>\n<img src="https://evil.example/pixel" onerror="alert(1)">\n![pixel](https://evil.example/pixel)\n[bad](javascript:alert(1))' });
  assert.doesNotMatch(markup, /<(?:script|svg|img|iframe|object|style)\b/i);
  assert.doesNotMatch(markup, /href="(?:javascript|data|file):/i);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;svg onload=&quot;alert\(1\)&quot;&gt;/);
});

test('links protect opener and suppress referrer; labels are React-escaped', () => {
  const markup = render({ text: '[<b>docs</b>](https://example.com/?x=1&y=2)' });
  assert.match(markup, /href="https:\/\/example.com\/\?x=1&amp;y=2"/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/);
  assert.match(markup, /&lt;b&gt;docs&lt;\/b&gt;/);
});

test('code remains exact escaped text, keyboard scrollable, with accessible copy action', () => {
  const code = '\t<script>x</script>  \n\n';
  const markup = render({ text: `\`\`\`html\n${code}\`\`\``, onCopy() {} });
  assert.match(markup, /<button type="button" aria-label="复制代码">复制代码<\/button>/);
  assert.match(markup, /<pre tabindex="0" role="region" aria-label="html 代码块"><code>\t&lt;script&gt;x&lt;\/script&gt;  \n\n<\/code><\/pre>/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(render({ text: '```\nx' }), /aria-label="复制代码" disabled=""/);
});

test('copy action forwards precisely the raw code to its parent, once per activation', () => {
  const code = '\t a  \r\n\r\n', copied = [];
  function Probe() {
    const tree = MessageContent({ text: `\`\`\`text\r\n${code}\`\`\``, onCopy: value => copied.push(value) });
    const visit = node => {
      if (!React.isValidElement(node)) return;
      if (node.type === 'button') node.props.onClick();
      React.Children.forEach(node.props.children, visit);
    };
    visit(tree);
    return tree;
  }
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual(copied, [code]);
});

test('streaming open fence renders the same code container and no language classes from input', () => {
  const markup = render({ text: '```"><img\n  const x = 1;\n' });
  assert.match(markup, /class="dt-md-code-block"/);
  assert.match(markup, /<code>  const x = 1;\n<\/code>/);
  assert.doesNotMatch(markup, /<img|language-/);
});
