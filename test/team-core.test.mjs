import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTeamWorkspace, TEAM_CONTEXT_LIMIT, BOT_TEMPLATES, membersOf, buildTeammatePrompt, displayBotText, routeGroupMessage, summarizeRun, chatExport } from '../src/team-core.mjs';
const bots = BOT_TEMPLATES.slice(0, 3).map((b, i) => ({ ...b, id: `bot-${i}` }));
const workspace = { ...emptyTeamWorkspace(), bots, primaryBotId: bots[0].id, memories: [{ scope: 'shared', content: '公共规则' }, { scope: 'bot', botId: bots[0].id, content: 'Milo 的偏好' }, { scope: 'bot', botId: bots[1].id, content: 'Scout 的私人规则' }] };
const group = { id: 'group-1', name: '一起工作', memberIds: bots.map(b => b.id), messages: [{ role: 'assistant', botId: bots[1].id, text: '前一位的研究结果' }] };

test('oversized scoped memory context rejects before native dispatch instead of evading ownership parsing', () => {
  const huge = { ...workspace, memories: Array.from({ length: 40 }, () => ({ scope: 'shared', content: 'x'.repeat(8000) })) };
  assert.throws(() => buildTeammatePrompt(bots[0], 'work', huge), /上下文过长/);
  const excluded = { ...workspace, memories: [{ scope: 'bot', botId: 'other', content: 'x'.repeat(TEAM_CONTEXT_LIMIT + 1) }] };
  assert.equal(displayBotText(buildTeammatePrompt(bots[0], 'work', excluded)), 'work');
});

test('fresh workspaces are empty and independent, with no fabricated team or chat history', () => { const a = emptyTeamWorkspace(), b = emptyTeamWorkspace(); a.bots.push({}); assert.equal(b.bots.length, 0); assert.equal(b.primaryBotId, null); });
test('Bot prompt carries real identity, scoped memories and exactly the visible user message', () => { const prompt = buildTeammatePrompt(bots[0], '  帮我完成这项工作  ', workspace); assert.match(prompt, /公共规则/); assert.match(prompt, /Milo 的偏好/); assert.doesNotMatch(prompt, /Scout 的私人规则/); assert.equal(displayBotText(prompt), '帮我完成这项工作'); assert.match(prompt, /不声称具有未提供的云端电脑/); });
test('group prompt includes actual roster and prior member result, without impersonation', () => { const prompt = buildTeammatePrompt(bots[2], '@Muse 继续', workspace, group); assert.match(prompt, /前一位的研究结果/); assert.match(prompt, /不要冒充其他 Bot/); assert.equal(displayBotText(prompt), '@Muse 继续'); });
test('context stripping is anchored and never drops a normal user message containing a delimiter', () => { const value = '原样保留 [[DSH_BOT_CONTEXT_V2]]\n hello'; assert.equal(displayBotText(value), value); assert.equal(displayBotText('[[DSH_BOT_CONTEXT_V2]]\nmalformed'), '[[DSH_BOT_CONTEXT_V2]]\nmalformed'); });
test('teammate prompt validates empty input and length', () => { assert.throws(() => buildTeammatePrompt(bots[0], '   ', workspace)); assert.throws(() => buildTeammatePrompt(bots[0], 'x'.repeat(24001), workspace)); });
test('group routing defaults to a member primary Bot or first eligible member', () => { assert.equal(routeGroupMessage('你好', group, bots, bots[1].id)[0].id, bots[1].id); assert.equal(routeGroupMessage('你好', group, bots, 'missing')[0].id, bots[0].id); });
test('group routing honors exact named mentions and everyone without accidental prefix matches', () => { assert.deepEqual(routeGroupMessage('@Scout，先研究', group, bots).map(b => b.name), ['Scout']); assert.deepEqual(routeGroupMessage('@Milo @Muse 合作', group, bots).map(b => b.name), ['Milo', 'Muse']); assert.equal(routeGroupMessage('@everyone 合作', group, bots).length, 3); assert.throws(() => routeGroupMessage('@Scout2 不是 Scout', group, bots, bots[0].id), /未找到成员/); });
test('mention names are escaped and archived/nonmembers cannot receive group work', () => { const custom = [{ id: 'a', name: 'A+B' }, { id: 'b', name: 'Gone', archived: true }, { id: 'c', name: 'Outside' }]; assert.deepEqual(routeGroupMessage('@A+B 处理', { memberIds: ['a', 'b'] }, custom).map(b => b.id), ['a']); assert.throws(() => routeGroupMessage('x', { memberIds: ['b'] }, custom)); });
test('explicit recipients must all be actual active group members', () => {
  assert.deepEqual(routeGroupMessage('x', group, bots, null, [bots[2].id]).map(b => b.id), [bots[2].id]);
  assert.throws(() => routeGroupMessage('x', group, bots, null, [bots[2].id, 'outsider']), /指定的成员/);
  assert.throws(() => routeGroupMessage('x', group, bots, null, ['outsider']), /指定的成员/);
  assert.throws(() => routeGroupMessage('x', group, bots, null, [bots[2].id, bots[2].id]), /重复/);
  assert.throws(() => routeGroupMessage('x', group, bots, null, [null]), /指定的成员/);
  assert.throws(() => routeGroupMessage('x', group, bots, null, null), /指定的成员/);
});
test('group membership supports the documented canonical field without mutation', () => { assert.deepEqual(membersOf(group), group.memberIds); assert.deepEqual(membersOf({ botIds: ['legacy'] }), ['legacy']); assert.deepEqual(membersOf(null), []); });
test('run summary includes only assistant messages newer than saved baseline', () => { assert.equal(summarizeRun({ messages: [{ role: 'assistant', text: 'old', seq: 5 }, { role: 'user', text: 'input', seq: 12 }, { role: 'assistant', text: 'new', seq: 14 }] }, 10), 'new'); });
test('chat export removes injected context and includes actual visible speakers', () => { const text = chatExport('测试\n标题', [{ role: 'user', text: buildTeammatePrompt(bots[0], '工作内容', workspace) }, { role: 'assistant', name: 'Milo', text: '实际结果' }]); assert.match(text, /## 你/); assert.match(text, /## Milo/); assert.match(text, /工作内容/); assert.doesNotMatch(text, /公共规则|DSH_BOT_CONTEXT/); });

test('dispatch ownership is present only for callers supplying a validated UUID', () => {
  const dispatchId = '747e7f18-1615-4a83-8230-e778fe770e4d';
  const context = value => JSON.parse(value.split('\n')[1]);
  assert.equal(Object.hasOwn(context(buildTeammatePrompt(bots[0], '原样消息', workspace)), 'dispatchId'), false);
  const prompt = buildTeammatePrompt(bots[0], '原样消息', workspace, group, dispatchId);
  assert.equal(context(prompt).dispatchId, dispatchId); assert.equal(displayBotText(prompt), '原样消息');
  assert.equal(context(buildTeammatePrompt(bots[0], 'x', workspace, null, dispatchId.toUpperCase())).dispatchId, dispatchId.toUpperCase());
  for (const invalid of [null, 12, {}, '', 'not-a-uuid', `${dispatchId}\n`, ` ${dispatchId}`, '00000000-0000-0000-0000-000000000000']) assert.throws(() => buildTeammatePrompt(bots[0], 'x', workspace, null, invalid), /消息标识/);
});
test('longest exact member names prevent Ann from receiving work addressed to Ann Lee', () => {
  const names = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ann Lee' }], team = { memberIds: ['a', 'b'] };
  assert.deepEqual(routeGroupMessage('@Ann Lee 请处理', team, names, 'a').map(b => b.id), ['b']);
  assert.deepEqual(routeGroupMessage('@ann lee，处理', team, names, 'a').map(b => b.id), ['b']);
  assert.deepEqual(routeGroupMessage('@Ann Lee @Ann 一起处理', team, names).map(b => b.id), ['a', 'b']);
});
test('case-insensitive duplicate member names reject ambiguity instead of multiple dispatch', () => {
  const names = [{ id: 'a', name: 'Scout' }, { id: 'b', name: 'SCOUT' }];
  assert.throws(() => routeGroupMessage('@scout 研究', { memberIds: ['a', 'b'] }, names), /多位成员/);
  assert.deepEqual(routeGroupMessage('@scout 研究', { memberIds: ['a'] }, names).map(b => b.id), ['a']);
  assert.deepEqual(routeGroupMessage('@everyone 研究', { memberIds: ['a', 'b'] }, names).map(b => b.id), ['a', 'b']);
});
test('unknown explicit mentions reject, even beside valid named or everyone targets', () => {
  for (const text of ['@Ghost 处理', '@Scout2 处理', '@🚀 处理', '@Scout @Ghost 处理', '@everyone @Ghost 处理', '@所有人 @Ghost 处理']) assert.throws(() => routeGroupMessage(text, group, bots, bots[0].id), /未找到成员/);
});
test('archived and nonmember mentions or IDs never fall back to another worker', () => {
  const names = [{ id: 'a', name: 'Active' }, { id: 'b', name: 'Gone', archived: true }, { id: 'c', name: 'Outside' }], team = { memberIds: ['a', 'b'] };
  for (const text of ['@Gone 处理', '@Outside 处理']) assert.throws(() => routeGroupMessage(text, team, names, 'a'), /不在此群组或已归档/);
  for (const ids of [['b'], ['a', 'c']]) assert.throws(() => routeGroupMessage('处理', team, names, 'a', ids), /指定的成员/);
});
test('explicit validated IDs remain authoritative and dispatch only once in group order', () => {
  const team = { ...group, memberIds: [bots[2].id, bots[0].id, bots[1].id] };
  assert.deepEqual(routeGroupMessage('普通消息', team, bots).map(b => b.id), [bots[2].id]);
  assert.deepEqual(routeGroupMessage('@everyone 处理', team, bots).map(b => b.id), team.memberIds);
  assert.deepEqual(routeGroupMessage('@Ghost is literal when recipients were selected explicitly', team, bots, null, [bots[0].id, bots[2].id]).map(b => b.id), [bots[2].id, bots[0].id]);
});
test('routing treats emails and standalone @ punctuation as ordinary prose', () => {
  for (const text of ['联系 person@everyone.example 或 scout@example.com', '符号 @ / @! / @？ / 价格 @ 10。', 'https://example.com/@everyone']) assert.deepEqual(routeGroupMessage(text, group, bots, bots[1].id).map(b => b.id), [bots[1].id]);
});
test('inline, fenced, indented and unfinished code cannot select workers', () => {
  for (const text of ['说明 `@everyone` 和 ``@Ghost``', '```text\n@everyone\n@Ghost\n```', '~~~text\n@everyone\n@Ghost', '    @everyone\n\t@Ghost', '未结束的 `@everyone']) assert.deepEqual(routeGroupMessage(text, group, bots, bots[1].id).map(b => b.id), [bots[1].id]);
  for (const text of ['```text\n@everyone\n```\n@Scout 处理', '```@everyone``` @Scout 处理', '`@Ghost` @Scout 处理']) assert.deepEqual(routeGroupMessage(text, group, bots).map(b => b.name), ['Scout']);
});
test('known names preserve escaped punctuation and ordinary closing punctuation', () => {
  const names = [{ id: 'a', name: 'A+B' }, { id: 'b', name: 'Build (QA)' }, { id: 'c', name: 'A.*' }], team = { memberIds: ['a', 'b', 'c'] };
  assert.deepEqual(routeGroupMessage('(@Build (QA)) 处理', team, names).map(b => b.id), ['b']);
  assert.deepEqual(routeGroupMessage('@A+B. 处理', team, names).map(b => b.id), ['a']);
  assert.deepEqual(routeGroupMessage('@A.* 处理', team, names).map(b => b.id), ['c']);
  assert.throws(() => routeGroupMessage('@AB 处理', team, names), /未找到成员/);
});
test('export identifies system notices as system rather than fabricating a Bot author', () => {
  const exported = chatExport('Group', [{ role: 'system', name: 'Scout', text: '任务暂停：需要处理。' }]);
  assert.match(exported, /## 系统\n/); assert.doesNotMatch(exported, /## Bot|## Scout/);
});
