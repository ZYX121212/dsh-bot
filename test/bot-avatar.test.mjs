import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOT_SHAPES, BOT_TEMPLATES } from '../src/team-core.mjs';
const require = createRequire(import.meta.url);
const output = await build({ entryPoints: [fileURLToPath(new URL('../src/bot-avatar.jsx', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(require.resolve('react')).href, external: true })); } }] });
const { BotAvatar } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const bot = { id: 'consistent', name: 'Milo', avatar: { color: '#8B78D8', shape: 'circle' } };
const render = props => renderToStaticMarkup(React.createElement(BotAvatar, { bot, ...props }));
test('new Bot templates expose round-only characters', () => {
  assert.deepEqual(BOT_SHAPES, ['circle']);
  assert.ok(BOT_TEMPLATES.every(b => b.avatar.shape === 'circle'));
});
test('all legacy stored shapes render as real circles, not alternate silhouettes', () => {
  for (const shape of ['circle', 'square', 'diamond', 'hexagon', 'unrecognized']) {
    const markup = render({ bot: { ...bot, avatar: { ...bot.avatar, shape } } });
    assert.match(markup, /<circle class="db-avatar__sphere"[^>]*r="42"/);
    assert.match(markup, /<radialGradient/);
    assert.doesNotMatch(markup, /db-avatar--(?:square|diamond|hexagon)/);
  }
});
test('small avatars use a tighter circular view without adding exterior details', () => {
  assert.match(render({ size: 32 }), /viewBox="14 15 92 92"/);
  assert.match(render({ size: 112 }), /viewBox="0 0 120 120"/);
  assert.match(render({ size: 32 }), /class="db-avatar__interior" clip-path=/);
});
test('native expressions retain provenance, accessibility and still controls', () => {
  const markup = render({ decorative: false, still: true, presence: { state: 'waiting', label: '等待处理', source: 'snapshot' }, size: 120 });
  assert.match(markup, /data-bot-state="waiting"/); assert.match(markup, /data-bot-source="snapshot"/);
  assert.match(markup, /data-bot-motion="paused"/); assert.match(markup, /aria-label="Milo · 等待处理"/);
  assert.match(markup, /db-avatar__brows/);
});
test('every state is a single self-contained orb without external robot parts or decorations', () => {
  for (const state of ['idle', 'queued', 'thinking', 'researching', 'coding', 'writing', 'working', 'waiting', 'completed', 'error', 'stopped', 'offline']) {
    for (const group of [false, true]) {
      const markup = render({ size: 142, group, presence: { state, label: state } });
      assert.equal((markup.match(/class="db-avatar__sphere"/g) || []).length, 1);
      assert.match(markup, /class="db-avatar__interior" clip-path="url\(#[^"]+-boundary\)"/);
      assert.match(markup, /<clipPath[^>]*><circle cx="60" cy="61" r="42"/);
      assert.doesNotMatch(markup, /db-avatar__(?:antenna|hands|hand|accessories|companions|keyboard|magnifier|paper|pen|sparkles|question|glass|socket|shadow)/);
    }
  }
});
test('each Bot has a stable motion phase rather than synchronized random work', () => {
  const phase = html => html.match(/--db-avatar-phase:([^;]+)/)?.[1];
  assert.equal(phase(render()), phase(render()));
  assert.notEqual(phase(render()), phase(render({ bot: { ...bot, id: 'someone-else' } })));
  assert.match(render(), /data-bot-state="idle"/);
});
test('SVG lighting definition IDs are unique for multiple companions in one render', () => {
  const markup = renderToStaticMarkup(React.createElement('div', null, React.createElement(BotAvatar, { bot }), React.createElement(BotAvatar, { bot: { ...bot, id: 'two' }, group: true })));
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal((markup.match(/class="db-avatar__sphere"/g) || []).length, 2);
});
