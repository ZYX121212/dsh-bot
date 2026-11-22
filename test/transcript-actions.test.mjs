import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConversationMessages, mergeTranscriptMessages, transcriptFilename } from '../src/transcript-actions.mjs';
const message = (seq, text = `message ${seq}`) => ({ id: `m${seq}`, seq, role: 'assistant', text });
const snapshot = page => ({ sessionId: 's', firstSeq: page.firstSeq ?? page.messages?.[0]?.seq ?? null, ...page });
function fixture(pages) {
  let index = 0, reads = 0;
  let state = { selected: { kind: 'bot', id: 'b' }, workspace: { bots: [{ id: 'b', sessionId: 's' }] }, conversation: snapshot(pages[0]) };
  const listeners = new Set();
  const controller = { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async loadOlder() { reads++; state = { ...state, conversation: snapshot(pages[++index] || { messages: [], hasMore: false }) }; for (const fn of listeners) fn(); } };
  return { controller, get reads() { return reads; }, get listeners() { return listeners.size; }, set(patch) { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(); } };
}
test('all native pages are read, sorted and deduplicated instead of silently exporting the visible window', async () => {
  const f = fixture([{ messages: [message(3)], hasMore: true }, { messages: [message(2), message(3, 'updated')], hasMore: true }, { messages: [message(1), message(2), message(3, 'updated')], hasMore: false }]);
  const rows = await collectConversationMessages(f.controller);
  assert.deepEqual(rows.map(x => x.seq), [1, 2, 3]); assert.equal(rows.at(-1).text, 'updated'); assert.equal(f.reads, 2);
});
test('message merging updates streaming identity without mutating inputs', () => {
  const old = [message(2, 'partial')], current = [message(1), message(2, 'final')];
  assert.deepEqual(mergeTranscriptMessages(old, current).map(x => x.text), ['message 1', 'final']); assert.equal(old[0].text, 'partial');
});
test('already complete history needs no native calls', async () => { const f = fixture([{ messages: [message(1)], hasMore: false }]); assert.equal((await collectConversationMessages(f.controller)).length, 1); assert.equal(f.reads, 0); });
test('stalled history is a real failure, not a false complete result', async () => {
  const f = fixture([{ messages: [message(1)], hasMore: true }, { messages: [message(1)], hasMore: true }]);
  await assert.rejects(collectConversationMessages(f.controller), /未取得进展/);
});
test('history page and content limits fail explicitly without returning truncated exports', async () => {
  const f = fixture([{ messages: [message(2)], hasMore: true }]);
  await assert.rejects(collectConversationMessages(f.controller, { maxPages: 0 }), /尚未读取完整/);
  await assert.rejects(collectConversationMessages(f.controller, { maxMessages: 0 }), /消息过多/);
  await assert.rejects(collectConversationMessages(f.controller, { maxChars: 1 }), /消息过多/);
});
test('switching conversations during an outstanding read never exports the other Bot', async () => {
  const f = fixture([{ messages: [message(1)], hasMore: true }]);
  f.controller.loadOlder = async () => f.set({ selected: { kind: 'bot', id: 'other' }, conversation: { sessionId: 'other', messages: [message(9)] } });
  await assert.rejects(collectConversationMessages(f.controller), { name: 'AbortError' });
});
test('replacing a session identity during history load is rejected', async () => {
  const f = fixture([{ messages: [message(1)], hasMore: true }]);
  f.controller.loadOlder = async () => f.set({ conversation: { sessionId: 'other', messages: [message(9)] } });
  await assert.rejects(collectConversationMessages(f.controller), { name: 'AbortError' });
});
test('pre-aborted reads do not issue any native operation', async () => {
  const f = fixture([{ messages: [], hasMore: true }]), abort = new AbortController(); abort.abort();
  await assert.rejects(collectConversationMessages(f.controller, { signal: abort.signal }), { name: 'AbortError' }); assert.equal(f.reads, 0);
});
test('closing search aborts a hanging read without cancelling native task work', async () => {
  const f = fixture([{ messages: [message(1)], hasMore: true }]), abort = new AbortController();
  let rejectRead; f.controller.loadOlder = () => new Promise((_, reject) => { rejectRead = reject; });
  const result = collectConversationMessages(f.controller, { signal: abort.signal }); abort.abort();
  await assert.rejects(result, { name: 'AbortError' }); rejectRead(new Error('late read failure'));
});
test('concurrent older-message loading is observed rather than duplicated', async () => {
  const f = fixture([{ messages: [], loadingOlder: true, hasMore: true }]);
  const result = collectConversationMessages(f.controller);
  f.set({ conversation: { sessionId: 's', messages: [message(1)], loadingOlder: false, hasMore: false } });
  assert.equal((await result).length, 1); assert.equal(f.reads, 0); assert.equal(f.listeners, 0);
});
test('initial native conversation opening can finish without a spurious empty export', async () => {
  const f = fixture([{ messages: [] }]); f.set({ conversation: null });
  const result = collectConversationMessages(f.controller);
  f.set({ conversation: { sessionId: 's', messages: [message(1)], hasMore: false } });
  assert.equal((await result).length, 1); assert.equal(f.listeners, 0);
});
test('aborting while waiting for an earlier read removes subscriptions', async () => {
  const f = fixture([{ messages: [], loadingOlder: true }]), abort = new AbortController();
  const result = collectConversationMessages(f.controller, { signal: abort.signal }); abort.abort();
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(f.listeners, 0);
});
test('native read failures are propagated and never treated as empty history', async () => {
  const f = fixture([{ messages: [], hasMore: true }]); f.controller.loadOlder = async () => { throw new Error('offline'); };
  await assert.rejects(collectConversationMessages(f.controller), /offline/);
});
test('a hanging native history read has a bounded timeout', async () => {
  const f = fixture([{ messages: [], hasMore: true }]); f.controller.loadOlder = () => new Promise(() => {});
  await assert.rejects(collectConversationMessages(f.controller, { timeoutMs: 10 }), /超时/);
});
test('tool-only native pages advance the raw cursor even without new visible messages', async () => {
  const f = fixture([{ firstSeq: 100, messages: [message(300)], hasMore: true }, { firstSeq: 50, messages: [message(300)], hasMore: true }, { firstSeq: 1, messages: [message(3), message(300)], hasMore: false }]);
  assert.deepEqual((await collectConversationMessages(f.controller)).map(row => row.seq), [3, 300]); assert.equal(f.reads, 2);
});
test('a failed streaming attempt removed by the native surface is not resurrected in export', async () => {
  const f = fixture([{ firstSeq: 10, messages: [{ ...message(20, 'abandoned'), partial: true }, message(30)], hasMore: true }, { firstSeq: 1, messages: [message(3), message(30)], hasMore: false }]);
  assert.deepEqual((await collectConversationMessages(f.controller)).map(row => row.seq), [3, 30]);
});
test('native replacement and rebaseline supersede older collected messages authoritatively', async () => {
  const f = fixture([{ firstSeq: 10, messages: [message(20, 'replaced')], hasMore: true }, { firstSeq: 1, messages: [message(3), message(40, 'replacement')], hasMore: false }]);
  assert.deepEqual((await collectConversationMessages(f.controller)).map(row => row.text), ['message 3', 'replacement']);
});
test('an opening or unavailable native session is never exported as a false empty transcript', async () => {
  const f = fixture([{ messages: [], openState: 'opening', hasMore: false }]);
  const result = collectConversationMessages(f.controller);
  f.set({ conversation: snapshot({ messages: [message(1)], openState: 'ready', hasMore: false }) });
  assert.equal((await result).length, 1);
  f.set({ conversation: snapshot({ messages: [], openState: 'error', error: 'cannot open native' }) });
  await assert.rejects(collectConversationMessages(f.controller), /cannot open native/);
});

test('export filenames reject control characters, path separators and reserved device names', () => {
  assert.equal(transcriptFilename('../foo\\bar:\n*?'), '.._foo_bar____-chat.md');
  assert.equal(transcriptFilename('CON'), 'dsh-bot-CON-chat.md'); assert.equal(transcriptFilename('...'), 'dsh-bot-chat.md');
  assert.ok(new TextEncoder().encode(transcriptFilename('🙂'.repeat(200))).length < 255);
});
