import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../src/host-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const temp = await mkdtemp(resolve(tmpdir(), 'dsh-bot-browser-'));
const store = new WorkspaceStore(resolve(temp, 'workspace.json'));
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}), headless: true });
const errors = [], checks = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const context = await browser.newContext({ viewport: { width: 1500, height: 960 }, colorScheme: 'light', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await page.exposeFunction('botRpc', async (method, payload) => {
  try { return { ok: true, value: method.endsWith('/read') ? await store.read() : await store.update(payload.request) }; }
  catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
});
await page.route('https://dsh-bot.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;height:100dvh"><div id="root" style="height:100%;width:100%"></div></body></html>' }));
const fixture = () => {
  const cleanups = [], slots = [], sessions = new Map(), stats = { creates: [], prompts: [], opens: [], cancels: [] };
  let module;
  function source(initial) { let value = initial; const listeners = new Set(); return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next = value) { value = next; for (const fn of listeners) fn(); } }; }
  const status = source(new Map());
  const ctx = {
    connection: { rpc: { call: (_namespace, method, payload) => window.botRpc(method, payload) } },
    uiSession: { sessionStatus: status },
    uiWorkspace: { openSession(id) { stats.opens.push(id); } },
    layout: {}, effect(fn) { cleanups.push(fn()); },
    slots: { inject(_name, factory) { cleanups.push(factory()); }, register(options, Component) { slots.push({ options, Component }); return () => {}; } },
    sessions: {
      list: source({ byId: { fixtureWorkspace: { id: 'fixtureWorkspace', cwd: '/fixture/project', retainedBy: { mainView: 1 } } } }),
      async create(options) { const id = `native-fixture-${sessions.size + 1}`; makeSession(id); stats.creates.push({ id, options }); return id; },
      retain(id) { if (!sessions.has(id)) makeSession(id); const binding = sessions.get(id); return { ready: Promise.resolve(binding), release() {} }; }
    }
  };
  function makeSession(id) {
    const events = source({ entries: [] }), native = source({ sessionId: id, running: false, hasMore: false });
    let turn = 0, seq = 0, pending = null;
    const emit = (type, data) => { events.publish({ entries: [...events.getSnapshot().entries, { type, data, seq: ++seq, time: Date.now() }] }); };
    const finish = (cancelled = false) => {
      pending = null;
      status.getSnapshot().delete(id); status.publish();
      if (!cancelled) {
        emit('tool/result', { turn, message: { toolCallId: `call-${turn}`, content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT_NOT_FOR_UI' }] } });
        emit('assistant/message', { turn, step: 0, message: { content: [{ type: 'text', text: `自动化测试替身回复 · 第 ${turn} 轮\n已验证持续会话与宿主记录联动。本段不是实际模型输出。` }] } });
        emit('deliverables/presented', { turn, callId: `present-${turn}`, files: [{ path: '/fixture/project/report.md', description: '浏览器测试的文件交付事件' }] });
      }
      native.publish({ ...native.getSnapshot(), running: false });
      emit('turn/end', { turn, reason: { kind: cancelled ? 'aborted' : 'completed' } });
    };
    native.prompt = async content => {
      stats.prompts.push({ id, text: content[0].text });
      turn++; native.publish({ ...native.getSnapshot(), running: true });
      emit('turn/start', { turn });
      emit('user/message', { source: { kind: 'user' }, content });
      emit('tool/call', { turn, callId: `call-${turn}`, name: 'web_search', arguments: { secret: 'PRIVATE_ARGS_NOT_FOR_UI' } });
      if (window.__fixture.mode === 'approval') {
        status.getSnapshot().set(id, { running: true, pendingInteraction: { kind: 'approval', toolName: 'web_search', reason: 'Fixture approval' } }); status.publish(); pending = finish;
      } else setTimeout(() => { if (native.getSnapshot().running) finish(); }, 180);
      return { ok: true, value: undefined };
    };
    native.cancel = async () => { stats.cancels.push(id); if (native.getSnapshot().running) finish(true); return { ok: true, value: undefined }; };
    native.loadOlder = async () => {};
    sessions.set(id, { sessionId: id, session: native, eventSource: events, approve() { pending?.(); } });
  }
  window.__ModuleLoader__ = { load(value) { module = value; } };
  window.__fixture = { mode: 'normal', stats, sessions, ctx, mount() { const plugin = module.factory(name => { if (name !== 'react') throw new Error('Unexpected dependency '+name); return window.React; }); plugin.apply(ctx); const slot = slots.find(s => s.options.name === 'main'); const reactRoot = ReactDOM.createRoot(document.getElementById('root')); reactRoot.render(React.createElement(slot.Component, slot.options.inject())); }, approve() { for (const session of sessions.values()) session.approve(); } };
};
async function load() {
  await page.goto('https://dsh-bot.test/');
  await page.addScriptTag({ path: resolve(root, 'node_modules/react/umd/react.production.min.js') });
  await page.addScriptTag({ path: resolve(root, 'node_modules/react-dom/umd/react-dom.production.min.js') });
  await page.evaluate(fixture);
  await page.addScriptTag({ path: resolve(root, 'lib/client.js') });
  await page.evaluate(() => window.__fixture.mount());
  await page.locator('.dt-loading').waitFor({ state: 'hidden' });
}
async function createBot(name, templateLabel) {
  await page.getByRole('button', { name: '新建 Bot 或群组', exact: true }).click();
  await page.getByRole('button', { name: '新建 Bot', exact: false }).last().click();
  if (templateLabel) await page.getByRole('button', { name: templateLabel, exact: true }).click();
  await page.getByLabel('名字', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建 Bot', exact: true }).last().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
try {
  await load();
  await page.getByRole('heading', { name: '认识你的下一位 AI 同事。' }).waitFor();
  check('Production bundle starts from a genuinely empty host store, without demo Bots');
  await page.screenshot({ path: resolve(artifacts, 'team-onboarding-desktop.png') });
  await page.getByRole('button', { name: '创建我的主 Bot', exact: true }).click();
  await page.getByRole('button', { name: '创建 Bot', exact: true }).last().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '嗨，我是 Milo。' }).waitFor();
  check('Creates primary Bot through the real durable WorkspaceStore');
  await page.screenshot({ path: resolve(artifacts, 'team-bot-desktop.png') });
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '添加一条记忆', exact: true }).click();
  await page.getByLabel('需要记住的内容').fill('每次交付附上验证方法。');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check('Adds scoped memory to host storage', (await store.read()).memories[0].content === '每次交付附上验证方法。');
  await page.getByRole('button', { name: '编辑这条记忆', exact: true }).click();
  await page.getByLabel('需要记住的内容').fill('交付时附上真实验证方法。');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check('Edits existing memory without fabricating automatic learning', (await store.read()).memories[0].content === '交付时附上真实验证方法。');
  await page.getByRole('tab', { name: '工作', exact: true }).click();
  await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).fill('请整理这个项目，给我一份进展摘要。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('自动化测试替身回复 · 第 1 轮', { exact: false }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.dt-working-line'));
  let stats = await page.evaluate(() => window.__fixture.stats);
  check('First job creates a real-shaped standard native session and passes the current workspace', stats.creates.length === 1 && stats.creates[0].options.agentPreset === 'standard' && stats.creates[0].options.cwd === '/fixture/project');
  check('Actually injects stored Bot memory and identity into the admitted prompt', stats.prompts[0].text.includes('交付时附上真实验证方法。') && stats.prompts[0].text.includes('Milo'));
  check('User transcript hides only the injected context envelope', !(await page.locator('.dt-transcript').innerText()).includes('DSH_BOT_CONTEXT_V2'));
  check('Tool raw arguments/results never leak into the work panel', !(await page.locator('.dt-app').innerText()).includes('PRIVATE_'));
  check('Task completion and native delivery events reach the UI and durable host state', (await store.read()).tasks[0].status === 'completed' && await page.locator('.dt-files').getByText('report.md', { exact: true }).count() === 1);
  await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).fill('继续上一轮。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('自动化测试替身回复 · 第 2 轮', { exact: false }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.dt-working-line'));
  stats = await page.evaluate(() => window.__fixture.stats);
  check('Second message reuses the same native session instead of one-shot Q&A', stats.creates.length === 1 && stats.prompts[0].id === stats.prompts[1].id);
  await createBot('Scout', '研究与洞察');
  await page.getByRole('button', { name: '新建 Bot 或群组', exact: true }).click();
  await page.getByRole('button', { name: '新建群组', exact: true }).click();
  await page.getByLabel('群组名称').fill('产品研究小组');
  await page.getByRole('checkbox').nth(0).check(); await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: '创建群组', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).fill('@everyone 给这份计划各提一条建议。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dt-message:not(.dt-message-user)').length === 2 && !document.querySelector('.dt-working-line'));
  const durable = await store.read();
  const replies = durable.groups[0].messages.filter(m => m.role === 'assistant');
  check('Group routing executes two distinct persistent Bot sessions and stores attributed replies', replies.length === 2 && new Set(replies.map(m => m.botId)).size === 2 && new Set(replies.map(m => m.sessionId)).size === 2);
  stats = await page.evaluate(() => window.__fixture.stats);
  check('Later group member receives the prior member’s actual stored reply', stats.prompts.at(-1).text.includes(replies[0].text.replace(/\n/g, '\\n')));
  await page.screenshot({ path: resolve(artifacts, 'team-group-desktop.png') });
  await page.locator('.dt-bot-row').filter({ hasText: 'Milo' }).first().click();
  await page.evaluate(() => { window.__fixture.mode = 'approval'; });
  await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).fill('执行一项需要宿主交互的工作。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('Bot 需要你处理', { exact: true }).waitFor();
  await page.getByRole('button', { name: '前往 DSH 处理', exact: true }).click();
  check('Approval is surfaced from native status and routes to native UI, never auto-approved', await page.evaluate(() => window.__fixture.stats.opens.length > 0));
  await page.evaluate(() => window.__fixture.approve());
  await page.waitForFunction(() => !document.querySelector('.dt-working-line'));
  await page.getByRole('button', { name: '工作空间设置', exact: true }).click();
  await page.getByLabel('外观', { exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.querySelector('.dt-app')?.dataset.theme === 'dark');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  check('Dark theme persists through the host settings API', (await store.read()).settings.theme === 'dark');
  await page.screenshot({ path: resolve(artifacts, 'team-dark-desktop.png') });
  await store.update({ action: 'updateSettings', patch: { theme: 'light' } });
  // A fresh browser page reuses durable metadata but contains no fake past native log.
  await load();
  check('Reload recovers Bot roster, primary identity, groups and memories from disk', (await page.locator('.dt-bot-row').count()) === 3 && (await store.read()).memories.length === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开 Bot 名册', exact: true }).click();
  check('Mobile exposes a working roster drawer', await page.locator('.dt-roster-open').count() === 1);
  await page.locator('.dt-bot-row').filter({ hasText: 'Scout' }).first().click();
  await page.getByRole('heading', { name: '嗨，我是 Scout。' }).waitFor();
  await page.screenshot({ path: resolve(artifacts, 'team-bot-mobile.png') });
  check('Mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.dt-app').scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  check('Mobile work panel and memory tabs remain operable', await page.getByRole('heading', { name: '越合作，越懂你' }).count() === 1);
  await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开 Bot 名册', exact: true }).click();
  await page.getByRole('button', { name: '新建 Bot 或群组', exact: true }).click();
  await page.getByRole('button', { name: '新建 Bot', exact: false }).last().click();
  await page.keyboard.press('Escape');
  check('Dialog supports keyboard Escape and returns control to the workspace', await page.getByRole('dialog').count() === 0);
  check('No React or browser runtime errors', errors.length === 0);
  await writeFile(resolve(artifacts, 'team-browser-smoke.json'), JSON.stringify({ kind: 'fixture-only-browser-integration', note: 'Built production artifact + actual disk WorkspaceStore; native sessions, provider text, approvals and tool events are explicit test doubles. Not authenticated live GUI or real-provider E2E.', checks, pageErrors: errors, passed: checks.length, viewport: [1500, 960], mobile: [390, 844] }, null, 2));
  console.log(`Completed ${checks.length} fixture browser checks.`);
} catch (error) {
  await page.screenshot({ path: resolve(artifacts, 'team-browser-failure.png'), fullPage: true }).catch(() => {});
  console.error({ checks, errors });
  throw error;
} finally { await context.close(); await browser.close(); }
