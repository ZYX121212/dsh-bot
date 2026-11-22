import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitKey, consumeSubmittedDraft, planTranscriptScroll, teamStageModel, taskDestination } from '../src/chat-behavior.mjs';

test('historical tasks navigate existing archived subjects and missing subjects only through proven native sessions', () => {
  const workspace = { bots: [{ id: 'b', name: 'Archived', archived: true }], groups: [], runs: [{ taskId: 't', sessionId: 'native-old' }, { taskId: 't', sessionId: 'native-latest' }] };
  assert.deepEqual(taskDestination({ id: 't', botId: 'b' }, workspace), { kind: 'bot', id: 'b', name: 'Archived', archived: true });
  assert.deepEqual(taskDestination({ id: 't', groupId: 'removed' }, workspace), { kind: 'native', sessionId: 'native-latest', name: '原生会话' });
  assert.deepEqual(taskDestination({ id: 't', botId: 'removed', sessionId: 'own-session' }, workspace), { kind: 'native', sessionId: 'own-session', name: '原生会话' });
  assert.equal(taskDestination({ id: 'no-native-work', botId: 'removed' }, workspace), null);
  assert.equal(workspace.runs[0].sessionId, 'native-old');
});

test('Enter submits, Shift Enter and IME confirmation do not', () => {
  assert.equal(isSubmitKey({ key: 'Enter' }), true);
  for (const event of [{ key: 'Enter', shiftKey: true }, { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', nativeEvent: { isComposing: true } }, { key: 'Enter', nativeEvent: { keyCode: 229 } }, { key: 'Escape' }]) assert.equal(isSubmitKey(event), false);
});
test('admission clears only the exact submitted draft and leaves other conversations intact', () => {
  const drafts = { a: 'sent', b: 'other' };
  assert.deepEqual(consumeSubmittedDraft(drafts, 'a', 'sent'), { a: '', b: 'other' });
  assert.deepEqual(drafts, { a: 'sent', b: 'other' });
});
test('editing a draft or switching conversations during admission never loses new text', () => {
  const drafts = { a: 'next message', b: 'typing elsewhere' };
  assert.equal(consumeSubmittedDraft(drafts, 'a', 'sent'), drafts);
  assert.equal(consumeSubmittedDraft(drafts, 'missing', 'sent'), drafts);
});
const before = { key: 'bot:a', first: 'm1', last: 'm10', lastText: 'old', count: 10, top: 120, height: 1500, searching: false, query: '' };
test('initial selection and switching conversations follow the latest message', () => {
  assert.equal(planTranscriptScroll(null, before, false, 1500).action, 'latest');
  assert.equal(planTranscriptScroll(before, { ...before, key: 'bot:b' }, false, 1500).action, 'latest');
});
test('new streaming text does not jerk a reader away from history', () => {
  const next = { ...before, lastText: 'old plus new text' };
  assert.deepEqual(planTranscriptScroll(before, next, false, 1600), { action: 'none', unseen: true });
  assert.deepEqual(planTranscriptScroll(before, next, true, 1600), { action: 'latest', unseen: false });
});
test('metadata refreshes without changed messages do not invent unseen replies', () => {
  assert.deepEqual(planTranscriptScroll(before, { ...before }, false, 1500), { action: 'none', unseen: false });
});
test('prepending older messages preserves viewport offset rather than following to the end', () => {
  assert.deepEqual(planTranscriptScroll(before, { ...before, first: 'm0', count: 15 }, false, 1900), { action: 'preserve', top: 520, unseen: false });
});
test('message search starts at its results and does not treat changed filters as new replies', () => {
  const search = { ...before, searching: true, query: 'code' };
  assert.equal(planTranscriptScroll(before, search, false, 600).action, 'start');
  assert.deepEqual(planTranscriptScroll(search, { ...search, count: 12 }, false, 700), { action: 'none', unseen: false });
  assert.equal(planTranscriptScroll(search, before, false, 1500).action, 'latest');
});
const bots = [{ id: 'primary' }, { id: 'waiting' }, { id: 'busy' }, { id: 'error' }, { id: 'archived', archived: true }];
test('actual attention is visible before primary/idle placement without mutating the roster', () => {
  const p = { primary: { state: 'idle' }, waiting: { state: 'waiting', source: 'snapshot' }, busy: { state: 'coding' }, error: { state: 'error', source: 'snapshot' } };
  const stage = teamStageModel(bots, p, 'primary');
  assert.deepEqual(stage.bots.map(b => b.id), ['waiting', 'error', 'busy', 'primary']);
  assert.equal(stage.counts.waiting, 1); assert.equal(stage.counts.working, 1);
  assert.match(stage.summary, /等你处理/); assert.doesNotMatch(stage.summary, /都在待命/);
  assert.equal(bots[0].id, 'primary'); assert.equal(bots.length, 5);
});
test('record-only waiting and unread native state are not announced as ready or real attention', () => {
  const result = teamStageModel([{ id: 'a' }, { id: 'b' }], { a: { state: 'waiting', source: 'run' } });
  assert.equal(result.counts.waiting, 0); assert.equal(result.counts.unavailable, 2);
  assert.match(result.summary, /状态待确认/); assert.doesNotMatch(result.summary, /等你处理|都在待命/);
});
test('recent completions and stops do not get mislabeled as idle', () => {
  assert.match(teamStageModel([{ id: 'a' }], { a: { state: 'completed' } }).summary, /刚完成/);
  assert.match(teamStageModel([{ id: 'a' }], { a: { state: 'stopped' } }).summary, /已停止/);
  assert.match(teamStageModel([{ id: 'a' }], { a: { state: 'idle' } }).summary, /都在待命/);
});
