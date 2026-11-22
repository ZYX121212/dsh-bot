import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTeamController } from '../src/team-controller.mjs';
import { emptyTeamWorkspace } from '../src/team-core.mjs';

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
    const previous = snapshot(sessionId), seq = previous.lastSeq + 2;
    publish(sessionId, { running: false, needsAttention: false, approval: null, lastSeq: seq, latestTurn: (previous.latestTurn ?? 1) + 1, lastTurnEnd: { turn: (previous.latestTurn ?? 1) + 1, reason, seq }, messages: [...previous.messages, { id: `assistant-${seq}`, role: 'assistant', text, seq: seq - 1, time: seq }] });
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
          publish(sessionId, { running: true, lastSeq: snapshot(sessionId).lastSeq + 1 });
          if (options.onSend) await options.onSend({ sessionId, text, finish, publish, snapshot });
          admitted.add(sessionId);
          return { sessionId, accepted: true };
        },
        async cancel() { cancelled.push(sessionId); if (admitted.has(sessionId) && options.finishOnCancel !== false) finish(sessionId, '', 'aborted'); return { accepted: true }; },
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
  const f = fixture({ workspace: (workspace, { botA }) => ({ ...workspace, tasks: [{ id: taskId, botId: botA, groupId: null, title: 'previous work', sessionId: 'session-a', status: 'running', summary: '' }], runs: [{ id: runId, botId: botA, taskId, groupId: null, title: 'previous work', sessionId: 'session-a', status: 'running', summary: '', afterSeq: 10 }] }) });
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
  const f = fixture({ workspace: (workspace, { botA, groupId }) => ({ ...workspace, tasks: [{ id: taskId, botId: null, groupId, title: 'group work', sessionId: 'session-a', status: 'running', summary: '' }], runs: [{ id: runId, botId: botA, taskId, groupId, title: 'member work', sessionId: 'session-a', status: 'running', summary: '', afterSeq: 10 }] }) });
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

test('native session already running is not submitted another overlapping job', async () => {
  const f = fixture();
  try {
    f.publish('session-a', { running: true }); await ready(f);
    await f.controller.send('should not overlap'); await nextTurn();
    assert.equal(f.sends.length, 0);
    assert.match(f.controller.getSnapshot().error, /原生会话仍在工作|正在工作/);
  } finally { f.controller.dispose(); }
});
