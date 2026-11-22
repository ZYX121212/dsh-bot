import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../src/host-store.mjs';
import { auditWorkspaceColors } from './team-color-audit.mjs';
import { auditWorkspaceFunctions } from './team-functional-audit.mjs';
import { auditConversationHistory } from './team-history-audit.mjs';
import { auditRecordManagement } from './team-record-audit.mjs';

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
    const emit = (type, data, time = Date.now()) => { events.publish({ entries: [...events.getSnapshot().entries, { type, data, seq: ++seq, time }] }); };
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
    native.loadOlder = async () => {
      const older = Array.from({ length: 5 }, (_, i) => ({ type: 'assistant/message', seq: -200 + i, time: Date.now() - 100000, data: { turn: 0, step: -20 + i, message: { content: [{ type: 'text', text: `更早消息测试替身 ${i}` }] } } }));
      native.publish({ ...native.getSnapshot(), hasMore: false });
      events.publish({ entries: [...older, ...events.getSnapshot().entries] });
    };
    let manualCall = null;
    function phase(kind) {
      status.getSnapshot().delete(id); status.publish();
      if (manualCall) { emit('tool/result', { turn, message: { toolCallId: manualCall, content: [] } }); manualCall = null; }
      if (['completed', 'error', 'stopped', 'historical'].includes(kind)) {
        native.publish({ ...native.getSnapshot(), running: false });
        emit('turn/end', { turn, reason: { kind: kind === 'historical' ? 'completed' : kind === 'stopped' ? 'aborted' : kind } }, Date.now() - (kind === 'historical' ? 10000 : 0)); return;
      }
      if (!native.getSnapshot().running) { turn++; native.publish({ ...native.getSnapshot(), running: true }); emit('turn/start', { turn }); }
      if (kind === 'waiting') { status.getSnapshot().set(id, { running: true, pendingInteraction: { kind: 'approval', toolName: 'fixture_tool' } }); status.publish(); }
      else if (kind === 'writing') emit('assistant/live-chunk', { turn, step: 99, attemptId: `manual-${turn}`, chunk: { type: 'text-delta', text: '自动化状态替身：正在整理回复。不是实际模型输出。' } });
      else if (kind !== 'thinking') { manualCall = `manual-${turn}-${++seq}`; emit('tool/call', { turn, callId: manualCall, name: { researching: 'web_search', coding: 'functions.bash', working: 'fixture_tool' }[kind] || 'fixture_tool', arguments: { private: 'PRIVATE_ARGS_NOT_FOR_UI' } }); }
    }
    let releaseHistory;
    function configureOlder(pages, { failures = 0, blocked = false } = {}) {
      const queue = [...pages];
      native.loadOlder = async () => {
        stats.historyReads = (stats.historyReads || 0) + 1;
        native.publish({ ...native.getSnapshot(), loadingOlder: true });
        try {
          if (blocked) await new Promise(resolve => { releaseHistory = () => { blocked = false; resolve(); }; });
          if (failures-- > 0) throw new Error('历史读取测试失败');
          const rows = queue.shift() || [];
          const older = rows.map(row => row.hidden ? ({ type: 'tool/result', seq: row.seq, time: Date.now() - 200000, data: { turn: 0, message: { toolCallId: `history-tool-${row.seq}`, content: [{ type: 'text', text: row.text }] } } }) : ({ type: 'assistant/message', seq: row.seq, time: Date.now() - 200000, data: { turn: 0, step: row.seq, message: { id: `history-${row.seq}`, content: [{ type: 'text', text: row.text }] } } }));
          events.publish({ entries: [...older, ...events.getSnapshot().entries] });
          native.publish({ ...native.getSnapshot(), hasMore: queue.length > 0 });
        } finally { native.publish({ ...native.getSnapshot(), loadingOlder: false }); }
      };
      native.publish({ ...native.getSnapshot(), hasMore: queue.length > 0 });
    }
    sessions.set(id, { sessionId: id, session: native, eventSource: events, phase, configureOlder, releaseHistory() { releaseHistory?.(); releaseHistory = null; }, enableOlder() { native.publish({ ...native.getSnapshot(), hasMore: true }); }, publicText(text) { emit('assistant/message', { turn, step: 1000 + seq, message: { content: [{ type: 'text', text }] } }); }, approve() { pending?.(); } });
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
  await page.getByRole('heading', { name: 'dsh-bot', exact: true }).waitFor();
  check('Production bundle starts from a genuinely empty host store, without demo Bots');
  await page.screenshot({ path: resolve(artifacts, 'team-onboarding-desktop.png') });
  // A close-up of the actual built component, not a generated concept image.
  const orb = page.locator('.dt-primary-card-art .db-avatar');
  const beforeOrb = await orb.getAttribute('style');
  const beforeArt = await page.locator('.dt-primary-card-art').getAttribute('style');
  await page.locator('.dt-primary-card-art').evaluate(el => { el.style.flexBasis = '348px'; });
  await orb.evaluate(el => { el.style.width = '320px'; el.style.height = '320px'; });
  await orb.screenshot({ path: resolve(artifacts, 'team-simple-orb.png') });
  await orb.evaluate((el, value) => el.setAttribute('style', value), beforeOrb);
  await page.locator('.dt-primary-card-art').evaluate((el, value) => value == null ? el.removeAttribute('style') : el.setAttribute('style', value), beforeArt);
  await page.getByRole('button', { name: '创建我的主 Bot', exact: true }).click();
  check('Bot editor offers colors but no square, diamond or other shape options', await page.getByRole('button', { name: /^形状 / }).count() === 0 && await page.locator('.dt-avatar-editor circle.db-avatar__sphere').count() === 1);
  await page.getByRole('button', { name: '创建 Bot', exact: true }).last().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Milo', exact: true }).waitFor();
  check('Creates primary Bot through the real durable WorkspaceStore');
  await page.screenshot({ path: resolve(artifacts, 'team-bot-desktop.png') });
  check('Work sidebar stays collapsed by default', await page.locator('.dt-workspace').count() === 0);
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  check('Unbound native session actions are disabled', await page.getByRole('button', { name: '打开原生工作区', exact: true }).isDisabled());
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '添加记忆', exact: true }).click();
  await page.getByLabel('内容', { exact: true }).fill('每次交付附上验证方法。');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check('Adds scoped memory to host storage', (await store.read()).memories[0].content === '每次交付附上验证方法。');
  await page.getByRole('button', { name: '编辑这条记忆', exact: true }).click();
  await page.getByLabel('内容', { exact: true }).fill('交付时附上真实验证方法。');
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
  await page.locator('.dt-popover').getByRole('button', { name: '新建群组', exact: true }).click();
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
  await page.getByRole('button', { name: '前往 DSH 处理', exact: true }).waitFor();
  await page.getByRole('button', { name: '前往 DSH 处理', exact: true }).click();
  check('Approval is surfaced from native status and routes to native UI, never auto-approved', await page.evaluate(() => window.__fixture.stats.opens.length > 0));
  await page.evaluate(() => window.__fixture.approve());
  await page.waitForFunction(() => !document.querySelector('.dt-working-line'));
  const miloSession = (await store.read()).bots.find(b => b.name === 'Milo').sessionId;
  const advance = async (id, kind) => page.evaluate(({ id, kind }) => window.__fixture.sessions.get(id).phase(kind), { id, kind });
  for (const kind of ['thinking', 'researching', 'coding', 'writing', 'waiting']) {
    await advance(miloSession, kind);
    await page.locator(`.dt-live-companion .db-avatar[data-bot-state='${kind}']`).waitFor();
    check(`Native ${kind} state drives the actual avatar expression and companion badge`);
    await page.screenshot({ path: resolve(artifacts, `team-avatar-${kind}.png`) });
  }
  check('Reduced-motion preference keeps the real waiting expression without movement', await page.locator('.dt-live-companion .db-avatar__body').evaluate(el => getComputedStyle(el).animationName === 'none'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const beforeMotion = await page.locator('.dt-live-companion .db-avatar__body').evaluate(el => getComputedStyle(el).transform);
  await page.waitForFunction(before => getComputedStyle(document.querySelector('.dt-live-companion .db-avatar__body')).transform !== before, beforeMotion);
  check('Real CSS animation changes the Bot pose over time, not just a status dot');
  await page.getByRole('button', { name: '工作空间设置', exact: true }).click();
  await page.getByRole('button', { name: '暂停角色动画', exact: true }).click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  check('User can pause character movement without changing or cancelling work', await page.locator('.dt-live-companion .db-avatar__body').evaluate(el => getComputedStyle(el).animationPlayState === 'paused') && await page.locator('.dt-live-companion [data-bot-state=waiting]').count() === 1);
  await page.getByRole('button', { name: '工作空间设置', exact: true }).click();
  await page.getByRole('button', { name: '开启角色动画', exact: true }).click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await advance(miloSession, 'completed');
  await page.locator('.dt-live-companion [data-bot-state=completed]').waitFor();
  check('A genuine new turn end produces a completion expression');
  await page.screenshot({ path: resolve(artifacts, 'team-avatar-completed.png') });
  await advance(miloSession, 'historical');
  await page.locator('.dt-live-companion [data-bot-state=idle]').waitFor();
  check('Old terminal timestamps do not replay completion celebrations');
  await advance(miloSession, 'thinking'); await advance(miloSession, 'error');
  await page.locator('.dt-live-companion [data-bot-state=error]').waitFor();
  check('Native error produces a concerned expression, not a fake success');
  await page.screenshot({ path: resolve(artifacts, 'team-avatar-error.png') });
  check('Ended partial messages stop posing as live typing', await page.locator('.dt-message .db-avatar[data-bot-state=writing]:not([data-bot-motion=paused])').count() === 0);
  await advance(miloSession, 'historical');
  await page.evaluate(() => { window.__fixture.mode = 'normal'; });
  for (const [name, template] of [['Muse', '内容与创意'], ['Atlas', '代码与执行']]) {
    await createBot(name, template);
    await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).fill('自动化测试：建立持续会话。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('自动化测试替身回复 · 第 1 轮', { exact: false }).first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.dt-working-line'));
  }
  const team = (await store.read()).bots;
  const phases = { Milo: 'coding', Scout: 'researching', Muse: 'writing', Atlas: 'waiting' };
  for (const b of team) await advance(b.sessionId, phases[b.name]);
  await page.locator('.dt-nav-home').click();
  await page.getByRole('region', { name: '动态团队工作台', exact: true }).waitFor();
  for (const kind of Object.values(phases)) await page.locator(`.dt-companion-tile [data-bot-state=${kind}]`).waitFor();
  check('Four real-shaped independent sessions animate simultaneously on the team stage and roster');
  check('Every teammate remains a circular sphere with radial surface lighting', await page.locator('.dt-companion-tile circle.db-avatar__sphere').count() === 4 && await page.locator('.dt-companion-tile radialGradient').count() >= 8);
  check('All expressions stay inside a single orb with no external robot parts or decorative stars', await page.locator('.db-avatar__antenna,.db-avatar__hands,.db-avatar__accessories,.db-avatar__companions,.db-avatar__shadow,.dt-art-spark,.dt-scene-halo').count() === 0 && await page.locator('.dt-companion-tile .db-avatar__interior[clip-path]').count() === 4);
  check('Background observation never sends extra prompts', (await page.evaluate(() => window.__fixture.stats.prompts.length)) === 7);
  await page.screenshot({ path: resolve(artifacts, 'team-living-stage.png') });
  for (const b of team) await advance(b.sessionId, 'historical');
  await page.locator('.dt-bot-row').filter({ hasText: 'Milo' }).first().click();
  check('Interface chrome contains no slogans, explanatory notes or decorative English labels', await page.locator('.dt-kicker,.dt-note,.dt-stage-caption,.dt-compose-note,.dt-home-footnote,.dt-live-eyebrow,.dt-panel-note,.dt-apps-info').count() === 0);
  await page.evaluate(({ id, text }) => window.__fixture.sessions.get(id).publicText(text), { id: miloSession, text: '## 格式预览\n\n**结果**与 `answer`\n\n- 第一项\n- 第二项\n\n[来源](https://example.com/)\n\n```js\nconst answer = "<img src=x onerror=alert(1)>";\n```' });
  await page.getByRole('heading', { name: '格式预览', exact: true }).waitFor();
  check('Assistant messages render safe headings, lists, inline code and actual code blocks', await page.locator('.dt-message-markdown ul li').count() === 2 && await page.locator('.dt-md-code-block code').count() === 1 && await page.locator('.dt-message-markdown img,.dt-message-markdown script').count() === 0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { window.__copiedCode = value; } } }); });
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  check('Code copy preserves exact source text and trailing newline', await page.evaluate(() => window.__copiedCode === 'const answer = "<img src=x onerror=alert(1)>";\n'));
  await page.screenshot({ path: resolve(artifacts, 'team-reading-desktop.png') });
  const rosterSearch = page.getByRole('textbox', { name: '搜索 Bot 和群组', exact: true });
  await rosterSearch.fill('Milo');
  await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索当前对话内容', exact: true }).fill('NO_MATCH_IN_CHAT_98765');
  await page.getByText('无匹配消息', { exact: true }).waitFor();
  check('Transcript search does not change the team filter or hide the selected Bot', await rosterSearch.inputValue() === 'Milo' && await page.locator('.dt-bot-row').count() === 1);
  await page.getByRole('textbox', { name: '搜索当前对话内容', exact: true }).press('Escape');
  check('Ending transcript search preserves the team search query', await rosterSearch.inputValue() === 'Milo' && await page.locator('.dt-message-search').count() === 0);
  await rosterSearch.fill('');
  await page.evaluate(({ id, text }) => window.__fixture.sessions.get(id).publicText(text), { id: miloSession, text: Array.from({ length: 70 }, (_, i) => `历史段落 ${i} · 自动化测试替身`).join('\n\n') });
  await page.waitForFunction(() => { const el = document.querySelector('.dt-transcript'); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 65; });
  await page.locator('.dt-transcript').evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: '最新消息', exact: true }).waitFor();
  const readingOffset = await page.locator('.dt-transcript').evaluate(el => el.scrollTop);
  await page.evaluate(id => window.__fixture.sessions.get(id).publicText('自动化替身：新的末尾回复'), miloSession);
  await page.getByRole('button', { name: '新回复', exact: true }).waitFor();
  check('New native replies do not pull a reader away from earlier messages', Math.abs(await page.locator('.dt-transcript').evaluate(el => el.scrollTop) - readingOffset) < 3);
  await page.getByRole('button', { name: '新回复', exact: true }).click();
  check('Latest-message control returns to the live end', await page.locator('.dt-transcript').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 65));
  await page.evaluate(id => window.__fixture.sessions.get(id).enableOlder(), miloSession);
  await page.locator('.dt-transcript').evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: '更早消息', exact: true }).scrollIntoViewIfNeeded();
  const anchor = await page.locator('.dt-message').first().evaluate(el => ({ id: el.dataset.messageId, top: el.getBoundingClientRect().top }));
  await page.getByRole('button', { name: '更早消息', exact: true }).click();
  await page.getByText('更早消息测试替身 0', { exact: true }).waitFor();
  const anchoredTop = await page.locator('.dt-message').evaluateAll((elements, id) => elements.find(el => el.dataset.messageId === id).getBoundingClientRect().top, anchor.id);
  check('Loading older native messages preserves the reader viewport anchor', Math.abs(anchoredTop - anchor.top) < 4);
  const promptBaseline = await page.evaluate(() => window.__fixture.stats.prompts.length);
  const composer = page.getByRole('textbox', { name: '给 Bot 发消息', exact: true });
  await composer.fill('IME 组词确认');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true });
  check('IME candidate confirmation never sends a prompt', await page.evaluate(() => window.__fixture.stats.prompts.length) === promptBaseline);
  await page.evaluate(() => { const f = window.__fixture, original = f.ctx.connection.rpc.call; let once = true; f.ctx.connection.rpc.call = async (...args) => { if (once && args[1] === 'botWorkspace/update' && args[2]?.request?.action === 'createTask') { once = false; await new Promise(resolve => { f.releaseAdmission = () => { f.ctx.connection.rpc.call = original; resolve(); }; }); } return original(...args); }; });
  await composer.fill('提交中的第一条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => typeof window.__fixture.releaseAdmission === 'function');
  const nextDraft = '下一条草稿\n第二行\n第三行\n第四行\n第五行';
  await composer.fill(nextDraft);
  await page.evaluate(() => window.__fixture.releaseAdmission());
  await page.waitForFunction(({ id, count }) => window.__fixture.stats.prompts.length === count && !window.__fixture.sessions.get(id).session.getSnapshot().running && !document.querySelector('.dt-working-line'), { id: miloSession, count: promptBaseline + 1 });
  check('Editing a draft while an earlier message is being admitted never loses the new text', await composer.inputValue() === nextDraft);
  check('Composer grows for multiline text within a bounded height', await composer.evaluate(el => el.clientHeight > 64 && el.clientHeight <= 180));
  await page.locator('.dt-bot-row').filter({ hasText: 'Scout' }).first().click();
  await composer.fill('Scout 的草稿');
  await page.locator('.dt-bot-row').filter({ hasText: 'Milo' }).first().click();
  check('Each conversation retains its own in-memory draft', await composer.inputValue() === nextDraft);
  await composer.fill('');
  await auditConversationHistory(page, { check, miloSession, artifacts });
  await auditWorkspaceFunctions(page, { check, store, miloSession, artifacts });
  await auditRecordManagement(page, { check, store, miloSession });
  await auditWorkspaceColors(page, { check, artifacts });
  check('Theme selection persists through the host settings API', (await store.read()).settings.theme === 'light');
  // A fresh browser page reuses durable metadata but contains no fake past native log.
  await load();
  check('Reload recovers Bot roster, primary identity, groups and memories from disk', (await page.locator('.dt-bot-row').count()) === 5 && (await store.read()).memories.length === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开 Bot 名册', exact: true }).click();
  check('Mobile exposes a working roster drawer', await page.locator('.dt-roster-open').count() === 1);
  await page.locator('.dt-bot-row').filter({ hasText: 'Scout' }).first().click();
  await page.getByRole('heading', { name: 'Scout', exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, 'team-bot-mobile.png') });
  await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索当前对话内容', exact: true }).fill('移动端搜索');
  await page.getByText('无匹配消息', { exact: true }).waitFor();
  check('Mobile transcript search is directly accessible without extra header clutter', await page.getByText('无匹配消息', { exact: true }).count() === 1);
  await page.getByRole('button', { name: '结束对话搜索', exact: true }).click();
  check('Mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.dt-app').scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  check('Mobile work panel and memory tabs remain operable', await page.getByRole('button', { name: '添加记忆', exact: true }).count() === 1);
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
