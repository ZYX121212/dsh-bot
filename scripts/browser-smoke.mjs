import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  // Fixture-only carrier. Production is always mounted by DSH, never this document.
  await page.route('https://dsh-bot.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="height:100vh"></div></body></html>' }));
  await page.goto('https://dsh-bot.test/');
  for (const path of ['node_modules/react/umd/react.development.js', 'node_modules/react-dom/umd/react-dom.development.js']) await page.addScriptTag({ content: await readFile(resolve(root, path), 'utf8') });
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(module) { window.botModule = module.factory(name => { if (name === 'react') return window.React; throw new Error(`Unexpected external: ${name}`); }); } };
  });
  await page.addScriptTag({ content: await readFile(resolve(root, 'lib/client.js'), 'utf8') });
  await page.evaluate(() => {
    const subscriptions = new Set();
    const stateSubs = new Set();
    let entries = [], counter = 0, timer;
    const publish = () => { for (const fn of subscriptions) fn(); for (const fn of stateSubs) fn(); };
    const session = {
      getSnapshot: () => ({ running: false, openError: null, lastAgentError: null }),
      subscribe: fn => { stateSubs.add(fn); return () => stateSubs.delete(fn); },
      prompt: async content => {
        window.fixturePrompt = content[0].text;
        entries = [];
        timer = setTimeout(() => {
          entries = [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是浏览器自动化的模拟回答，不是真实模型输出。\n\n问题已通过 DSH 会话桥接器发送。测试覆盖流转、历史和导出。\n\n来源示例：https://example.com/reference' }] } } } }, { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }]; publish();
        }, 180);
        return { ok: true, value: { accepted: true } };
      },
      cancel: async () => { clearTimeout(timer); entries.push({ event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } }); publish(); return { ok: true }; }
    };
    const ctx = {
      effect(fn) { fn(); }, layout: {},
      sessions: { create: async opts => { window.fixturePreset = opts.agentPreset; return `fixture-session-${++counter}`; }, retain: () => ({ ready: Promise.resolve({ session, eventSource: { getSnapshot: () => ({ entries }), subscribe: fn => { subscriptions.add(fn); return () => subscriptions.delete(fn); } } }), release() {} }) },
      slots: { inject(name, fn) { fn(); }, register(options, Component) { if (options.name === 'main') { window.fixtureComponent = Component; window.fixtureProps = options.inject(); } return () => {}; } }
    };
    window.botModule.apply(ctx);
    window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(window.fixtureComponent, window.fixtureProps));
  });
  await page.getByRole('heading', { name: /有问题.*叫一声/ }).waitFor();
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'artifacts/desktop-preview.png'), fullPage: true });
  await page.getByRole('button', { name: '查证一下', exact: false }).click();
  await page.getByRole('button', { name: '＋ 引用原文' }).click();
  await page.getByLabel('引用原文 · 只分析这次提供的内容').fill('引用示例：这个说法尚无直接证据。');
  await page.getByLabel('向 dsh-bot 提问').fill('@dsh-bot 帮我看看这个说法靠谱吗？');
  await page.getByLabel('向 dsh-bot 提问').press('Enter');
  await page.getByText('回答完成', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixturePreset), 'dsh-bot');
  assert.match(await page.evaluate(() => window.fixturePrompt), /核查输入中的主张/);
  assert.match(await page.evaluate(() => window.fixturePrompt), /引用示例/);
  assert.equal(await page.getByRole('link', { name: 'https://example.com/reference' }).getAttribute('rel'), 'noreferrer noopener');
  await page.getByRole('button', { name: '☆ 收藏', exact: true }).last().click();
  await page.getByRole('button', { name: '★ 已收藏', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出这一条' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^dsh-bot-.*\.md$/);
  await page.getByLabel('搜索对话').fill('肯定不存在的记录');
  await page.getByText('没有匹配的对话。').waitFor();
  await page.getByLabel('搜索对话').fill('');
  await page.getByRole('button', { name: '＋  新的提问' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '你的 Bot，你做主。' }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(root, 'artifacts/mobile-preview.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile page must not overflow horizontally');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByLabel('搜索对话').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  const result = { fixture: true, checks: ['DSH module registration', 'desktop rendering', 'task mode', 'quoted source', 'mention normalization', 'dedicated preset selection', 'session response', 'safe links', 'star', 'Markdown download', 'history search', 'new question', 'settings', 'mobile layout', 'mobile history'], pageErrors: errors };
  await writeFile(resolve(root, 'artifacts/browser-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'artifacts/browser-failure.png'), fullPage: true });
  console.error('Browser errors:', errors);
  console.error('Rendered body:', (await page.locator('body').innerText()).slice(0, 3000));
  throw error;
} finally { await browser.close(); }
