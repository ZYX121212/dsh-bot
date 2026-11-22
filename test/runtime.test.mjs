import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime, currentWorkspaceCwd, extractRuntimeSnapshot } from '../src/runtime.mjs';

const event = (seq, type, data, extra = {}) => ({ event: { seq, time: seq * 100, type, data, ...extra } });
function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of [...listeners]) fn(); }, get count() { return listeners.size; } };
}
function fixture(options = {}) {
  const sessions = new Map(), created = [], retains = [], opened = [], status = observable(new Map());
  let createdCount = 0;
  function native(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const state = observable({ sessionId, running: false, openState: 'open', hasMore: false });
    const events = observable({ entries: [] });
    const entry = { state, events, releases: 0, prompts: [], cancels: 0, older: 0, seq: 0 };
    entry.session = {
      getSnapshot: state.getSnapshot, subscribe: state.subscribe,
      async prompt(content, mode) { entry.prompts.push({ content, mode }); return options.prompt ? options.prompt(entry, content, mode) : { ok: true }; },
      async cancel() { entry.cancels++; return options.cancel ? options.cancel(entry) : { ok: true }; },
      async loadOlder() { entry.older++; }
    };
    entry.push = (...rows) => events.set({ entries: [...events.getSnapshot().entries, ...rows] });
    entry.finish = (turn = 1) => { entry.push(event(++entry.seq, 'turn/end', { turn, reason: { kind: 'completed' } })); state.set({ ...state.getSnapshot(), running: false }); };
    sessions.set(sessionId, entry);
    return entry;
  }
  const ctx = {
    sessions: {
      list: observable({ byId: options.byId ?? {} }),
      async create(opts) { created.push(opts); return options.create ? options.create(opts) : `native-${++createdCount}`; },
      retain(sessionId, opts) {
        retains.push({ sessionId, opts });
        const item = native(sessionId);
        return { sessionId, ready: options.ready ? options.ready(item) : Promise.resolve({ session: item.session, eventSource: item.events }), release() { item.releases++; } };
      }
    },
    uiSession: { sessionStatus: status },
    uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } }
  };
  return { ctx, native, sessions, created, retains, opened, status };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Pure presentation extraction intentionally never serializes tool arguments or output.
test('runtime extraction returns public user/assistant text and skips reasoning, context and secrets', () => {
  const entries = [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'question <script>x</script>' }] }),
    event(3, 'user/message', { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'SECRET CONTEXT' }] }),
    event(4, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'SECRET REASONING' }, { type: 'text', text: 'answer' }, { type: 'tool-call', arguments: 'SECRET ARGS' }] } }),
    event(5, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: 'SECRET ARGS' }),
    event(6, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'SECRET RESULT' }] } })];
  const result = extractRuntimeSnapshot(entries);
  assert.deepEqual(result.messages.map(row => row.text), ['question <script>x</script>', 'answer']);
  assert.equal(result.messages[0].id, 'u1');
  assert.equal(result.messages[0].turn, 1);
  assert.equal(result.activities[0].toolName, 'bash');
  assert.equal(result.activities[0].status, 'done');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('partial text becomes exactly one stable durable assistant message, including racing old chunks', () => {
  const partial = event(2, 'assistant/live-chunk', { turn: 1, step: 1, attemptId: 'a1', chunk: { type: 'text-delta', text: 'par' } });
  const live = extractRuntimeSnapshot([partial]);
  const settled = extractRuntimeSnapshot([partial, event(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }), partial]);
  assert.equal(live.messages[0].partial, true);
  assert.equal(live.messages[0].id, settled.messages[0].id);
  assert.equal(settled.messages.length, 1);
  assert.equal(settled.messages[0].text, 'answer');
  assert.equal(settled.messages[0].partial, false);
});

test('retry live prefixes do not concatenate and failed attempts hide old transient text', () => {
  const chunk = (seq, attemptId, text) => event(seq, 'assistant/live-chunk', { turn: 2, step: 3, attemptId, chunk: { type: 'text-delta', text } });
  const snapshot = extractRuntimeSnapshot([chunk(1, 'a1', 'old'), chunk(2, 'a2', 'new'), chunk(3, 'a2', ' text')]);
  assert.equal(snapshot.messages[0].text, 'new text');
  assert.equal(extractRuntimeSnapshot([chunk(1, 'a1', 'old'), event(2, 'assistant/attempt', { turn: 2, step: 3 })]).messages.length, 0);
  const retried = extractRuntimeSnapshot([chunk(1, 'a1', 'old'), event(2, 'assistant/attempt', { turn: 2, step: 3 }), chunk(3, 'a2', 'new retry')]);
  assert.equal(retried.messages[0].text, 'new retry');
  assert.equal(retried.messages[0].partial, true);
});

test('native surface replacements suppress shadowed messages', () => {
  const snapshot = extractRuntimeSnapshot([
    event(1, 'user/message', { content: [{ type: 'text', text: 'old user' }] }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old answer' }] } }),
    event(3, 'user/message', { content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } })
  ]);
  assert.deepEqual(snapshot.messages.map(row => row.text), ['summary']);
});

test('files only come from explicit durable delivery events, with deduplication and no HTML interpretation', () => {
  const result = extractRuntimeSnapshot([
    event(1, 'tool/result', { message: { toolCallId: 'a', content: [{ type: 'text', text: '/tmp/not-a-deliverable.txt' }] } }),
    event(2, 'deliverables/presented', { turn: 1, files: [{ path: '/tmp/report.pdf', description: '<b>Report</b>' }, { path: '' }, null] }),
    event(3, 'deliverables/presented', { turn: 1, files: [{ path: '/tmp/report.pdf', description: 'Latest' }] })
  ]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].description, 'Latest');
  assert.equal(result.files[0].seq, 3);
});

test('structured completion reasons expose stable turn boundary and interrupt uncompleted activity', () => {
  const snapshot = extractRuntimeSnapshot([event(9, 'turn/start', { turn: 5 }), event(10, 'tool/call', { turn: 5, callId: 'c', name: 'search' }), event(11, 'turn/end', { turn: 5, reason: { kind: 'aborted', reason: { kind: 'user' } } })]);
  assert.deepEqual(snapshot.lastTurnEnd, { turn: 5, reason: 'aborted', seq: 11, time: 1100 });
  assert.equal(snapshot.latestTurn, 5);
  assert.equal(snapshot.lastSeq, 11);
  assert.equal(snapshot.activities[0].status, 'interrupted');
});

test('native pending interaction is sanitized and never exposes answer/delegate or credentials', () => {
  const snapshot = extractRuntimeSnapshot([], { running: true }, { pendingInteraction: { kind: 'approval', toolName: 'bash', reason: 'write file', answer() {}, key: 'private', result: Promise.resolve(), secret: 'SECRET' } });
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.needsAttention, true);
  assert.equal(snapshot.approvalStatusAvailable, true);
  assert.deepEqual(snapshot.approval, { kind: 'approval', toolName: 'bash', reason: 'write file' });
  assert.doesNotMatch(JSON.stringify(snapshot), /answer|private|SECRET/);
  assert.equal(extractRuntimeSnapshot([]).approvalStatusAvailable, false);
});

test('initial errors, prompt errors and blocked state are visible without inventing approval', () => {
  assert.equal(extractRuntimeSnapshot([], { openError: { message: 'cannot open' } }).error, 'cannot open');
  assert.equal(extractRuntimeSnapshot([], { promptError: { error: { message: 'admission refused' } } }).error, 'admission refused');
  const blocked = extractRuntimeSnapshot([event(1, 'turn/end', { turn: 1, reason: { kind: 'blocked' } })]);
  assert.equal(blocked.needsAttention, true);
  assert.equal(blocked.approval, null);
});

test('currentWorkspaceCwd uses selected mainView ownership only and refuses ambiguous or recent guesses', () => {
  const f = fixture({ byId: { old: { cwd: '/old', retainedBy: {} }, selected: { cwd: '/active', retainedBy: { mainView: 1 } } } });
  assert.equal(currentWorkspaceCwd(f.ctx), '/active');
  f.ctx.sessions.list.set({ byId: { a: { cwd: '/a', retainedBy: { mainView: 1 } }, b: { cwd: '/b', retainedBy: { mainView: 1 } } } });
  assert.equal(currentWorkspaceCwd(f.ctx), undefined);
  assert.equal(currentWorkspaceCwd({}), undefined);
});

test('concurrent persistent target creation dedupes and onSession persistence precedes every send', async () => {
  const gate = deferred(), f = fixture({ create: () => gate.promise }), runtime = createBotRuntime(f.ctx), saved = [];
  const a = runtime.acquire({ id: 'bot-a', agentPreset: 'standard', cwd: '/project' }, { onSession: async id => { saved.push(id); } });
  const b = runtime.acquire({ id: 'bot-a' }, { onSession: async id => { saved.push(id); } });
  gate.resolve('persistent-a');
  const [ha, hb] = await Promise.all([a, b]);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0], { agentPreset: 'standard', cwd: '/project' });
  assert.equal(f.retains.length, 1);
  assert.deepEqual(saved, ['persistent-a', 'persistent-a']);
  assert.equal(ha.snapshot().sessionId, 'persistent-a');
  const result = await ha.send('hello');
  assert.deepEqual(result, { sessionId: 'persistent-a', accepted: true });
  assert.equal(f.native('persistent-a').prompts[0].mode, 'queue');
  ha.release(); hb.release();
  assert.equal(f.native('persistent-a').releases, 0, 'Active admitted tasks survive all UI handle releases');
  f.native('persistent-a').finish();
  assert.equal(f.native('persistent-a').releases, 1);
  runtime.dispose();
});

test('existing session resumes instead of creating or silently changing its preset', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  const handle = await runtime.acquire({ id: 'existing-bot', sessionId: 'existing', agentPreset: 'standard' });
  assert.equal(f.created.length, 0);
  assert.equal(handle.sessionId, 'existing');
  handle.open();
  assert.deepEqual(f.opened, ['existing']);
  await handle.loadOlder();
  assert.equal(f.native('existing').older, 1);
  handle.release();
  assert.equal(f.native('existing').releases, 1);
  await assert.rejects(runtime.acquire({ id: 'existing-bot', sessionId: 'different' }), /different session/);
  runtime.dispose();
});

test('onSession is awaited and a failed storage callback never submits or recreates a session', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx), save = deferred();
  const sending = runtime.send({ id: 'a' }, 'hello', { onSession: () => save.promise });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.created.length, 1);
  assert.equal(f.retains.length, 0);
  save.reject(new Error('disk full'));
  await assert.rejects(sending, /disk full/);
  const handle = await runtime.acquire({ id: 'a' });
  assert.equal(f.created.length, 1);
  handle.release(); runtime.dispose();
});

test('watch emits initial snapshot and safe changes; unsubscribe releases idle references exactly once', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx), changes = [];
  const off = await runtime.watch('s', value => changes.push(value));
  assert.equal(changes.length, 1);
  f.native('s').push(event(1, 'user/message', { content: [{ type: 'text', text: 'hello' }] }));
  assert.equal(changes.at(-1).messages[0].text, 'hello');
  assert.equal(runtime.snapshot('s').lastSeq, 1);
  off(); off();
  assert.equal(f.native('s').releases, 1);
  assert.equal(f.native('s').events.count, 0);
  assert.equal(runtime.snapshot('s'), null);
  runtime.dispose();
});

test('a misbehaving UI watcher cannot break runtime tracking', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  const off = await runtime.watch('s', () => { throw new Error('UI broke'); });
  assert.doesNotThrow(() => f.native('s').push(event(1, 'turn/start', { turn: 1 })));
  off(); runtime.dispose();
});

test('native approval retains the task until attention clears, open delegates to native UI, never answers', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  const handle = await runtime.acquire({ id: 'a', sessionId: 's' });
  let answered = false;
  f.status.set(new Map([['s', { pendingInteraction: { kind: 'approval', toolName: 'bash', reason: 'Run command', answer() { answered = true; } } }]]));
  assert.equal(runtime.snapshot('s').needsAttention, true);
  handle.release();
  assert.equal(f.native('s').releases, 0);
  runtime.open('s');
  assert.deepEqual(f.opened, ['s']);
  assert.equal(answered, false);
  f.status.set(new Map());
  assert.equal(f.native('s').releases, 1);
  runtime.dispose();
});

test('runtime.send admission failure releases, does not claim completion, and can retry with same session', async () => {
  let fail = true;
  const f = fixture({ prompt: () => fail ? { ok: false, error: { message: 'not accepted' } } : { ok: true } }), runtime = createBotRuntime(f.ctx);
  await assert.rejects(runtime.send({ id: 'a' }, 'hello'), /not accepted/);
  assert.equal(f.native('native-1').releases, 1);
  fail = false;
  assert.equal((await runtime.send({ id: 'a' }, 'retry')).accepted, true);
  assert.equal(f.created.length, 1);
  f.native('native-1').finish();
  runtime.dispose();
});

test('multiple queued sends retain until their separate terminal boundaries', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  await runtime.send({ id: 'a' }, 'first');
  await runtime.send({ id: 'a' }, 'second');
  const native = f.native('native-1');
  native.finish(1);
  assert.equal(native.releases, 0);
  native.finish(2);
  assert.equal(native.releases, 1);
  runtime.dispose();
});

test('runtime cancel uses native API and never creates an uninitialized Bot', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  assert.deepEqual(await runtime.cancel({ id: 'unknown' }), { accepted: false });
  assert.equal(f.created.length, 0);
  const handle = await runtime.acquire({ id: 'a', sessionId: 's' });
  await runtime.cancel({ id: 'a' });
  assert.equal(f.native('s').cancels, 1);
  handle.release(); runtime.dispose();
});

test('cancellation rejection surfaces native error without hidden approval or double release', async () => {
  const f = fixture({ cancel: () => ({ ok: false, error: { message: 'cancel refused' } }) }), runtime = createBotRuntime(f.ctx);
  await assert.rejects(runtime.cancel('s'), /cancel refused/);
  assert.equal(f.native('s').releases, 1);
  runtime.dispose();
});

test('dispose releases references but deliberately does not cancel Host background work', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  const off = await runtime.watch('s', () => {});
  await runtime.send({ id: 'a', sessionId: 's' }, 'work');
  runtime.dispose(); runtime.dispose(); off();
  assert.equal(f.native('s').releases, 1);
  assert.equal(f.native('s').cancels, 0);
  assert.equal(f.status.count, 0);
  await assert.rejects(runtime.acquire({ id: 'a' }), /disposed/);
});

test('dispose while history opening releases once and rejects stale acquisition', async () => {
  const ready = deferred(), f = fixture({ ready: () => ready.promise }), runtime = createBotRuntime(f.ctx);
  const acquiring = runtime.acquire({ id: 'a', sessionId: 's' });
  await new Promise(resolve => setImmediate(resolve));
  runtime.dispose();
  ready.resolve({ session: f.native('s').session, eventSource: f.native('s').events });
  await assert.rejects(acquiring, /disposed/);
  assert.equal(f.native('s').releases, 1);
});

test('readiness rejection cleans subscriptions and permits later retry', async () => {
  let fail = true;
  const f = fixture({ ready: item => fail ? Promise.reject(new Error('open failed')) : Promise.resolve({ session: item.session, eventSource: item.events }) }), runtime = createBotRuntime(f.ctx);
  await assert.rejects(runtime.watch('s', () => {}), /open failed/);
  assert.equal(f.native('s').releases, 1);
  fail = false;
  const off = await runtime.watch('s', () => {});
  off();
  assert.equal(f.native('s').releases, 2);
  runtime.dispose();
});

test('per-target persistence callbacks are serialized while separate targets remain independent', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx), firstSave = deferred(), order = [];
  const first = runtime.acquire({ id: 'a' }, { onSession: async () => { order.push('first-start'); await firstSave.promise; order.push('first-end'); } });
  const second = runtime.acquire({ id: 'a' }, { onSession: () => { order.push('second'); } });
  const other = await runtime.acquire({ id: 'b' });
  assert.deepEqual(order, ['first-start']);
  firstSave.resolve();
  const [ha, hb] = await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  ha.release(); hb.release(); other.release(); runtime.dispose();
});

test('disposal while create is pending still saves the created Host session before rejecting stale handle', async () => {
  const creating = deferred(), saved = [], f = fixture({ create: () => creating.promise }), runtime = createBotRuntime(f.ctx);
  const acquiring = runtime.acquire({ id: 'a' }, { onSession: id => saved.push(id) });
  await new Promise(resolve => setImmediate(resolve));
  runtime.dispose(); creating.resolve('late-host-session');
  await assert.rejects(acquiring, /disposed/);
  assert.deepEqual(saved, ['late-host-session']);
  assert.equal(f.retains.length, 0);
});

test('an error from an older persistent turn does not retire newly admitted background work', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx), native = f.native('s');
  native.push(event(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'old error' } } }));
  native.seq = 1;
  native.state.set({ ...native.state.getSnapshot(), lastAgentError: 'old error' });
  await runtime.send({ id: 'a', sessionId: 's' }, 'try again');
  assert.equal(native.releases, 0);
  native.finish(2);
  assert.equal(native.releases, 1);
  runtime.dispose();
});

test('partial subscription setup cleans earlier subscriptions if later setup throws', async () => {
  const f = fixture(), native = f.native('s');
  native.session.subscribe = () => { throw new Error('subscription failed'); };
  const runtime = createBotRuntime(f.ctx);
  await assert.rejects(runtime.watch('s', () => {}), /subscription failed/);
  assert.equal(native.events.count, 0);
  assert.equal(native.releases, 1);
  runtime.dispose();
});

test('status availability is true when native UI status service exists but session has no pending entry', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  const handle = await runtime.acquire({ id: 'a', sessionId: 's' });
  assert.equal(handle.snapshot().approvalStatusAvailable, true);
  handle.release(); runtime.dispose();
});

test('target validation, empty sends, unsupported mode, released handles and native navigation fail explicitly', async () => {
  const f = fixture(), runtime = createBotRuntime(f.ctx);
  await assert.rejects(runtime.acquire({}), /stable/);
  const handle = await runtime.acquire({ id: 'a', sessionId: 's' });
  await assert.rejects(handle.send(' '), /empty/);
  await assert.rejects(handle.send('x', { mode: 'wrong' }), /Unsupported/);
  handle.release();
  await assert.rejects(handle.send('x'), /released/);
  delete f.ctx.uiWorkspace;
  assert.throws(() => runtime.open('s'), /unavailable/);
  runtime.dispose();
});
