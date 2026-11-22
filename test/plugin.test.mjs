import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { apply as readonly } from '../src/readonly.js';
import { apply as host, inject as hostInject } from '../src/index.js';

test('host face mounts only the authenticated metadata service through native Typert gateway', () => {
  assert.equal(typeof host, 'function');
  assert.deepEqual(hostInject, ['typertGateway']);
});

test('readonly guard denies tool calls in its mounting context and releases on disposal', () => {
  let guard, disposed = false, effect;
  readonly({ effect(fn) { effect = fn(); }, tools: { guard(fn) { guard = fn; return () => { disposed = true; }; } } });
  assert.match(guard({ name: 'bash' }), /Tool execution is disabled/);
  assert.match(guard({ name: 'send_message' }), /text-only/);
  effect();
  assert.equal(disposed, true);
});

test('built lazy-CJS artifact only registers factory before materialization, then mounts additive slots', async () => {
  const registrations = [], styles = [], cleanups = [];
  let definition;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { createElement() { return { dataset: {}, remove() { styles.pop(); } }; }, head: { append(value) { styles.push(value); } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask
  });
  new vm.Script(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')).runInContext(context);
  assert.equal(definition.id, 'dsh-bot');
  assert.equal(styles.length, 0, 'Factory registration must have no CSS side effects');
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return { createElement() {}, useState() {}, useRef() {}, useEffect() {} }; });
  const ctx = {
    sessions: {}, layout: {},
    effect(fn) { cleanups.push(fn()); },
    slots: { inject(name, fn) { fn(); }, register(options, Component) { registrations.push({ options, Component }); return () => {}; } }
  };
  plugin.apply(ctx);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].options.name, 'main');
  assert.equal(registrations[0].options.key, 'dsh-bot');
  assert.equal(registrations[1].options.name, 'sidebar.panellist');
  assert.equal(registrations[1].options.id, 'dsh-bot');
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /prefers-reduced-motion/);
  for (const off of cleanups) off?.();
  assert.equal(styles.length, 0);
});

test('managed bundle keeps only a scoped v1 readonly compatibility preset and declares the native client services', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: preset-dsh-bot/);
  assert.match(patch, /id: dsh-bot-readonly\n\s+name: dsh-bot\/readonly/);
  assert.match(patch, /complete: true/);
  assert.match(patch, /includeRuntimeContext: false/);
  assert.doesNotMatch(patch, /name: ['"]?@deepseek-ai\/dsh-tool-/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./readonly'], './lib/readonly.js');
  assert.equal(pkg.exports['./host'], './lib/host-service.js');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-session'));
  const runtime = await readFile(new URL('../src/team-controller.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /agentPreset: 'standard'/);
  assert.doesNotMatch(runtime, /agentPreset: 'dsh-bot'/);
  assert.equal(pkg.engines.dsh, '0.2.2-rc.1');
  assert.equal(pkg.dependencies, undefined, 'No additional production dependencies');
});
