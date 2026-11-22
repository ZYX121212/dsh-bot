import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function auditWorkspaceFunctions(page, { check, store, miloSession, artifacts }) {
  const initial = await store.read();
  const milo = initial.bots.find(bot => bot.name === 'Milo' && !bot.archived);
  const scout = initial.bots.find(bot => bot.name === 'Scout' && !bot.archived);
  const originalGroup = initial.groups.find(group => !group.archived && group.memberIds.includes(milo?.id) && group.memberIds.includes(scout?.id));
  assert.ok(milo && scout && originalGroup, 'Functional fixture needs Milo, Scout and their original group');
  const baselineStats = await page.evaluate(() => ({ prompts: window.__fixture.stats.prompts.length, creates: window.__fixture.stats.creates.length }));
  const panel = page.locator('.dt-workspace');
  const composer = () => page.getByRole('textbox', { name: '给 Bot 发消息', exact: true });
  const rosterSearch = page.getByRole('textbox', { name: '搜索 Bot 和群组', exact: true });
  const row = name => page.locator('.dt-bot-row').filter({ hasText: name }).first();
  const selectedDialog = () => page.getByRole('dialog');
  async function activeRoster() {
    const back = page.getByRole('button', { name: '返回团队', exact: true });
    if (await back.count()) await back.click();
    await rosterSearch.fill('');
  }
  async function selectBot(name) { await activeRoster(); await row(name).click(); await page.locator('.dt-conversation-title strong').filter({ hasText: name }).waitFor(); }
  async function details() {
    if (!await panel.count()) await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
    await panel.getByRole('tab', { name: '详情', exact: true }).click();
  }
  async function memoryTab() { await panel.getByRole('tab', { name: '记忆', exact: true }).click(); }
  async function openBotEditor() { await details(); await panel.getByRole('button', { name: '编辑 Bot', exact: true }).click(); }
  async function openGroupEditor() { await details(); await panel.getByRole('button', { name: '编辑群组', exact: true }).click(); }
  const member = (dialog, name) => dialog.locator('.dt-group-picker label').filter({ hasText: name });

  async function heldSave(action, label, submitName, { fail = false } = {}) {
    const failureMessage = '功能检查：暂时无法保存。';
    await page.evaluate(({ action, failureMessage }) => {
      const fixture = window.__fixture, original = fixture.ctx.connection.rpc.call;
      if (fixture.functionalAuditGate) throw new Error('A functional RPC gate is already active');
      let release;
      const waiting = new Promise(resolve => { release = resolve; });
      const gate = { count: 0, seen: false, released: false, fail: false,
        release(fail = false) { gate.fail = fail; if (!gate.released) { gate.released = true; release(); } },
        restore() { fixture.ctx.connection.rpc.call = original; delete fixture.functionalAuditGate; } };
      fixture.functionalAuditGate = gate;
      fixture.ctx.connection.rpc.call = async (...args) => {
        if (args[1] === 'botWorkspace/update' && args[2]?.request?.action === action) {
          gate.count++;
          if (gate.count === 1) { gate.seen = true; await waiting; if (gate.fail) return { ok: false, error: { message: failureMessage } }; }
        }
        return original(...args);
      };
    }, { action, failureMessage });
    try {
      const dialog = selectedDialog();
      await dialog.getByRole('button', { name: submitName, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.functionalAuditGate?.seen);
      await dialog.locator('form[aria-busy="true"]').waitFor();
      check(`${label}: pending save freezes text, choices and all action buttons`, await dialog.locator('input,textarea,select').evaluateAll(nodes => nodes.every(node => node.disabled || node.readOnly)) && await dialog.getByRole('button').evaluateAll(nodes => nodes.every(node => node.disabled)));
      const input = dialog.getByRole('textbox').first(), before = await input.inputValue();
      await input.focus(); await input.press('End'); await input.press('x');
      check(`${label}: typed edits cannot silently disappear behind an in-flight save`, await input.inputValue() === before);
      await page.keyboard.press('Escape');
      await page.locator('.dt-modal-backdrop').click({ position: { x: 3, y: 3 } });
      check(`${label}: Escape, backdrop, close and cancel cannot dismiss a pending editor`, await dialog.isVisible() && await dialog.getByRole('button', { name: '关闭窗口', exact: true }).isDisabled() && await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled());
      await dialog.locator('form').dispatchEvent('submit');
      await page.evaluate(fail => window.__fixture.functionalAuditGate.release(fail), fail);
      if (fail) {
        await dialog.getByRole('alert').filter({ hasText: failureMessage }).waitFor();
        await dialog.locator('form[aria-busy="false"]').waitFor();
        check(`${label}: a rejected save retains content and re-enables retry`, await input.inputValue() === before && await input.isEditable() && await dialog.getByRole('button', { name: submitName, exact: true }).isEnabled());
      } else await dialog.waitFor({ state: 'hidden' });
      check(`${label}: repeated submit while pending produces only one metadata mutation`, await page.evaluate(() => window.__fixture.functionalAuditGate.count) === 1);
    } finally {
      await page.evaluate(() => { const gate = window.__fixture.functionalAuditGate; gate?.release(); gate?.restore(); }).catch(() => {});
    }
  }

  async function assertArchivedReadOnly(label) {
    await page.getByRole('button', { name: '返回团队', exact: true }).waitFor();
    check(`${label}: archive view exposes read-only conversation and disabled submit`, !await composer().isEditable() && await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled());
    const setPrimary = panel.getByRole('button', { name: '设为主 Bot', exact: true });
    check(`${label}: impossible primary action is not offered`, !await setPrimary.count() || await setPrimary.isDisabled());
    await page.evaluate(() => {
      const fixture = window.__fixture, original = fixture.ctx.connection.rpc.call;
      fixture.functionalArchiveProbe = { actions: [], restore() { fixture.ctx.connection.rpc.call = original; delete fixture.functionalArchiveProbe; } };
      fixture.ctx.connection.rpc.call = (...args) => {
        if (args[1] === 'botWorkspace/update') fixture.functionalArchiveProbe.actions.push(args[2]?.request?.action);
        return original(...args);
      };
    });
    try {
      await composer().focus(); await page.keyboard.press('Enter');
      await page.locator('.dt-compose').dispatchEvent('submit');
      const observed = await page.evaluate(() => ({ actions: window.__fixture.functionalArchiveProbe.actions, prompts: window.__fixture.stats.prompts.length }));
      check(`${label}: Enter and form submit never create tasks, messages or native work`, observed.actions.length === 0 && observed.prompts === baselineStats.prompts);
    } finally { await page.evaluate(() => window.__fixture.functionalArchiveProbe?.restore()).catch(() => {}); }
  }

  await selectBot('Milo');
  await openBotEditor();
  const originalRole = milo.role || '', editedRole = `${originalRole}\n功能回归：保存职责。`;
  await selectedDialog().getByLabel('职责', { exact: true }).fill(editedRole);
  await heldSave('updateBot', 'Bot editor', '保存更改');
  check('Bot editor saves the actual responsibility through host storage', (await store.read()).bots.find(bot => bot.id === milo.id).role === editedRole);
  await openBotEditor();
  await selectedDialog().getByLabel('职责', { exact: true }).fill(originalRole);
  await selectedDialog().getByRole('button', { name: '保存更改', exact: true }).click();
  await selectedDialog().waitFor({ state: 'hidden' });

  await memoryTab();
  await panel.getByRole('button', { name: '添加记忆', exact: true }).click();
  const temporaryMemory = '功能回归：临时共享记忆。';
  const editedMemory = '功能回归：临时共享记忆已编辑。';
  await selectedDialog().getByLabel('内容', { exact: true }).fill(temporaryMemory);
  await selectedDialog().getByLabel('范围', { exact: true }).selectOption('shared');
  await heldSave('addMemory', 'Memory create', '保存记忆', { fail: true });
  check('Failed memory create leaves durable memories unchanged', (await store.read()).memories.length === initial.memories.length);
  await selectedDialog().getByRole('button', { name: '保存记忆', exact: true }).click();
  await selectedDialog().waitFor({ state: 'hidden' });
  const savedMemory = (await store.read()).memories.find(memory => memory.content === temporaryMemory);
  check('Memory retry creates one actual shared record', !!savedMemory && savedMemory.scope === 'shared' && savedMemory.botId === null && (await store.read()).memories.length === initial.memories.length + 1);
  await selectBot('Scout'); await memoryTab();
  await panel.getByText(temporaryMemory, { exact: true }).waitFor();
  const scoutMemoryText = await panel.locator('.dt-memory-list article').allTextContents();
  check('Shared memory is visible to another Bot without exposing Milo-private memory', initial.memories.filter(memory => memory.scope === 'bot' && memory.botId === milo.id).every(memory => scoutMemoryText.every(text => !text.includes(memory.content))));
  await selectBot('Milo'); await memoryTab();
  await panel.locator('.dt-memory-list article').filter({ hasText: temporaryMemory }).getByRole('button', { name: '编辑这条记忆', exact: true }).click();
  await selectedDialog().getByLabel('内容', { exact: true }).fill(editedMemory);
  await heldSave('updateMemory', 'Memory editor', '保存记忆');
  check('Memory edit updates the same scoped record', (await store.read()).memories.find(memory => memory.id === savedMemory.id)?.content === editedMemory);
  await panel.locator('.dt-memory-list article').filter({ hasText: editedMemory }).getByRole('button', { name: '删除这条记忆', exact: true }).click();
  await panel.getByText(editedMemory, { exact: true }).waitFor({ state: 'hidden' });
  check('Confirmed memory deletion removes only that record', !(await store.read()).memories.some(memory => memory.id === savedMemory.id) && (await store.read()).memories.length === initial.memories.length);

  await selectBot('Scout');
  const scoutDraft = await composer().inputValue();
  if (!scoutDraft.trim()) await composer().fill('归档后不能提交的草稿。');
  const archivedScoutDraft = await composer().inputValue();
  await details(); await panel.getByRole('button', { name: '归档', exact: true }).click();
  await assertArchivedReadOnly('Archived Bot');
  if (artifacts) await page.screenshot({ path: resolve(artifacts, 'team-functional-archived.png') });

  await rosterSearch.fill('NO_SUCH_FUNCTIONAL_BOT');
  await page.getByRole('button', { name: '新建 Bot 或群组', exact: true }).click();
  await page.locator('.dt-popover').getByRole('button', { name: '新建 Bot', exact: true }).click();
  await selectedDialog().getByLabel('名字', { exact: true }).fill('LoopCheck');
  await selectedDialog().getByLabel('职责', { exact: true }).fill('用于验证创建与归档闭环。');
  await heldSave('createBot', 'Bot create', '创建 Bot');
  await row('LoopCheck').waitFor();
  check('Creating from an empty archive search resets both filter and roster mode', await rosterSearch.inputValue() === '' && await page.locator('.dt-roster-bottom').getByRole('button', { name: '归档', exact: true }).count() === 1);
  const temporaryBot = (await store.read()).bots.find(bot => bot.name === 'LoopCheck');
  check('Creating metadata does not secretly create a native session', !!temporaryBot && !temporaryBot.sessionId && await page.evaluate(() => window.__fixture.stats.creates.length) === baselineStats.creates);
  await details(); await panel.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '返回团队', exact: true }).waitFor();
  await activeRoster(); await row(originalGroup.name).click(); await openGroupEditor();
  const groupDialog = selectedDialog();
  check('Group editor keeps selected archived members visible and removable', await member(groupDialog, 'Scout').getByText('已归档', { exact: true }).count() === 1 && await member(groupDialog, 'Scout').getByRole('checkbox').isChecked());
  check('Archived nonmembers are not introduced into the group picker', await member(groupDialog, 'LoopCheck').count() === 0);
  await member(groupDialog, 'Scout').getByRole('checkbox').uncheck();
  const editedGroupName = `${originalGroup.name} · 检查`;
  await groupDialog.getByLabel('群组名称', { exact: true }).fill(editedGroupName);
  await heldSave('updateGroup', 'Group editor', '保存群组');
  const editedGroup = (await store.read()).groups.find(group => group.id === originalGroup.id);
  check('Group editor saves a sole-Milo group after removing its archived member', editedGroup.name === editedGroupName && editedGroup.memberIds.length === 1 && editedGroup.memberIds[0] === milo.id);

  await page.locator('.dt-roster-bottom').getByRole('button', { name: '归档', exact: true }).click();
  await row('Scout').click(); await details(); await panel.getByRole('button', { name: '恢复', exact: true }).click();
  await page.locator('.dt-roster-bottom').getByRole('button', { name: '归档', exact: true }).waitFor();
  check('Restoring a Bot returns the active roster and preserves its draft', await composer().isEditable() && await composer().inputValue() === archivedScoutDraft && !(await store.read()).bots.find(bot => bot.id === scout.id).archived);
  await composer().fill(scoutDraft);
  await panel.getByRole('button', { name: '设为主 Bot', exact: true }).click();
  await row('Scout').locator('.dt-primary-label').waitFor();
  check('Primary action persists the selected actual Bot identity', (await store.read()).primaryBotId === scout.id);
  await selectBot('Milo'); await details(); await panel.getByRole('button', { name: '设为主 Bot', exact: true }).click();
  await row('Milo').locator('.dt-primary-label').waitFor();
  check('Primary identity can be restored without creating a conversation', (await store.read()).primaryBotId === milo.id);

  await row(editedGroupName).click(); await openGroupEditor();
  await selectedDialog().getByLabel('群组名称', { exact: true }).fill(originalGroup.name);
  const boxes = selectedDialog().getByRole('checkbox');
  for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).uncheck();
  for (const id of originalGroup.memberIds) await member(selectedDialog(), initial.bots.find(bot => bot.id === id).name).getByRole('checkbox').check();
  await selectedDialog().getByRole('button', { name: '保存群组', exact: true }).click();
  await selectedDialog().waitFor({ state: 'hidden' });
  const originalGroupDraft = await composer().inputValue();
  await composer().fill('已归档群组不能提交的草稿。');
  const archivedGroupDraft = await composer().inputValue();
  await details(); await panel.getByRole('button', { name: '归档', exact: true }).click();
  await assertArchivedReadOnly('Archived group');
  check('Archived group cannot append an @everyone target to its draft', await page.getByRole('button', { name: '@everyone', exact: true }).isDisabled());
  await panel.getByRole('button', { name: '恢复', exact: true }).click();
  await page.locator('.dt-roster-bottom').getByRole('button', { name: '归档', exact: true }).waitFor();
  check('Restoring a group preserves its existing draft and re-enables editing', await composer().isEditable() && await composer().inputValue() === archivedGroupDraft);
  await composer().fill(originalGroupDraft);

  await selectBot('Milo');
  await panel.getByRole('tab', { name: '工作', exact: true }).click();
  const expectedSession = miloSession || milo.sessionId;
  await page.getByRole('button', { name: '打开 DSH 原生会话', exact: true }).click();
  check('Header native navigation opens the selected Bot session', await page.evaluate(() => window.__fixture.stats.opens.at(-1)) === expectedSession);
  await panel.locator('.dt-files button').first().waitFor();
  await panel.locator('.dt-files button').first().click();
  check('Native file handoff opens the file-producing Bot session', await page.evaluate(() => window.__fixture.stats.opens.at(-1)) === expectedSession);
  const final = await store.read();
  assert.deepEqual(final.bots.filter(bot => !bot.archived).map(bot => bot.id).sort(), initial.bots.filter(bot => !bot.archived).map(bot => bot.id).sort());
  assert.deepEqual(final.memories, initial.memories);
  const finalGroup = final.groups.find(group => group.id === originalGroup.id);
  assert.equal(finalGroup.name, originalGroup.name); assert.equal(finalGroup.archived, false); assert.deepEqual(finalGroup.memberIds, originalGroup.memberIds); assert.deepEqual(finalGroup.messages, originalGroup.messages);
  assert.equal(final.primaryBotId, milo.id); assert.equal(final.bots.find(bot => bot.id === milo.id).role, originalRole);
  assert.equal(final.tasks.length, initial.tasks.length); assert.equal(final.runs.length, initial.runs.length);
  check('Functional actions leave original active roster, group, memory and primary intact', final.bots.find(bot => bot.id === temporaryBot.id).archived && await rosterSearch.inputValue() === '' && await panel.isVisible());
  check('CRUD, archive and navigation actions do not dispatch hidden native work', await page.evaluate(() => window.__fixture.stats.prompts.length) === baselineStats.prompts && await page.evaluate(() => window.__fixture.stats.creates.length) === baselineStats.creates);
  return { miloId: milo.id, scoutId: scout.id, groupId: originalGroup.id, archivedTemporaryBotId: temporaryBot.id, memoryCount: final.memories.length };
}
