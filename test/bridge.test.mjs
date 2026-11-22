import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDshBridge } from '../src/bridge.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observable(initial) {
  let snapshot = initial;
  const listeners = new Set();
  const stats = { subscribed: 0, unsubscribed: 0 };
  return {
    stats, listeners,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      stats.subscribed++;
      listeners.add(listener);
      return () => { stats.unsubscribed++; listeners.delete(listener); };
    },
    set(value) { snapshot = value; for (const listener of [...listeners]) listener(); }
  };
}

function harness(t, options = {}) {
  const events = observable({ entries: [] });
  const state = observable({});
  const prompted = deferred();
  const calls = { create: [], retain: [], prompt: [], cancel: 0, release: 0 };
  const session = {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    async prompt(...args) {
      calls.prompt.push(args);
      prompted.resolve();
      return options.prompt ? options.prompt(...args) : { ok: true };
    },
    async cancel() {
      calls.cancel++;
      return options.cancel ? options.cancel() : { ok: true };
    }
  };
  const binding = { session, eventSource: events };
  const ref = {
    ready: options.ready ? options.ready(binding) : Promise.resolve(binding),
    release() { calls.release++; }
  };
  const bridge = createDshBridge({ sessions: {
    async create(...args) { calls.create.push(args); return options.create ? options.create() : 'session-1'; },
    retain(...args) { calls.retain.push(args); if (options.retain) return options.retain(ref); return ref; }
  } });
  t.after(() => bridge.dispose());
  const finish = (reason = { kind: 'completed' }, answer = 'answer') => events.set({ entries: [
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } } },
    { type: 'event', event: { type: 'turn/end', data: { reason } } }
  ] });
  const assertClean = (retained = true) => {
    assert.equal(calls.release, retained ? 1 : 0, 'release exactly once iff retained');
    for (const source of [events, state]) {
      assert.equal(source.listeners.size, 0, 'no leaked subscriptions');
      assert.equal(source.stats.subscribed, source.stats.unsubscribed, 'unsubscribe exactly once');
    }
  };
  return { bridge, calls, events, state, session, binding, ref, prompted: prompted.promise, finish, assertClean };
}

test('bridge success uses authenticated preset/retain/queue APIs, streams updates, and releases once', async t => {
  const h = harness(t);
  const sessions = [], updates = [];
  const run = h.bridge.run('quoted prompt', { onSession: id => sessions.push(id), onUpdate: value => updates.push(value) });
  await h.prompted;
  assert.deepEqual(h.calls.create, [[{ agentPreset: 'dsh-bot' }]]);
  assert.deepEqual(h.calls.retain, [['session-1', { source: 'dsh-bot' }]]);
  assert.deepEqual(h.calls.prompt, [[[{ type: 'text', text: 'quoted prompt' }], 'queue']]);
  assert.deepEqual(sessions, ['session-1']);
  h.events.set({ entries: [{ type: 'transient', event: { type: 'assistant/live-chunk', data: { attemptId: 'a', chunk: { type: 'text-delta', text: 'par' } } } }] });
  h.finish();
  assert.deepEqual(await run, { text: 'answer', ended: true, reason: 'completed', sessionId: 'session-1', stopped: false });
  assert.deepEqual(updates.filter(Boolean), ['par', 'answer']); // Initial snapshot may publish empty text.
  assert.equal(h.calls.cancel, 0);
  h.assertClean();
  await h.bridge.stop();
  h.bridge.dispose();
  h.bridge.dispose();
  assert.equal(h.calls.cancel, 0);
  h.assertClean();
});

test('bridge prevents concurrent runs without disturbing active work', async t => {
  const h = harness(t);
  const run = h.bridge.run('first');
  await h.prompted;
  await assert.rejects(h.bridge.run('second'), /已有一条/);
  assert.equal(h.calls.create.length, 1);
  h.finish();
  await run;
  h.assertClean();
});

test('bridge clears admission lock so a subsequent run succeeds', async t => {
  let admissions = 0;
  const h = harness(t, { prompt: () => ++admissions === 1 ? { ok: false } : { ok: true } });
  await assert.rejects(h.bridge.run('first'), /未接受/);
  const second = h.bridge.run('second');
  await nextTurn();
  h.finish();
  assert.equal((await second).text, 'answer');
  assert.equal(h.calls.create.length, 2);
  assert.equal(h.calls.release, 2);
  assert.equal(h.events.listeners.size, 0);
  assert.equal(h.state.listeners.size, 0);
});

for (const [name, receipt, expected] of [
  ['detailed', { ok: false, error: { message: 'admission denied' } }, /admission denied/],
  ['fallback', { ok: false }, /DSH 未接受/]
]) test(`bridge cleans up ${name} admission failure`, async t => {
  const h = harness(t, { prompt: () => receipt });
  await assert.rejects(h.bridge.run('q'), expected);
  assert.equal(h.calls.cancel, 0);
  h.assertClean();
});

test('bridge cleans up when prompt admission rejects rather than returning a receipt', async t => {
  const h = harness(t, { prompt: () => { throw new Error('transport admission failed'); } });
  await assert.rejects(h.bridge.run('q'), /transport admission failed/);
  h.assertClean();
});

test('bridge observes completion emitted synchronously during admission', async t => {
  let h;
  h = harness(t, { prompt: () => { h.finish(); return { ok: true }; } });
  assert.equal((await h.bridge.run('q')).text, 'answer');
  h.assertClean();
});

test('bridge attaches a rejection handler before asynchronous admission settles', async t => {
  const admission = deferred();
  const h = harness(t, { prompt: () => admission.promise });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /admission failed/);
  await h.prompted;
  h.state.set({ lastAgentError: 'early agent error' });
  await nextTurn(); // An unhandled completion rejection would fail node:test here.
  admission.reject(new Error('admission failed'));
  await rejected;
  h.assertClean();
});

test('bridge releases nothing when session creation rejects and can retry', async t => {
  let count = 0;
  const h = harness(t, { create: () => { if (++count === 1) throw new Error('create failed'); return 'retry-session'; } });
  await assert.rejects(h.bridge.run('first'), /create failed/);
  h.assertClean(false);
  const retry = h.bridge.run('retry');
  await h.prompted;
  h.finish();
  assert.equal((await retry).sessionId, 'retry-session');
  h.assertClean();
});

test('bridge handles a retain failure without releasing an unacquired reference', async t => {
  const h = harness(t, { retain: () => { throw new Error('retain failed'); } });
  await assert.rejects(h.bridge.run('q'), /retain failed/);
  h.assertClean(false);
});

test('bridge releases a retained reference when readiness rejects', async t => {
  const readiness = deferred();
  const h = harness(t, { ready: () => readiness.promise });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /ready failed/);
  await nextTurn();
  readiness.reject(new Error('ready failed'));
  await rejected;
  assert.equal(h.calls.prompt.length, 0);
  h.assertClean();
});

for (const [snapshot, expected] of [
  [{ lastAgentError: 'model failed' }, /model failed/],
  [{ openError: { message: 'connection failed' } }, /connection failed/],
  [{ openError: {} }, /会话连接失败/]
]) test(`bridge rejects session error ${String(expected)} and cleans subscriptions`, async t => {
  const h = harness(t);
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, expected);
  await h.prompted;
  h.state.set(snapshot);
  await rejected;
  h.assertClean();
});

for (const [snapshot, expected] of [
  [{ lastAgentError: 'preexisting model failure' }, /preexisting model failure/],
  [{ openError: { message: 'preexisting connection failure' } }, /preexisting connection failure/]
]) test(`bridge immediately detects a preexisting session error ${String(expected)}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  h.state.set(snapshot); // No publication after subscribing: the bridge must inspect the initial snapshot.
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, expected);
  await nextTurn();
  t.mock.timers.tick(300000); // Bound the regression: broken code times out instead of hanging the suite.
  await rejected;
  assert.equal(h.calls.cancel, 0, 'preexisting errors must fail before timeout');
  h.assertClean();
});

test('bridge prefers a completed result over a simultaneously present session error', async t => {
  const h = harness(t);
  const run = h.bridge.run('q');
  await h.prompted;
  h.finish();
  h.state.set({ lastAgentError: 'stale failure' });
  assert.equal((await run).text, 'answer');
  h.assertClean();
});

for (const kind of ['completed', 'aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
  test(`bridge preserves partial output and normalizes structured ${kind} turn ending`, async t => {
    const h = harness(t);
    const run = h.bridge.run('q');
    await h.prompted;
    h.finish({ kind, ...(kind === 'aborted' ? { reason: { kind: 'legacy' } } : {}) }, 'partial');
    assert.deepEqual(await run, { text: 'partial', ended: true, reason: kind, sessionId: 'session-1', stopped: kind === 'aborted' });
    h.assertClean();
  });
}

test('bridge stop while idle is a harmless no-op', async t => {
  const h = harness(t);
  await h.bridge.stop();
  assert.equal(h.calls.cancel, 0);
  assert.equal(h.calls.create.length, 0);
});

test('bridge stop cancels active generation and preserves partial text', async t => {
  const h = harness(t);
  const run = h.bridge.run('q');
  await h.prompted;
  await nextTurn(); // Admission has completed; this exercises active generation, not its race.
  await h.bridge.stop();
  assert.equal(h.calls.cancel, 1);
  h.finish({ kind: 'aborted', reason: { kind: 'legacy' } }, 'partial answer');
  const result = await run;
  assert.equal(result.stopped, true);
  assert.equal(result.text, 'partial answer');
  h.assertClean();
});

test('bridge stop flag remains true even if cancellation races with normal completion', async t => {
  const h = harness(t);
  const run = h.bridge.run('q');
  await h.prompted;
  await nextTurn(); // Admission has completed; this exercises active generation, not its race.
  await h.bridge.stop();
  h.finish();
  assert.equal((await run).stopped, true);
  h.assertClean();
});

for (const [receipt, expected] of [
  [{ ok: false, error: { message: 'cancel denied' } }, /cancel denied/],
  [{ ok: false }, /停止失败/]
]) test(`bridge stop surfaces failed cancellation receipt ${String(expected)}`, async t => {
  const h = harness(t, { cancel: () => receipt });
  const run = h.bridge.run('q');
  await h.prompted;
  await assert.rejects(h.bridge.stop(), expected);
  h.finish();
  assert.equal((await run).stopped, true);
  h.assertClean();
});

test('bridge stop surfaces cancellation transport rejection without double release', async t => {
  const h = harness(t, { cancel: () => { throw new Error('cancel transport'); } });
  const run = h.bridge.run('q');
  await h.prompted;
  await nextTurn();
  await assert.rejects(h.bridge.stop(), /cancel transport/);
  h.finish();
  await run;
  h.assertClean();
});

for (const action of ['stop', 'dispose']) {
  test(`bridge ${action} before creation finishes never retains or submits a session`, async t => {
    const creation = deferred();
    const h = harness(t, { create: () => creation.promise });
    const run = h.bridge.run('q');
    const rejected = assert.rejects(run, /已停止/);
    await h.bridge[action]();
    creation.resolve('late-session');
    await rejected;
    assert.equal(h.calls.retain.length, 0);
    assert.equal(h.calls.prompt.length, 0);
    assert.equal(h.calls.cancel, 0);
    h.assertClean(false);
  });

  test(`bridge ${action} before reference readiness releases exactly once without submitting`, async t => {
    const readiness = deferred();
    const h = harness(t, { ready: () => readiness.promise });
    const run = h.bridge.run('q');
    const rejected = assert.rejects(run, /已停止/);
    await nextTurn();
    assert.equal(h.calls.retain.length, 1);
    await h.bridge[action]();
    readiness.resolve(h.binding);
    await rejected;
    assert.equal(h.calls.prompt.length, 0);
    h.assertClean();
  });
}

test('bridge cancellation during admission requests cancellation again after acceptance, releasing only once', async t => {
  const admission = deferred();
  const h = harness(t, { prompt: () => admission.promise });
  const run = h.bridge.run('q');
  await h.prompted;
  await nextTurn(); // Admission has completed; this exercises active generation, not its race.
  await h.bridge.stop();
  admission.resolve({ ok: true });
  await nextTurn();
  assert.ok(h.calls.cancel >= 1);
  h.finish({ kind: 'aborted' });
  assert.equal((await run).stopped, true);
  h.assertClean();
});

test('bridge dispose rejects active generation, swallows cancel rejection, and permanently prevents new runs', async t => {
  const h = harness(t, { cancel: () => { throw new Error('offline cancel'); } });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /插件已卸载/);
  await h.prompted;
  await nextTurn();
  h.bridge.dispose();
  await rejected;
  assert.equal(h.calls.cancel, 1);
  await assert.rejects(h.bridge.run('again'), /插件已卸载/);
  h.bridge.dispose();
  await h.bridge.stop();
  h.assertClean();
});

test('bridge dispose during admission safely handles both completion rejection and admission rejection', async t => {
  const admission = deferred();
  const h = harness(t, { prompt: () => admission.promise });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /admission failure/);
  await h.prompted;
  h.bridge.dispose();
  await nextTurn();
  admission.reject(new Error('admission failure'));
  await rejected;
  h.assertClean();
});

test('bridge disposal during successful admission preserves unload error even when cancel rejects', async t => {
  const admission = deferred();
  const h = harness(t, { prompt: () => admission.promise, cancel: () => { throw new Error('cancel transport rejected'); } });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /插件已卸载/);
  await h.prompted;
  h.bridge.dispose();
  admission.resolve({ ok: true });
  await rejected;
  assert.equal(h.calls.cancel, 1, 'dispose already requested cancellation; do not cancel again after admission');
  h.assertClean();
});

test('bridge dispose after resolution does not cancel or release the completed session twice', async t => {
  const h = harness(t);
  const run = h.bridge.run('q');
  await h.prompted;
  h.finish();
  await run;
  h.bridge.dispose();
  h.events.set({ entries: [] });
  h.state.set({ lastAgentError: 'late event' });
  assert.equal(h.calls.cancel, 0);
  h.assertClean();
});

test('bridge cleans up when onSession throws before subscriptions are registered', async t => {
  const h = harness(t);
  await assert.rejects(h.bridge.run('q', { onSession() { throw new Error('callback failed'); } }), /callback failed/);
  assert.equal(h.calls.prompt.length, 0);
  h.assertClean();
});

test('bridge times out after five minutes, requests cancellation, and releases exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { cancel: () => { throw new Error('offline'); } });
  const run = h.bridge.run('q');
  const rejected = assert.rejects(run, /超过 5 分钟/);
  await h.prompted;
  t.mock.timers.tick(299999);
  assert.equal(h.calls.cancel, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(h.calls.cancel, 1);
  h.assertClean();
});

test('bridge clears timeout after success and after rejected admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const success = harness(t);
  const run = success.bridge.run('q');
  await success.prompted;
  success.finish();
  await run;
  const failure = harness(t, { prompt: () => ({ ok: false }) });
  await assert.rejects(failure.bridge.run('q'), /未接受/);
  t.mock.timers.tick(600000);
  assert.equal(success.calls.cancel, 0);
  assert.equal(failure.calls.cancel, 0);
  success.assertClean();
  failure.assertClean();
});
