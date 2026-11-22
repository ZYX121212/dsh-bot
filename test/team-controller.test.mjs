import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTeamController } from '../src/team-controller.mjs';
import { emptyTeamWorkspace } from '../src/team-core.mjs';
import { dispatchIdFromPrompt } from '../src/runtime.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const botA = randomUUID(), botB = randomUUID(), groupId = randomUUID();
  let workspace = { ...emptyTeamWorkspace(), revision: 1, primaryBotId: botA,
    bots: [{ id: botA, name: 'Milo', role: 'Primary', avatar: { color: '#8b78d8', shape: 'circle' }, sessionId: 'session-a', archived: false }, { id: botB, name: 'Scout', role: 'Research', avatar: { color: '#79a893', shape: 'hexagon' }, sessionId: 'session-b', archived: false }],
    groups: [{ id: groupId, name: 'Project', memberIds: [botA, botB], messages: [], archived: false }] };
  if (options.workspace) workspace = options.workspace(workspace, { botA, botB, groupId });
  const calls = [], sends = [], acquisitions = [], opened = [], snapshots = new Map(), watchers = new Map(), cancelled = [], released = [], admitted = new Set();
  let disposed = false;
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  function snapshot(sessionId) {
    if (!snapshots.has(sessionId)) snapshots.set(sessionId, { sessionId, messages: [{ id: 'old', role: 'assistant', text: 'old answer', seq: 10, time: 10 }], activities: [], files: [], lastSeq: 10, latestTurn: 1, lastTurnEnd: { turn: 1, reason: 'completed', seq: 10 }, running: false, error: null, needsAttention: false, approval: null });
    return snapshots.get(sessionId);
  }
  function publish(sessionId, patch) {
    snapshots.set(sessionId, { ...snapshot(sessionId), ...patch });
    for (const callback of [...(watchers.get(sessionId) ?? [])]) callback(snapshot(sessionId));
  }
  function finish(sessionId, text = 'new answer', reason = 'completed') {
    const previous = snapshot(sessionId), seq = previous.lastSeq + 2, turn = previous.running ? previous.latestTurn : (previous.latestTurn ?? 1) + 1;
    publish(sessionId, { running: false, needsAttention: false, approval: null, lastSeq: seq, latestTurn: turn, lastTurnEnd: { turn, reason, seq }, messages: [...previous.messages, { id: `assistant-${seq}`, role: 'assistant', text, turn, seq: seq - 1, time: seq }] });
  }
  const runtime = {
    async acquire(target, opts = {}) {
      acquisitions.push(clone(target));
      const sessionId = target.sessionId || `session-created-${target.id}`;
      if (options.beforeAcquire) await options.beforeAcquire(target);
      await opts.onSession?.(sessionId);
      return { sessionId, snapshot: () => snapshot(sessionId),
        async send(text) {
          sends.push({ sessionId, text });
          const previous = snapshot(sessionId), seq = previous.lastSeq + 1, turn = (previous.latestTurn ?? 1) + 1;
          publish(sessionId, { running: true, latestTurn: turn, lastSeq: seq, messages: [...previous.messages, { id: `user-${seq}`, role: 'user', text, dispatchId: dispatchIdFromPrompt(text), turn, seq }] });
          if (options.onSend) await options.onSend({ sessionId, text, finish, publish, snapshot });
          admitted.add(sessionId);
          return { sessionId, accepted: true };
        },
        async cancel() { cancelled.push(sessionId); if (options.onCancel) await options.onCancel({ sessionId, finish, publish, snapshot }); if (admitted.has(sessionId) && options.finishOnCancel !== false) finish(sessionId, '', 'aborted'); return { accepted: true }; },
        release() { released.push(sessionId); }, open() { opened.push(sessionId); }, async loadOlder() {} };
    },
    async watch(sessionId, callback) {
      if (!watchers.has(sessionId)) watchers.set(sessionId, new Set());
      watchers.get(sessionId).add(callback);
      callback(snapshot(sessionId));
      return () => watchers.get(sessionId)?.delete(callback);
    },
    snapshot, open: sessionId => opened.push(sessionId),
    async cancel(sessionId) { cancelled.push(sessionId); if (admitted.has(sessionId)) finish(sessionId, '', 'aborted'); },
    dispose() { disposed = true; watchers.clear(); },
    currentCwd: () => '/project'
  };
  function update(request) {
    switch (request.action) {
      case 'setSession': workspace.bots.find(bot => bot.id === request.botId).sessionId = request.sessionId; break;
      case 'setPrimary': workspace.primaryBotId = request.id; break;
      case 'createBot': workspace.bots.push({ ...request, id: randomUUID(), sessionId: null, archived: false, avatar: request.avatar ?? { color: '#123456', shape: 'circle' } }); break;
      case 'createGroup': workspace.groups.push({ ...request, id: randomUUID(), archived: false, messages: [] }); break;
      case 'createTask': workspace.tasks.push({ id: randomUUID(), title: request.title, botId: request.botId ?? null, groupId: request.groupId ?? null, sessionId: request.sessionId ?? null, status: 'queued', summary: '' }); break;
      case 'updateTask': Object.assign(workspace.tasks.find(task => task.id === request.id), request.patch); break;
      case 'upsertRun': { const old = workspace.runs.find(run => run.id === request.run.id); if (old) Object.assign(old, request.run); else workspace.runs.push({ ...request.run }); break; }
      case 'appendGroupMessage': { const group = workspace.groups.find(group => group.id === request.groupId); const message = request.message; if (!message.id || !group.messages.some(existing => existing.id === message.id)) group.messages.push({ id: randomUUID(), ...message }); break; }
      default: throw new Error(`Unexpected fixture action ${request.action}`);
    }
    workspace.revision++;
    return clone(workspace);
  }
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { selected: { cwd: '/project', retainedBy: { mainView: 1 } } } }) } },
    connection: { rpc: { async call(channel, endpoint, payload) {
      assert.equal(channel, '/api'); calls.push({ endpoint, payload: clone(payload) });
      if (options.rpc) { const override = await options.rpc(endpoint, payload); if (override) return override; }
      if (endpoint === 'botWorkspace/read') return { ok: true, value: clone(workspace) };
      if (endpoint === 'botWorkspace/update') return { ok: true, value: update(payload.request) };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    } } }
  };
  const controller = createTeamController(ctx, { runtime });
  return { controller, runtime, ctx, botA, botB, groupId, calls, sends, acquisitions, cancelled, opened, released, snapshots, watchers, finish, publish, snapshot, get workspace() { return workspace; }, get disposed() { return disposed; } };
}

async function ready(f, kind = 'bot', id = f.botA) { await f.controller.refresh(); await f.controller.select(kind, id); await nextTurn(); }

test('leaving the panel releases UI-only watchers and reopening restores observation without prompts', async () => {
  const f = fixture(); let off;
  try {
    off = f.controller.subscribe(() => {}); await ready(f); await nextTurn();
    assert.ok([...f.watchers.values()].some(rows => rows.size > 0));
    off(); off = null; await nextTurn();
    assert.ok([...f.watchers.values()].every(rows => rows.size === 0));
    off = f.controller.subscribe(() => {}); await nextTurn(); await nextTurn();
    f.publish('session-a', { messages: [{ id: 'reconnected', role: 'assistant', text: 'live after remount', seq: 30 }] });
    assert.equal(f.controller.getSnapshot().conversation.messages[0].text, 'live after remount');
    assert.equal(f.sends.length, 0); assert.equal(f.cancelled.length, 0);
  } finally { off?.(); f.controller.dispose(); }
});
test('controller uses authenticated workspace RPC and selects persisted native Bot conversation', async () => {
  const f = fixture();
  try { await ready(f); const state = f.controller.getSnapshot(); assert.equal(state.loaded, true); assert.equal(state.selected.id, f.botA); assert.equal(state.conversation.sessionId, 'session-a'); assert.equal(state.conversation.messages[0].text, 'old answer'); assert.equal(f.sends.length, 0); }
  finally { f.controller.dispose(); }
});

test('persistent Bot send waits for new native boundary and excludes old assistant replies', async () => {
  const f = fixture();
  try {
    await ready(f);
    const { taskId } = await f.controller.send('Please investigate');
    await nextTurn();
    assert.equal(f.sends.length, 1);
    assert.equal(f.acquisitions[0].sessionId, 'session-a');
    assert.equal(f.acquisitions[0].agentPreset, 'standard');
    assert.equal(f.acquisitions[0].cwd, '/project');
    assert.equal(f.workspace.tasks.find(task => task.id === taskId).status, 'running');
    assert.match(f.sends[0].text, /Please investigate/);
    f.finish('session-a', 'fresh work result'); await nextTurn();
    const task = f.workspace.tasks.find(task => task.id === taskId), run = f.workspace.runs[0];
    assert.equal(task.status, 'completed'); assert.equal(run.status, 'completed');
    assert.equal(run.summary, 'fresh work result'); assert.doesNotMatch(run.summary, /old answer/);
    assert.equal(Object.keys(f.controller.getSnapshot().jobs).length, 0);
  } finally { f.controller.dispose(); }
});

test('synchronous completion emitted inside admission is not missed by subscription race', async () => {
  const f = fixture({ onSend: ({ sessionId, finish }) => finish(sessionId, 'instant result') });
  try { await ready(f); await f.controller.send('instant'); await nextTurn(); assert.equal(f.workspace.runs[0].status, 'completed'); assert.equal(f.workspace.runs[0].summary, 'instant result'); }
  finally { f.controller.dispose(); }
});

test('session association is durably saved before prompt admission', async () => {
  const saved = deferred(); let f;
  f = fixture({ workspace: workspace => ({ ...workspace, bots: workspace.bots.map(bot => ({ ...bot, sessionId: null })) }), rpc: async (endpoint, payload) => { if (endpoint.endsWith('/update') && payload.request.action === 'setSession') await saved.promise; } });
  try {
    await ready(f); await f.controller.send('persist first'); await nextTurn();
    assert.equal(f.sends.length, 0);
    saved.resolve(); await nextTurn();
    assert.equal(f.sends.length, 1); assert.equal(f.workspace.bots[0].sessionId, `session-created-${f.botA}`);
    f.finish(`session-created-${f.botA}`); await nextTurn();
  } finally { saved.resolve(); f.controller.dispose(); }
});

test('group @everyone routes sequential actual Bot sessions and persists distinct authors/results', async () => {
  const f = fixture();
  try {
    await ready(f, 'group', f.groupId);
    await f.controller.send('@everyone Work together'); await nextTurn();
    assert.deepEqual(f.sends.map(row => row.sessionId), ['session-a']);
    f.finish('session-a', 'Milo result'); await nextTurn();
    assert.deepEqual(f.sends.map(row => row.sessionId), ['session-a', 'session-b']);
    assert.match(f.sends[1].text, /Milo result/, 'Second participant receives previous group result as context');
    f.finish('session-b', 'Scout result'); await nextTurn();
    const messages = f.workspace.groups[0].messages;
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'assistant']);
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.botId), [f.botA, f.botB]);
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.sessionId), ['session-a', 'session-b']);
    assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { f.controller.dispose(); }
});

test('native approvals set waiting status and explicit open navigates without approving', async () => {
  const f = fixture();
  try {
    await ready(f); await f.controller.send('work'); await nextTurn();
    f.publish('session-a', { needsAttention: true, approval: { kind: 'approval', toolName: 'bash', reason: 'Needs approval' } }); await nextTurn();
    assert.equal(f.controller.getSnapshot().jobs[f.botA].status, 'waiting');
    assert.equal(f.workspace.runs[0].status, 'waiting');
    f.controller.openNative(); assert.deepEqual(f.opened, ['session-a']);
    assert.equal(f.cancelled.length, 0);
    f.finish('session-a'); await nextTurn();
  } finally { f.controller.dispose(); }
});

test('normal stop asks native session to cancel, records cancelled, and preserves partial output', async () => {
  const f = fixture();
  try {
    await ready(f); await f.controller.send('work'); await nextTurn();
    await f.controller.stop(f.botA); await nextTurn();
    assert.deepEqual(f.cancelled, ['session-a']);
    assert.equal(f.workspace.runs[0].status, 'cancelled');
    assert.equal(f.workspace.tasks[0].status, 'cancelled');
  } finally { f.controller.dispose(); }
});

test('stop during pending admission reissues cancellation after acceptance rather than leaving work running', async () => {
  const admission = deferred(), f = fixture({ onSend: () => admission.promise });
  try {
    await ready(f); await f.controller.send('work'); await nextTurn();
    await f.controller.stop(f.botA);
    assert.equal(f.cancelled.length, 1);
    admission.resolve(); await nextTurn();
    assert.ok(f.cancelled.length >= 2, 'A pre-admission cancellation is not proof an accepted turn was stopped');
    assert.equal(f.workspace.runs[0].status, 'cancelled');
  } finally { admission.resolve(); f.controller.dispose(); }
});

test('panel unsubscribe does not cancel ongoing native work or discard completion ownership', async () => {
  const f = fixture();
  try {
    await ready(f); const off = f.controller.subscribe(() => {});
    await f.controller.send('background work'); await nextTurn(); off();
    assert.equal(f.cancelled.length, 0);
    f.finish('session-a', 'finished in background'); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed');
    assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { f.controller.dispose(); }
});

test('plugin disposal never cancels Host work or falsely persists its continuing task as failed', async () => {
  const f = fixture();
  await ready(f); await f.controller.send('continue on Host'); await nextTurn();
  f.controller.dispose(); await nextTurn();
  assert.equal(f.disposed, true); assert.equal(f.cancelled.length, 0);
  assert.notEqual(f.workspace.runs[0].status, 'failed', 'Losing observation is not task failure');
  assert.notEqual(f.workspace.tasks[0].status, 'failed', 'Host work may still be running');
});

test('concurrent createBot operations each return their own newly created identity', async () => {
  const f = fixture();
  try {
    await ready(f);
    const [first, second] = await Promise.all([f.controller.createBot({ name: 'First', role: 'one' }), f.controller.createBot({ name: 'Second', role: 'two' })]);
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, 'First'); assert.equal(second.name, 'Second');
  } finally { f.controller.dispose(); }
});

test('group reserves later participants so an unrelated second send cannot steal a scheduled member', async () => {
  const f = fixture();
  try {
    await ready(f, 'group', f.groupId); await f.controller.send('@everyone shared task'); await nextTurn();
    await f.controller.select('bot', f.botB);
    await assert.rejects(f.controller.send('unrelated task'), /工作|参与|排队|等待|任务|忙/);
    f.finish('session-a'); await nextTurn(); f.finish('session-b'); await nextTurn();
  } finally { f.controller.dispose(); }
});

test('refresh recovers an already persisted run from native completion without resubmitting prompts', async () => {
  const taskId = randomUUID(), runId = randomUUID();
  const f = fixture({ workspace: (workspace, { botA }) => ({ ...workspace, tasks: [{ id: taskId, botId: botA, groupId: null, title: 'previous work', sessionId: 'session-a', status: 'running', summary: '' }], runs: [{ id: runId, botId: botA, taskId, groupId: null, title: 'previous work', sessionId: 'session-a', status: 'running', summary: '', afterSeq: 10, turn: 2, dispatchId: runId }] }) });
  try {
    f.finish('session-a', 'recovered completion');
    await ready(f); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.runs.find(run => run.id === runId).status, 'completed');
    assert.equal(f.workspace.tasks.find(task => task.id === taskId).status, 'completed');
  } finally { f.controller.dispose(); }
});

test('group recovery persists one member result but never automatically replays remaining members', async () => {
  const taskId = randomUUID(), runId = randomUUID();
  const f = fixture({ workspace: (workspace, { botA, groupId }) => ({ ...workspace, tasks: [{ id: taskId, botId: null, groupId, title: 'group work', sessionId: 'session-a', status: 'running', summary: '' }], runs: [{ id: runId, botId: botA, taskId, groupId, title: 'member work', sessionId: 'session-a', status: 'running', summary: '', afterSeq: 10, turn: 2, dispatchId: runId }] }) });
  try {
    f.finish('session-a', 'recovered member result');
    await ready(f, 'group', f.groupId); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.runs[0].status, 'completed');
    assert.equal(f.workspace.tasks[0].status, 'waiting');
    assert.equal(f.workspace.groups[0].messages[0].text, 'recovered member result');
    assert.equal(f.workspace.groups[0].messages[0].botId, f.botA);
    await f.controller.refresh(); await nextTurn();
    assert.equal(f.workspace.groups[0].messages.length, 1, 'Recovery must not append the same member result again');
  } finally { f.controller.dispose(); }
});

test('legacy run without saved boundary waits for human review and never guesses completion or resubmits', async () => {
  const taskId = randomUUID(), runId = randomUUID();
  const f = fixture({ workspace: (workspace, { botA }) => ({ ...workspace, tasks: [{ id: taskId, botId: botA, groupId: null, title: 'legacy work', status: 'running' }], runs: [{ id: runId, botId: botA, taskId, groupId: null, title: 'legacy work', sessionId: 'session-a', status: 'running', summary: '' }] }) });
  try {
    await ready(f); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.runs[0].status, 'waiting');
    assert.notEqual(f.workspace.tasks[0].status, 'completed');
  } finally { f.controller.dispose(); }
});

test('stop while acquiring a native session prevents any later prompt submission', async () => {
  const acquisition = deferred(), f = fixture({ beforeAcquire: () => acquisition.promise });
  try {
    await ready(f); await f.controller.send('work'); await nextTurn();
    await f.controller.stop(f.botA); acquisition.resolve(); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.tasks[0].status, 'cancelled');
  } finally { acquisition.resolve(); f.controller.dispose(); }
});

test('stopping a queued later group member stops the active workflow and prevents subsequent members', async () => {
  const f = fixture();
  try {
    await ready(f, 'group', f.groupId); await f.controller.send('@everyone work'); await nextTurn();
    await f.controller.stop(f.botB); await nextTurn();
    assert.deepEqual(f.sends.map(send => send.sessionId), ['session-a']);
    assert.equal(f.workspace.tasks[0].status, 'cancelled');
  } finally { f.controller.dispose(); }
});

test('group native-open action resolves a real member session instead of pretending group itself is native', async () => {
  const f = fixture();
  try {
    await ready(f, 'group', f.groupId);
    await f.controller.send('group work'); await nextTurn(); f.controller.openNative();
    assert.ok(['session-a', 'session-b'].includes(f.opened[0]));
    assert.notEqual(f.opened[0], f.groupId);
    f.finish('session-a'); await nextTurn();
  } finally { f.controller.dispose(); }
});

test('a pending native approval blocks new work even if running flag is false', async () => {
  const f = fixture();
  try {
    f.publish('session-a', { running: false, needsAttention: true, approval: { kind: 'approval', toolName: 'bash' } }); await ready(f);
    await f.controller.send('do not jump past approval'); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.match(f.controller.getSnapshot().error, /等待处理|原生会话/);
  } finally { f.controller.dispose(); }
});

test('rejected cancellation cannot relabel later native completion as cancelled', async () => {
  const f = fixture({ onCancel: () => { throw new Error('native cancellation denied'); } });
  try {
    await ready(f); await f.controller.send('finish honestly'); await nextTurn();
    await assert.rejects(f.controller.stop(f.botA), /cancellation denied/);
    assert.equal(f.workspace.tasks[0].status, 'running');
    f.finish('session-a', 'actual successful result'); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed');
    assert.equal(f.workspace.tasks[0].status, 'completed');
    assert.equal(f.workspace.runs[0].summary, 'actual successful result');
  } finally { f.controller.dispose(); }
});

test('an accepted stop request racing native success still preserves the actual completed boundary', async () => {
  const f = fixture({ finishOnCancel: false, onCancel: ({ sessionId, finish }) => finish(sessionId, 'completed before cancellation took effect') });
  try {
    await ready(f); await f.controller.send('work'); await nextTurn();
    await f.controller.stop(f.botA); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed');
    assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { f.controller.dispose(); }
});

test('a failed group cancellation stops later members without mislabelling the completed active member', async () => {
  const f = fixture({ onCancel: () => { throw new Error('cancel unavailable'); } });
  try {
    await ready(f, 'group', f.groupId); await f.controller.send('@everyone work'); await nextTurn();
    await assert.rejects(f.controller.stop(f.botB), /unavailable/);
    f.finish('session-a', 'current member genuinely completed'); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed');
    assert.equal(f.workspace.tasks[0].status, 'cancelled');
    assert.deepEqual(f.sends.map(send => send.sessionId), ['session-a']);
    assert.equal(f.workspace.groups[0].messages.at(-1).text, 'current member genuinely completed');
  } finally { f.controller.dispose(); }
});

test('a rejected post-admission cancellation retry keeps observing native work until its real end', async () => {
  const admission = deferred(), f = fixture({ onSend: () => admission.promise, onCancel: () => { throw new Error('cancel denied'); } });
  try {
    await ready(f); await f.controller.send('pending receipt'); await nextTurn();
    await assert.rejects(f.controller.stop(f.botA), /denied/);
    admission.resolve(); await nextTurn();
    assert.equal(f.cancelled.length, 2);
    assert.equal(f.workspace.runs[0].status, 'running');
    assert.equal(f.controller.getSnapshot().jobs[f.botA].status, 'running');
    f.finish('session-a', 'continued native work'); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed'); assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { admission.resolve(); f.controller.dispose(); }
});

test('stopping during durable preparation does not cancel an unrelated native turn or dispatch our prompt', async () => {
  const preparing = deferred();
  const f = fixture({ rpc: async (endpoint, payload) => { if (endpoint === 'botWorkspace/update' && payload.request.action === 'updateTask' && payload.request.patch.status === 'queued') await preparing.promise; } });
  try {
    await ready(f); await f.controller.send('not dispatched'); await nextTurn();
    await f.controller.stop(f.botA); preparing.resolve(); await nextTurn();
    assert.equal(f.cancelled.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.runs[0].status, 'cancelled'); assert.equal(f.workspace.tasks[0].status, 'cancelled');
  } finally { preparing.resolve(); f.controller.dispose(); }
});

for (const changedState of ['completed', 'running']) test(`native ${changedState} activity during preparation cannot finish or overlap a prompt not yet dispatched`, async () => {
  let changed = false, f;
  f = fixture({ rpc: (endpoint, payload) => {
    if (!changed && endpoint === 'botWorkspace/update' && payload.request.action === 'updateTask' && payload.request.patch.status === 'queued') {
      changed = true;
      if (changedState === 'completed') f.finish('session-a', 'unrelated earlier work');
      else f.publish('session-a', { running: true, lastSeq: 11 });
    }
  } });
  try {
    await ready(f); const receipt = await f.controller.send('our message');
    await assert.rejects(receipt.admitted, /尚未发送/); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.equal(f.workspace.runs[0].status, 'failed'); assert.equal(f.workspace.tasks[0].status, 'failed');
    assert.match(f.workspace.runs[0].summary, /尚未发送/);
    assert.doesNotMatch(f.workspace.runs[0].summary, /unrelated earlier work/);
  } finally { f.controller.dispose(); }
});

test('metadata read failure does not turn continued native tool or approval updates offline', async () => {
  let failRead = false;
  const f = fixture({ rpc: endpoint => failRead && endpoint === 'botWorkspace/read' ? { ok: false, error: { message: 'metadata store temporarily unavailable' } } : undefined });
  try {
    await ready(f);
    f.publish('session-a', { running: true, latestTurn: 2, lastSeq: 15, activities: [{ toolName: 'web_search', status: 'running', turn: 2, seq: 15 }] });
    assert.equal(f.controller.getSnapshot().botPresence[f.botA].state, 'researching');
    failRead = true; await assert.rejects(f.controller.refresh(), /metadata store/);
    assert.equal(f.controller.getSnapshot().connection, 'error');
    assert.match(f.controller.getSnapshot().error, /metadata store/);
    f.publish('session-a', { lastSeq: 16 });
    assert.equal(f.controller.getSnapshot().botPresence[f.botA].state, 'researching');
    f.publish('session-a', { needsAttention: true, approval: { kind: 'approval' } });
    assert.equal(f.controller.getSnapshot().botPresence[f.botA].state, 'waiting');
    failRead = false; await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().connection, 'ready');
  } finally { f.controller.dispose(); }
});

for (const stage of ['appendGroupMessage', 'updateTask', 'upsertRun']) test(`recovered settlement retries a transient ${stage} failure without replay or duplicate replies`, async () => {
  const taskId = randomUUID(), runId = randomUUID(); let failures = 0;
  const f = fixture({ workspace: (workspace, { botA, groupId }) => ({ ...workspace,
    tasks: [{ id: taskId, groupId, status: 'running', title: 'recover group' }],
    runs: [{ id: runId, taskId, botId: botA, groupId, sessionId: 'session-a', status: 'running', afterSeq: 10, turn: 2, dispatchId: runId }]
  }), rpc: (endpoint, payload) => {
    const request = payload?.request;
    if (!failures && endpoint === 'botWorkspace/update' && request.action === stage && (stage !== 'upsertRun' || request.run.status === 'completed')) {
      failures++; return { ok: false, error: { message: `transient ${stage} failure` } };
    }
  } });
  try {
    f.finish('session-a', 'durable recovered answer');
    await ready(f, 'group', f.groupId); await nextTurn();
    assert.equal(failures, 1); assert.notEqual(f.workspace.runs[0].settled, true);
    await f.controller.refresh(); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed'); assert.equal(f.workspace.tasks[0].status, 'waiting');
    assert.equal(f.workspace.groups[0].messages.length, 1);
    assert.equal(f.workspace.groups[0].messages[0].runId, runId);
    assert.equal(f.workspace.groups[0].messages[0].text, 'durable recovered answer');
    await f.controller.refresh(); await nextTurn();
    assert.equal(f.workspace.groups[0].messages.length, 1); assert.equal(f.sends.length, 0);
  } finally { f.controller.dispose(); }
});

test('private recovery retries durable native proof before completing task bookkeeping', async () => {
  const taskId = randomUUID(), runId = randomUUID(); let failures = 0;
  const f = fixture({ workspace: (workspace, { botA }) => ({ ...workspace,
    tasks: [{ id: taskId, botId: botA, status: 'running', title: 'recover private' }],
    runs: [{ id: runId, taskId, botId: botA, sessionId: 'session-a', status: 'running', afterSeq: 10, turn: 2, dispatchId: runId }]
  }), rpc: (endpoint, payload) => {
    if (!failures && endpoint === 'botWorkspace/update' && payload.request.action === 'upsertRun' && payload.request.run.status === 'completed') {
      failures++; return { ok: false, error: { message: 'terminal commit failed once' } };
    }
  } });
  try {
    f.finish('session-a', 'real result'); await ready(f); await nextTurn();
    assert.equal(failures, 1); assert.notEqual(f.workspace.tasks[0].status, 'completed');
    assert.notEqual(f.workspace.runs[0].status, 'completed');
    await f.controller.refresh(); await nextTurn();
    assert.equal(f.workspace.runs[0].status, 'completed'); assert.equal(f.workspace.tasks[0].status, 'completed');
    assert.equal(f.sends.length, 0);
  } finally { f.controller.dispose(); }
});

test('send returns task metadata immediately but admitted waits for native acceptance, not completion', async () => {
  const acceptance = deferred(), f = fixture({ onSend: () => acceptance.promise });
  try {
    await ready(f);
    const receipt = await f.controller.send('retain until accepted');
    assert.ok(receipt.taskId); assert.equal(receipt.id, receipt.taskId); assert.equal(receipt.title, 'retain until accepted');
    let accepted = false; receipt.admitted.then(() => { accepted = true; });
    await nextTurn(); assert.equal(f.sends.length, 1); assert.equal(accepted, false);
    acceptance.resolve();
    assert.deepEqual(await receipt.admitted, { taskId: receipt.taskId, sessionId: 'session-a', accepted: true });
    assert.equal(f.workspace.tasks[0].status, 'running');
    assert.equal(f.snapshot('session-a').running, true);
    assert.ok(f.calls.every(row => !JSON.stringify(row.payload).includes('admitted')));
    f.finish('session-a'); await nextTurn();
    assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { acceptance.resolve(); f.controller.dispose(); }
});

test('native prompt admission failure rejects admitted even though task metadata already exists', async () => {
  const f = fixture({ onSend: () => { throw new Error('native refused this prompt'); } });
  try {
    await ready(f); const receipt = await f.controller.send('keep this full draft');
    await assert.rejects(receipt.admitted, /native refused/); await nextTurn();
    assert.equal(f.workspace.tasks[0].status, 'failed');
  } finally { f.controller.dispose(); }
});

test('pre-admission disposal rejects admitted while acquisition is still pending and sends nothing', async () => {
  const acquisition = deferred(), f = fixture({ beforeAcquire: () => acquisition.promise });
  try {
    await ready(f); const receipt = await f.controller.send('not accepted'); await nextTurn();
    const rejected = assert.rejects(receipt.admitted, error => error.code === 'tracking-detached');
    f.controller.dispose(); await rejected;
    assert.equal(f.cancelled.length, 0);
    acquisition.resolve(); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.notEqual(f.workspace.tasks[0].status, 'failed');
  } finally { acquisition.resolve(); f.controller.dispose(); }
});

test('disposal with a pending native receipt rejects admitted without cancelling possible host work', async () => {
  const acceptance = deferred(), f = fixture({ onSend: () => acceptance.promise });
  try {
    await ready(f); const receipt = await f.controller.send('receipt pending'); await nextTurn();
    assert.equal(f.sends.length, 1);
    const rejected = assert.rejects(receipt.admitted, error => error.code === 'tracking-detached');
    f.controller.dispose(); await rejected;
    acceptance.resolve(); await nextTurn();
    assert.equal(f.cancelled.length, 0);
    assert.notEqual(f.workspace.runs[0].status, 'failed');
    assert.notEqual(f.workspace.tasks[0].status, 'failed');
  } finally { acceptance.resolve(); f.controller.dispose(); }
});

test('disposal before task creation returns still rejects the eventual client-only admission signal', async () => {
  const creation = deferred(), f = fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'botWorkspace/update' && payload.request.action === 'createTask') await creation.promise;
  } });
  try {
    await ready(f); const pending = f.controller.send('metadata pending'); await nextTurn();
    f.controller.dispose(); creation.resolve();
    const receipt = await pending;
    await assert.rejects(receipt.admitted, error => error.code === 'tracking-detached');
    await nextTurn(); assert.equal(f.sends.length, 0); assert.equal(f.cancelled.length, 0);
  } finally { creation.resolve(); f.controller.dispose(); }
});

test('a stop before native acceptance rejects admitted promptly and prevents later dispatch', async () => {
  const acquisition = deferred(), f = fixture({ beforeAcquire: () => acquisition.promise });
  try {
    await ready(f); const receipt = await f.controller.send('cancel before accepted'); await nextTurn();
    const rejected = assert.rejects(receipt.admitted, /已停止/);
    await f.controller.stop(f.botA); await rejected;
    acquisition.resolve(); await nextTurn();
    assert.equal(f.sends.length, 0); assert.equal(f.workspace.tasks[0].status, 'cancelled');
  } finally { acquisition.resolve(); f.controller.dispose(); }
});

test('a group admission signal settles once on its first actual accepted member, not later failures', async () => {
  const f = fixture();
  try {
    await ready(f, 'group', f.groupId); const receipt = await f.controller.send('@everyone start');
    assert.equal((await receipt.admitted).sessionId, 'session-a'); await nextTurn();
    assert.equal(f.workspace.tasks[0].status, 'running');
    f.finish('session-a', 'first member done'); await nextTurn();
    f.finish('session-b', 'second member error', 'error'); await nextTurn();
    assert.equal(f.workspace.tasks[0].status, 'failed');
    assert.equal((await receipt.admitted).sessionId, 'session-a');
  } finally { f.controller.dispose(); }
});

test('legacy callers can ignore a rejected admitted signal without an unhandled rejection', async () => {
  const f = fixture({ onSend: () => { throw new Error('ignored admission rejection'); } });
  try {
    await ready(f); const receipt = await f.controller.send('legacy taskId-only caller');
    assert.ok(receipt.taskId); await nextTurn();
    assert.equal(f.workspace.tasks[0].status, 'failed');
  } finally { f.controller.dispose(); }
});

test('native session already running is not submitted another overlapping job', async () => {
  const f = fixture();
  try {
    f.publish('session-a', { running: true }); await ready(f);
    await f.controller.send('should not overlap'); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.match(f.controller.getSnapshot().error, /原生会话仍在工作|正在工作/);
  } finally { f.controller.dispose(); }
});


const drain = async () => { for (let i = 0; i < 18; i++) await nextTurn(); };
test('late mutation receipt returns its own task identity despite a newer concurrent refresh', async () => {
  const f = fixture(), committed = deferred(), gate = deferred(); const original = f.ctx.connection.rpc.call; let first = true;
  f.ctx.connection.rpc.call = async (...args) => { const result = await original(...args); if (first && args[2]?.request?.action === 'createTask') { first = false; committed.resolve(); await gate.promise; } return result; };
  try {
    await ready(f); const sending = f.controller.send('our request'); await committed.promise;
    const ours = f.workspace.tasks.at(-1).id, foreign = randomUUID(); f.workspace.tasks.push({ id: foreign, title: 'foreign request', botId: f.botB, status: 'queued' }); f.workspace.revision++;
    await f.controller.refresh(); gate.resolve(); const receipt = await sending; await receipt.admitted;
    assert.equal(receipt.taskId, ours); assert.notEqual(receipt.taskId, foreign);
    f.finish('session-a', 'our result'); await drain(); assert.equal(f.workspace.tasks.find(t => t.id === foreign).status, 'queued');
    assert.equal(f.workspace.runs[0].taskId, ours);
  } finally { gate.resolve(); f.controller.dispose(); }
});
test('two controllers queued at one idle baseline settle only on their own public user turn', async () => {
  const f = fixture(), acquire = f.runtime.acquire;
  f.runtime.acquire = async (...args) => { const handle = await acquire(...args); return { ...handle, async send(text) { f.sends.push({ sessionId: handle.sessionId, text }); return { sessionId: handle.sessionId, accepted: true }; } }; };
  const other = createTeamController(f.ctx, { runtime: f.runtime });
  try {
    await ready(f); await other.refresh(); await other.select('bot', f.botA);
    const [first, second] = await Promise.all([f.controller.send('first queued work'), other.send('second queued work')]); await Promise.all([first.admitted, second.admitted]);
    const showUser = (index, turn, seq) => { const sent = f.sends[index]; f.publish('session-a', { running: true, latestTurn: turn, lastSeq: seq, messages: [...f.snapshot('session-a').messages, { id: `user-${seq}`, role: 'user', text: sent.text, dispatchId: dispatchIdFromPrompt(sent.text), turn, seq }] }); };
    showUser(0, 2, 11); f.finish('session-a', 'FIRST RESULT'); await drain();
    assert.equal(f.workspace.tasks.find(task => task.id === first.taskId).status, 'completed');
    assert.notEqual(f.workspace.tasks.find(task => task.id === second.taskId).status, 'completed');
    showUser(1, 3, 20); f.finish('session-a', 'SECOND RESULT'); await drain();
    assert.equal(f.workspace.tasks.find(task => task.id === second.taskId).status, 'completed');
    const answers = f.workspace.runs.filter(run => run.taskId === first.taskId || run.taskId === second.taskId).map(run => run.summary);
    assert.deepEqual(answers.sort(), ['FIRST RESULT', 'SECOND RESULT']);
  } finally { other.dispose(); f.controller.dispose(); }
});
for (const stage of ['upsertRun', 'appendGroupMessage', 'updateTask']) test(`live settlement retries ${stage} failure without falsifying native success or replaying`, async () => {
  let failures = 0, armed = false;
  const f = fixture({ rpc: (endpoint, payload) => { const request = payload?.request; if (armed && !failures && endpoint === 'botWorkspace/update' && request.action === stage && (stage !== 'upsertRun' || request.run.status === 'completed') && (stage !== 'appendGroupMessage' || request.message.role === 'assistant') && (stage !== 'updateTask' || request.patch.status === 'completed')) { failures++; return { ok: false, error: { message: `temporary ${stage} outage` } }; } } });
  try {
    await ready(f, 'group', f.groupId); const receipt = await f.controller.send('@Milo perform real work'); await receipt.admitted; armed = true;
    f.finish('session-a', 'REAL COMPLETED OUTPUT'); await drain();
    assert.equal(failures, 1); assert.notEqual(f.workspace.runs[0].status, 'failed'); assert.notEqual(f.workspace.tasks[0].status, 'failed');
    await f.controller.refresh(); await drain();
    assert.equal(f.workspace.runs[0].status, 'completed'); assert.equal(f.workspace.runs[0].settled, true); assert.equal(f.workspace.tasks[0].status, 'completed');
    assert.equal(f.workspace.groups[0].messages.filter(message => message.role === 'assistant').length, 1); assert.equal(f.workspace.groups[0].messages.find(message => message.role === 'assistant').text, 'REAL COMPLETED OUTPUT'); assert.equal(f.sends.length, 1);
  } finally { f.controller.dispose(); }
});
test('durable terminal outbox repairs delivery after its native turn ages out of the event window', async () => {
  const id = randomUUID(), taskId = randomUUID();
  const f = fixture({ workspace: (workspace, { botA, groupId }) => ({ ...workspace, tasks: [{ id: taskId, groupId, status: 'running', title: 'old job' }], runs: [{ id, taskId, botId: botA, groupId, sessionId: 'session-a', afterSeq: 10, turn: 2, dispatchId: id, status: 'completed', summary: 'DURABLE REAL REPLY', reply: 'DURABLE REAL REPLY', settled: false }] }) });
  try { f.publish('session-a', { lastSeq: 900, latestTurn: 99, lastTurnEnd: { turn: 99, seq: 900, reason: 'completed' }, messages: [] }); await ready(f); await drain(); assert.equal(f.sends.length, 0); assert.equal(f.workspace.runs[0].settled, true); assert.equal(f.workspace.groups[0].messages[0].text, 'DURABLE REAL REPLY'); assert.equal(f.workspace.tasks[0].status, 'waiting'); }
  finally { f.controller.dispose(); }
});
test('a legacy baseline alone never proves ownership of a newer native terminal', async () => {
  const taskId = randomUUID(), id = randomUUID(); const f = fixture({ workspace: (workspace, { botA }) => ({ ...workspace, tasks: [{ id: taskId, botId: botA, status: 'running' }], runs: [{ id, taskId, botId: botA, sessionId: 'session-a', afterSeq: 10, status: 'running' }] }) });
  try { f.finish('session-a', 'SOMEBODY ELSE'); await ready(f); await drain(); assert.equal(f.workspace.runs[0].status, 'waiting'); assert.notEqual(f.workspace.tasks[0].status, 'completed'); assert.equal(f.sends.length, 0); }
  finally { f.controller.dispose(); }
});
for (const kind of ['bot', 'group']) test(`archived ${kind} rejects submission before creating task or dispatch reservations`, async () => {
  const f = fixture(); try { await ready(f, kind, kind === 'bot' ? f.botA : f.groupId); const record = kind === 'bot' ? f.workspace.bots[0] : f.workspace.groups[0]; record.archived = true; f.workspace.revision++; await f.controller.refresh(); const before = f.calls.length; await assert.rejects(f.controller.send('must not send'), /归档/); assert.equal(f.sends.length, 0); assert.equal(f.workspace.tasks.length, 0); assert.equal(f.calls.slice(before).some(call => call.payload?.request?.action === 'createTask'), false); }
  finally { f.controller.dispose(); }
});
test('batched later native terminal cannot replace the matching owned turn or contaminate its reply', async () => {
  const f = fixture(); try { await ready(f); const receipt = await f.controller.send('owned work'); await receipt.admitted;
    f.publish('session-a', { running: false, latestTurn: 3, lastSeq: 40, lastTurnEnd: { turn: 3, seq: 40, reason: 'completed' }, turnEnds: [{ turn: 2, seq: 20, reason: 'completed' }, { turn: 3, seq: 40, reason: 'completed' }], messages: [{ id: 'own', role: 'assistant', turn: 2, seq: 19, text: 'OWN ONLY' }, { id: 'foreign', role: 'assistant', turn: 3, seq: 39, text: 'NOT OUR OUTPUT' }] }); await drain();
    assert.equal(f.workspace.runs[0].summary, 'OWN ONLY'); assert.equal(f.workspace.runs[0].turn, 2); assert.equal(f.workspace.tasks[0].status, 'completed');
  } finally { f.controller.dispose(); }
});
test('removed native session releases tracking as unverified without cancelling unrelated work', async () => {
  const f = fixture(); try { await ready(f); const receipt = await f.controller.send('accepted work'); await receipt.admitted; f.publish('session-a', { removed: true, running: false }); await drain(); assert.equal(Object.keys(f.controller.getSnapshot().jobs).length, 0); assert.equal(f.workspace.tasks[0].status, 'waiting'); assert.equal(f.cancelled.length, 0); assert.notEqual(f.workspace.runs[0].status, 'completed'); }
  finally { f.controller.dispose(); }
});

test('known full group capacity is rejected before creating a task or dispatching native work', async () => {
  const f = fixture(); try { await ready(f, 'group', f.groupId); f.workspace.groups[0].messages = Array.from({ length: 399 }, (_, i) => ({ id: `${i}`, role: 'user', text: 'old' })); f.workspace.revision++; await f.controller.refresh(); await assert.rejects(f.controller.send('@Milo new work'), /清空/); assert.equal(f.workspace.tasks.length, 0); assert.equal(f.sends.length, 0); }
  finally { f.controller.dispose(); }
});
test('explicit cleanup after another owner settles does not resurrect removed task or run metadata', async () => {
  let failed = false; const f = fixture({ rpc: (endpoint, payload) => { const request = payload?.request; if (!failed && endpoint === 'botWorkspace/update' && request.action === 'updateTask' && request.patch.status === 'completed') { failed = true; return { ok: false, error: { message: 'last write temporarily unavailable' } }; } } });
  try { await ready(f); const receipt = await f.controller.send('one real operation'); await receipt.admitted; f.finish('session-a', 'real completed result'); await drain(); assert.equal(failed, true);
    f.workspace.tasks = []; f.workspace.runs = []; f.workspace.revision++; await f.controller.refresh(); await drain(); assert.equal(f.workspace.tasks.length, 0); assert.equal(f.workspace.runs.length, 0); assert.equal(Object.keys(f.controller.getSnapshot().jobs).length, 0); assert.equal(f.sends.length, 1);
  } finally { f.controller.dispose(); }
});

test('stopping own queued group dispatch removes it without stopping foreign active turn or later members', async () => {
  const f = fixture(), acquire = f.runtime.acquire; let removed = 0;
  f.runtime.acquire = async (...args) => { const handle = await acquire(...args); return { ...handle, async send(text) { f.sends.push({ sessionId: handle.sessionId, text }); return { accepted: true }; }, async cancelDispatch(id) { assert.equal(id, dispatchIdFromPrompt(f.sends[0].text)); removed++; return { accepted: true, scope: 'queue' }; } }; };
  try { await ready(f, 'group', f.groupId); const receipt = await f.controller.send('@everyone pending work'); await receipt.admitted; f.publish('session-a', { running: true, latestTurn: 99, lastSeq: 11 }); await f.controller.stop(f.botB); await drain(); assert.equal(removed, 1); assert.equal(f.cancelled.length, 0); assert.equal(f.sends.length, 1); assert.equal(f.workspace.tasks[0].status, 'cancelled'); assert.equal(f.workspace.runs[0].status, 'cancelled'); assert.equal(f.workspace.runs[0].turn, null); assert.equal(f.snapshot('session-a').running, true); }
  finally { f.controller.dispose(); }
});
test('stop intent during unresolved admission reapplies exact queue removal after native acceptance', async () => {
  const f = fixture(), acquire = f.runtime.acquire, admission = deferred(); let visible = false, removed = 0;
  f.runtime.acquire = async (...args) => { const handle = await acquire(...args); return { ...handle, async send(text) { f.sends.push({ sessionId: handle.sessionId, text }); await admission.promise; visible = true; return { accepted: true }; }, async cancelDispatch() { if (!visible) { const error = new Error('queue not observed yet'); error.code = 'dispatch-unverified'; throw error; } removed++; return { accepted: true, scope: 'queue' }; } }; };
  try { await ready(f); const receipt = await f.controller.send('queued while admitting'); await drain(); await f.controller.stop(f.botA); await assert.rejects(receipt.admitted, /停止/); assert.equal(removed, 0); assert.equal(f.cancelled.length, 0); admission.resolve(); await drain(); assert.equal(removed, 1); assert.equal(f.workspace.tasks[0].status, 'cancelled'); assert.equal(f.workspace.runs[0].settled, true); assert.equal(f.cancelled.length, 0); }
  finally { admission.resolve(); f.controller.dispose(); }
});
