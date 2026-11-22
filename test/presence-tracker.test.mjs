import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceTracker } from '../src/presence-tracker.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const listeners = new Map(), watched = [], released = [], changes = [], values = new Map();
  function source(initial) { let value = initial; const subs = new Set(); return { getSnapshot: () => value, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, publish(next) { value = next; for (const fn of subs) fn(); }, count: () => subs.size }; }
  const statusSource = source(new Map()), catalogSource = source({ byId: {} });
  const runtime = {
    snapshot: id => values.get(id) || null,
    async watch(id, callback) { watched.push(id); if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id).add(callback); callback(values.get(id) || { sessionId: id, running: false }); if (options.ready) await options.ready; return () => { released.push(id); listeners.get(id).delete(callback); }; }
  };
  const tracker = createPresenceTracker(runtime, { statusSource, catalogSource, onChange: next => changes.push(next), ...options });
  const bots = Array.from({ length: 12 }, (_, i) => ({ id: `bot-${i}`, sessionId: `session-${i}`, archived: false }));
  const publish = (id, patch) => { const next = { sessionId: id, ...patch }; values.set(id, next); for (const fn of listeners.get(id) || []) fn(next); };
  return { tracker, runtime, bots, watched, released, changes, publish, statusSource, catalogSource };
}
test('passive observers are bounded and never start a native task', async t => {
  const f = fixture({ maxWatched: 3 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots, enabled: true }); await tick();
  assert.deepEqual(f.watched, ['session-0', 'session-1', 'session-2']);
  assert.equal(Object.keys(f.tracker.getSnapshot()).length, 12);
  assert.ok(Object.values(f.tracker.getSnapshot()).every(p => p.state === 'idle'));
});
test('selected and genuinely running Bot sessions are prioritized over idle list order', async t => {
  const f = fixture({ maxWatched: 2 }); t.after(() => f.tracker.dispose());
  f.statusSource.publish(new Map([['session-11', { running: true }]]));
  f.tracker.update({ bots: f.bots, enabled: true, selectedBotId: 'bot-10' }); await tick();
  assert.deepEqual(new Set(f.watched), new Set(['session-10', 'session-11']));
  assert.equal(f.tracker.getSnapshot()['bot-11'].state, 'thinking');
});
test('inactive Bot tool updates are observable without switching the conversation', async t => {
  const f = fixture({ maxWatched: 3 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 3), enabled: true, selectedBotId: 'bot-0' }); await tick();
  f.publish('session-2', { running: true, latestTurn: 2, activities: [{ status: 'running', toolName: 'web_search', turn: 2, seq: 21 }] });
  assert.equal(f.tracker.getSnapshot()['bot-2'].state, 'researching');
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'idle');
});
test('selected session reassignment and archived sessions release old references', async t => {
  const f = fixture({ maxWatched: 2 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 2), enabled: true }); await tick();
  f.tracker.update({ bots: [{ ...f.bots[0], sessionId: 'replacement' }, { ...f.bots[1], archived: true }] }); await tick();
  assert.deepEqual(new Set(f.released), new Set(['session-0', 'session-1']));
  assert.equal(f.watched.at(-1), 'replacement');
});
test('closing the panel releases passive references, pending receipts included', async () => {
  let resolve; const ready = new Promise(r => { resolve = r; });
  const f = fixture({ maxWatched: 1, ready });
  f.tracker.update({ bots: f.bots, enabled: true }); await tick();
  f.tracker.update({ enabled: false }); resolve(); await tick();
  assert.deepEqual(f.released, ['session-0']); f.tracker.dispose();
});
test('local job snapshots represent working Bots even beyond the passive watch limit', async t => {
  const f = fixture({ maxWatched: 1 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots, enabled: true, jobs: { 'bot-11': { status: 'running', snapshot: { sessionId: 'session-11', running: true, activities: [{ status: 'running', toolName: 'functions.bash', seq: 9 }] } } } }); await tick();
  assert.equal(f.tracker.getSnapshot()['bot-11'].state, 'coding');
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'idle');
});
test('persisted running metadata alone never starts a busy animation', async t => {
  const f = fixture(); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 1), runs: [{ botId: 'bot-0', status: 'running', sessionId: 'session-0' }], enabled: false });
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'idle');
  assert.equal(f.tracker.getSnapshot()['bot-0'].label, '待核实');
  assert.equal(f.watched.length, 0);
});
test('status-only approval is truthful and does not disclose interaction arguments', async t => {
  const f = fixture({ maxWatched: 0 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 1), enabled: true });
  f.statusSource.publish(new Map([['session-0', { pendingInteraction: { kind: 'approval', args: 'private token' } }]]));
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'waiting');
  assert.ok(!JSON.stringify(f.tracker.getSnapshot()).includes('private token'));
});
test('completion feedback expires once, and identical updates do not rerender', async t => {
  const timers = new Map(); let clock = 100000, counter = 0;
  const f = fixture({ now: () => clock, setTimer: (fn, ms) => { const id = ++counter; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 1), enabled: true }); await tick();
  f.publish('session-0', { running: false, lastTurnEnd: { seq: 30, reason: 'completed', time: clock } });
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'completed');
  assert.equal(timers.size, 1); const count = f.changes.length;
  f.tracker.update({ connected: true }); assert.equal(f.changes.length, count);
  const timer = [...timers.values()][0]; clock += timer.ms; timer.fn();
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'idle');
});
test('closing before observer attachment never opens a needless native reference', async () => {
  const f = fixture();
  f.tracker.update({ bots: f.bots, enabled: true });
  f.tracker.update({ enabled: false }); await tick();
  assert.deepEqual(f.watched, []); f.tracker.dispose();
});
test('a transient watch failure can recover on a later refresh without an unbounded retry loop', async t => {
  let clock = 10000, attempts = 0, releases = 0;
  const tracker = createPresenceTracker({ snapshot: () => null, async watch(id, callback) { if (++attempts === 1) throw new Error('temporary'); callback({ sessionId: id, running: false }); return () => releases++; } }, { now: () => clock });
  t.after(() => tracker.dispose());
  tracker.update({ bots: [{ id: 'bot', sessionId: 'session' }], enabled: true }); await tick();
  assert.equal(tracker.getSnapshot().bot.state, 'error');
  tracker.update({ connected: true }); await tick(); assert.equal(attempts, 1);
  clock += 1600; tracker.update({ connected: true }); await tick();
  assert.equal(attempts, 2); assert.equal(tracker.getSnapshot().bot.state, 'idle');
  tracker.dispose(); assert.equal(releases, 1);
});
test('a coarse stale catalog running flag does not erase a freshly observed completion', async t => {
  const f = fixture({ maxWatched: 1 }); t.after(() => f.tracker.dispose());
  f.tracker.update({ bots: f.bots.slice(0, 1), enabled: true }); await tick();
  f.publish('session-0', { running: false, lastTurnEnd: { seq: 80, reason: 'completed', time: Date.now() } });
  f.catalogSource.publish({ byId: { 'session-0': { running: true } } });
  assert.equal(f.tracker.getSnapshot()['bot-0'].state, 'completed');
});
test('disposal stops sources and ignores late watcher callbacks', async () => {
  const f = fixture({ maxWatched: 1 });
  f.tracker.update({ bots: f.bots, enabled: true }); await tick(); f.tracker.dispose();
  const count = f.changes.length;
  f.publish('session-0', { running: true });
  assert.equal(f.changes.length, count);
  assert.equal(f.statusSource.count(), 0); assert.equal(f.catalogSource.count(), 0);
  assert.deepEqual(f.released, ['session-0']);
});
