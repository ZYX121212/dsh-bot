import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore, WorkspaceError, WORKSPACE_LIMITS, createEmptyWorkspace, validateWorkspaceRequest, validateWorkspaceSnapshot } from '../src/host-store.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-bot-store-test-'));
  t.after(async () => { assert.equal(dirname(base), tmpdir()); assert.ok(base.startsWith(join(tmpdir(), 'dsh-bot-store-test-'))); await rm(base, { recursive: true, force: true }); });
  const file = join(base, 'nested', 'workspace.json');
  const store = new WorkspaceStore(file);
  return { store, file, base };
}
const makeBot = (store, name = 'Researcher') => store.update({ action: 'createBot', name, role: 'Research sources; report evidence.', avatar: { color: '#AaBbCc', shape: 'hexagon' } });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof WorkspaceError && error.code === code);

test('empty read is detached, uses schema v1, and performs no write', async t => {
  const { store, file } = await fixture(t);
  const first = await store.read();
  assert.deepEqual(first, createEmptyWorkspace());
  first.settings.theme = 'dark'; first.bots.push({ id: 'fake' });
  assert.deepEqual(await store.read(), createEmptyWorkspace());
  await assert.rejects(access(file), { code: 'ENOENT' });
});

test('Bot CRUD, identity normalization, primary, archive and deletion are durable', async t => {
  const { store, file } = await fixture(t);
  let snapshot = await makeBot(store);
  const id = snapshot.bots[0].id;
  assert.match(id, /^[a-f\d-]{36}$/);
  assert.deepEqual(snapshot.bots[0].avatar, { color: '#aabbcc', shape: 'hexagon' });
  assert.equal(snapshot.bots[0].sessionId, null);
  assert.equal(snapshot.primaryBotId, null, 'Creating a Bot never silently assigns primary');
  snapshot = await store.update({ action: 'setPrimary', id });
  assert.equal(snapshot.primaryBotId, id);
  snapshot = await store.update({ action: 'updateBot', id, patch: { name: '  Finance  ', role: '' } });
  assert.equal(snapshot.bots[0].name, 'Finance');
  snapshot = await store.update({ action: 'archiveBot', id, archived: true });
  assert.equal(snapshot.bots[0].archived, true);
  assert.equal(snapshot.primaryBotId, null);
  await rejectsCode(store.update({ action: 'setPrimary', id }), 'invalid-input');
  await store.update({ action: 'archiveBot', id, archived: false });
  await store.update({ action: 'setPrimary', id });
  assert.deepEqual(await new WorkspaceStore(file).read(), await store.read());
  snapshot = await store.update({ action: 'deleteBot', id });
  assert.equal(snapshot.bots.length, 0); assert.equal(snapshot.primaryBotId, null);
  assert.equal(snapshot.revision, 7);
});

test('Bot native session binding is persistent and compare-and-set protected', async t => {
  const { store, file } = await fixture(t);
  const botId = (await makeBot(store)).bots[0].id;
  await store.update({ action: 'setSession', botId, sessionId: 'native-session-1' });
  assert.equal((await new WorkspaceStore(file).read()).bots[0].sessionId, 'native-session-1');
  await rejectsCode(store.update({ action: 'setSession', botId, sessionId: 'native-session-2' }), 'session-conflict');
  await rejectsCode(store.update({ action: 'setSession', botId, sessionId: null }), 'session-conflict');
  await rejectsCode(store.update({ action: 'setSession', botId, sessionId: 'new', expectedSessionId: null }), 'session-conflict');
  const updated = await store.update({ action: 'setSession', botId, sessionId: 'native-session-2', expectedSessionId: 'native-session-1' });
  assert.equal(updated.bots[0].sessionId, 'native-session-2');
  await store.update({ action: 'setSession', botId, sessionId: null, expectedSessionId: 'native-session-2' });
  assert.equal((await store.read()).bots[0].sessionId, null);
});

test('serialized concurrent creates preserve every Bot and monotonically increment revisions', async t => {
  const { store } = await fixture(t);
  const snapshots = await Promise.all(Array.from({ length: 40 }, (_, i) => makeBot(store, `Bot ${i}`)));
  assert.deepEqual(snapshots.map(s => s.revision), Array.from({ length: 40 }, (_, i) => i + 1));
  const final = await store.read(); assert.equal(final.bots.length, 40); assert.equal(new Set(final.bots.map(b => b.id)).size, 40);
  snapshots[0].bots[0].name = 'mutated response'; assert.equal((await store.read()).bots[0].name, 'Bot 0');
});

test('optimistic revisions reject stale edits without poisoning subsequent queue operations', async t => {
  const { store } = await fixture(t);
  await makeBot(store);
  await rejectsCode(store.update({ action: 'createBot', name: 'stale', expectedRevision: 0 }), 'revision-conflict');
  await store.update({ action: 'createBot', name: 'fresh', expectedRevision: 1 });
  assert.equal((await store.read()).revision, 2);
});

test('queued mutation requests are detached before the caller can change them', async t => {
  const { store } = await fixture(t);
  const request = { action: 'createBot', name: 'Original', avatar: { color: '#123456', shape: 'square' } };
  const pending = store.update(request);
  request.name = 'Changed'; request.avatar.color = '#654321';
  const snapshot = await pending;
  assert.equal(snapshot.bots[0].name, 'Original'); assert.equal(snapshot.bots[0].avatar.color, '#123456');
});

test('groups persist actual member identities and deduplicated user/Bot/system transcripts', async t => {
  const { store, file } = await fixture(t);
  await makeBot(store, 'Writer');
  const state = await makeBot(store, 'Reviewer');
  const memberIds = state.bots.map(b => b.id);
  const groupId = (await store.update({ action: 'createGroup', name: 'Launch', memberIds })).groups[0].id;
  const clientMessage = { id: randomUUID(), role: 'user', text: 'Draft and review the release.' };
  await store.update({ action: 'appendGroupMessage', groupId, message: clientMessage });
  const beforeRetry = (await store.read()).revision;
  await store.update({ action: 'appendGroupMessage', groupId, message: clientMessage });
  assert.equal((await store.read()).revision, beforeRetry, 'A dedupe retry is a genuine no-op');
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { ...clientMessage, text: 'Changed content' } }), 'message-conflict');
  const runId = randomUUID();
  await store.update({ action: 'appendGroupMessage', groupId, message: { role: 'assistant', botId: memberIds[0], text: 'Draft complete.', sessionId: 'native-1', runId } });
  await store.update({ action: 'appendGroupMessage', groupId, message: { role: 'system', text: 'Review requested.' } });
  const group = (await new WorkspaceStore(file).read()).groups[0];
  assert.equal(group.messages.length, 3); assert.equal(group.messages[0].id, clientMessage.id);
  assert.deepEqual(group.messages[1], { id: group.messages[1].id, role: 'assistant', botId: memberIds[0], text: 'Draft complete.', sessionId: 'native-1', runId, createdAt: group.messages[1].createdAt });
  await store.update({ action: 'updateGroup', id: groupId, patch: { name: 'Archived launch', archived: true } });
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'user', text: 'No' } }), 'invalid-input');
  await store.update({ action: 'deleteGroup', id: groupId }); assert.equal((await store.read()).groups.length, 0);
});

test('invalid group membership, duplicate members and wrong authors are rejected', async t => {
  const { store } = await fixture(t);
  const state = await makeBot(store); const botId = state.bots[0].id;
  await rejectsCode(store.update({ action: 'createGroup', name: 'No members', memberIds: [] }), 'invalid-input');
  await rejectsCode(store.update({ action: 'createGroup', name: 'Invalid', memberIds: [randomUUID()] }), 'not-found');
  await rejectsCode(store.update({ action: 'createGroup', name: 'Dup', memberIds: [botId, botId] }), 'invalid-input');
  const groupId = (await store.update({ action: 'createGroup', name: 'Real', memberIds: [botId] })).groups[0].id;
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'assistant', text: 'anonymous' } }), 'invalid-input');
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'assistant', botId: randomUUID(), text: 'outsider' } }), 'invalid-input');
});

test('memory scopes are explicit and deletion only removes the deleted Bot scoped memories', async t => {
  const { store } = await fixture(t);
  await makeBot(store); const state = await makeBot(store, 'Other'); const [a, b] = state.bots.map(row => row.id);
  await store.update({ action: 'addMemory', scope: 'shared', content: 'Use Chinese.' });
  await store.update({ action: 'addMemory', scope: 'bot', botId: a, content: 'Cite evidence.' });
  const updated = await store.update({ action: 'addMemory', scope: 'bot', botId: b, content: 'Track costs.' });
  const memoryId = updated.memories[0].id;
  await store.update({ action: 'updateMemory', id: memoryId, content: 'Use concise Chinese.' });
  await rejectsCode(store.update({ action: 'addMemory', scope: 'bot', content: 'Missing owner' }), 'invalid-input');
  await rejectsCode(store.update({ action: 'addMemory', scope: 'shared', botId: a, content: 'Wrong scope' }), 'invalid-input');
  await rejectsCode(store.update({ action: 'addMemory', scope: 'bot', botId: randomUUID(), content: 'Unknown' }), 'not-found');
  await store.update({ action: 'deleteBot', id: a });
  assert.equal((await store.read()).memories.length, 2);
  await store.update({ action: 'removeMemory', id: memoryId }); assert.equal((await store.read()).memories[0].botId, b);
});

test('deleting a Bot updates live membership but preserves historical group messages and runs', async t => {
  const { store } = await fixture(t); const botId = (await makeBot(store)).bots[0].id;
  const groupId = (await store.update({ action: 'createGroup', name: 'Team', memberIds: [botId] })).groups[0].id;
  await store.update({ action: 'appendGroupMessage', groupId, message: { role: 'assistant', botId, text: 'Historical result.' } });
  await store.update({ action: 'upsertRun', run: { botId, groupId, status: 'completed', summary: 'Delivered' } });
  const state = await store.update({ action: 'deleteBot', id: botId });
  assert.deepEqual(state.groups[0].memberIds, []); assert.equal(state.groups[0].messages[0].botId, botId); assert.equal(state.runs[0].botId, botId);
  assert.doesNotThrow(() => validateWorkspaceSnapshot(state));
});

test('tasks and runs are explicit durable audit records; upsert client identity does not duplicate', async t => {
  const { store, file } = await fixture(t); const botId = (await makeBot(store)).bots[0].id;
  let state = await store.update({ action: 'createTask', title: 'Draft the brief', botId, sessionId: 'session-1' });
  const taskId = state.tasks[0].id;
  assert.equal(state.tasks[0].status, 'queued');
  state = await store.update({ action: 'updateTask', id: taskId, patch: { status: 'running', summary: 'Started', title: 'Draft and check', sessionId: 'session-2' } });
  const runId = randomUUID();
  await store.update({ action: 'upsertRun', run: { id: runId, taskId, botId, sessionId: 'session-2', status: 'running', title: 'First attempt' } });
  state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'completed', summary: 'Brief created.' } });
  assert.equal(state.runs.length, 1); assert.equal(state.runs[0].taskId, taskId); assert.equal(state.runs[0].title, 'First attempt');
  assert.equal(state.runs[0].summary, 'Brief created.');
  assert.deepEqual(await new WorkspaceStore(file).read(), state);
  await rejectsCode(store.update({ action: 'deleteTask', id: taskId }), 'work-active');
  await store.update({ action: 'updateTask', id: taskId, patch: { status: 'completed' } });
  await store.update({ action: 'deleteTask', id: taskId });
  state = await store.read(); assert.equal(state.tasks.length, 0); assert.equal(state.runs.length, 1); assert.equal(state.runs[0].taskId, null);
  await store.update({ action: 'upsertRun', run: { id: runId, status: 'completed', summary: 'Still readable.' } });
  await rejectsCode(store.update({ action: 'createTask', title: 'Unknown Bot', botId: randomUUID() }), 'not-found');
  await rejectsCode(store.update({ action: 'upsertRun', run: { status: 'running', taskId: randomUUID() } }), 'not-found');
});

test('run afterSeq recovery baselines persist zero, safe integers, null and omitted update values', async t => {
  const { store, file } = await fixture(t);
  const runId = randomUUID();
  let state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'queued', afterSeq: 0 } });
  assert.equal(state.runs[0].afterSeq, 0);
  state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'running', afterSeq: 1234 } });
  assert.equal((await new WorkspaceStore(file).read()).runs[0].afterSeq, 1234);
  state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'waiting', summary: 'Still observing the same native turn.' } });
  assert.equal(state.runs[0].afterSeq, 1234, 'Omitting afterSeq does not destroy an existing baseline');
  state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'completed', afterSeq: Number.MAX_SAFE_INTEGER } });
  assert.equal(state.runs[0].afterSeq, Number.MAX_SAFE_INTEGER);
  state = await store.update({ action: 'upsertRun', run: { id: runId, status: 'completed', afterSeq: null } });
  assert.equal(state.runs[0].afterSeq, null);
  state = await store.update({ action: 'upsertRun', run: { status: 'queued' } });
  assert.equal(state.runs.at(-1).afterSeq, null, 'New records without a baseline default to null');
  assert.deepEqual(await new WorkspaceStore(file).read(), state);
});

test('legacy schema-v1 runs default missing afterSeq to null without rewriting on read', async t => {
  const { store, file } = await fixture(t);
  const current = await store.update({ action: 'upsertRun', run: { status: 'running', sessionId: 'native-legacy' } });
  const runId = current.runs[0].id;
  delete current.runs[0].afterSeq;
  const legacySource = JSON.stringify(current);
  await writeFile(file, legacySource);
  const loaded = await new WorkspaceStore(file).read();
  assert.equal(loaded.runs[0].afterSeq, null);
  assert.equal(loaded.runs[0].status, 'running');
  assert.equal(await readFile(file, 'utf8'), legacySource, 'Read-side migration leaves original JSON untouched');
  const updated = await store.update({ action: 'upsertRun', run: { id: runId, status: 'waiting', afterSeq: 42 } });
  assert.equal(updated.runs[0].afterSeq, 42);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).runs[0].afterSeq, 42);
});

for (const baseline of [-1, 0.5, '0', true, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, undefined]) {
  test(`run afterSeq rejects invalid baseline ${String(baseline)}`, async t => {
    const { store } = await fixture(t);
    await rejectsCode(store.update({ action: 'upsertRun', run: { status: 'running', afterSeq: baseline } }), 'invalid-input');
    assert.equal((await store.read()).runs.length, 0);
  });
}

test('invalid persisted afterSeq is corruption rather than a silently reset baseline', async t => {
  const { store, file } = await fixture(t);
  const current = await store.update({ action: 'upsertRun', run: { status: 'running', afterSeq: 42 } });
  current.runs[0].afterSeq = -1;
  const invalidSource = JSON.stringify(current);
  await writeFile(file, invalidSource);
  await rejectsCode(store.read(), 'storage-corrupt');
  assert.equal(await readFile(file, 'utf8'), invalidSource);
});

test('durable settings accept only theme and notification preferences', async t => {
  const { store, file } = await fixture(t);
  await store.update({ action: 'updateSettings', patch: { theme: 'dark', notifications: false } });
  assert.deepEqual((await new WorkspaceStore(file).read()).settings, { theme: 'dark', notifications: false });
  await rejectsCode(store.update({ action: 'updateSettings', patch: { apiKey: 'never allowed' } }), 'invalid-input');
});

for (const request of [
  null, [], new Date(), {}, { action: 'arbitrary' }, { action: 'createBot', name: '' }, { action: 'createBot', name: 'x', extra: 'unknown' },
  { action: 'createBot', name: 'x', role: 42 }, { action: 'createBot', name: 'x', avatar: { color: 'red', shape: 'circle' } },
  { action: 'createBot', name: 'x', avatar: { color: '#123456', shape: 'script' } }, { action: 'createBot', name: 'x', avatar: { color: '#123456', shape: 'circle', extra: true } },
  { action: 'updateBot', id: '__proto__', patch: { name: 'bad' } }, { action: 'updateBot', id: randomUUID(), patch: {} },
  { action: 'createBot', name: 'x', expectedRevision: -1 }, { action: 'createBot', name: 'x', expectedRevision: 1.2 },
  { action: 'setSession', botId: randomUUID(), sessionId: '/private/path' }, { action: 'setSession', botId: randomUUID(), sessionId: 'https://example.com' },
  { action: 'upsertRun', run: { status: 'pretend-done' } }, { action: 'upsertRun', run: { status: 'running', createdAt: 1 } },
  { action: 'appendGroupMessage', groupId: randomUUID(), message: { role: 'user', text: 'Hi', createdAt: 1 } },
  { action: 'updateSettings', patch: { notifications: 'yes' } }
]) test(`strict validation rejects ${JSON.stringify(request).slice(0, 105)}`, async t => { const { store } = await fixture(t); await rejectsCode(store.update(request), 'invalid-input'); assert.equal((await store.read()).revision, 0); });

test('prototype pollution keys, inherited input, symbols and getters are rejected without execution', async t => {
  const { store } = await fixture(t);
  const polluted = JSON.parse('{"action":"createBot","name":"x","__proto__":{"polluted":true}}');
  await rejectsCode(store.update(polluted), 'invalid-input');
  await rejectsCode(store.update(Object.assign(Object.create({ name: 'inherited' }), { action: 'createBot' })), 'invalid-input');
  await rejectsCode(store.update({ action: 'createBot', name: 'x', [Symbol('extra')]: true }), 'invalid-input');
  let read = false; const getter = { action: 'createBot', get name() { read = true; return 'x'; } };
  await rejectsCode(store.update(getter), 'invalid-input'); assert.equal(read, false);
  assert.equal({}.polluted, undefined);
});

test('input length boundaries reject over-limit data and NULs', async t => {
  const { store } = await fixture(t);
  await rejectsCode(store.update({ action: 'createBot', name: 'x'.repeat(WORKSPACE_LIMITS.name + 1) }), 'invalid-input');
  await rejectsCode(store.update({ action: 'createBot', name: 'ok', role: 'x'.repeat(WORKSPACE_LIMITS.role + 1) }), 'invalid-input');
  await rejectsCode(store.update({ action: 'addMemory', scope: 'shared', content: 'x'.repeat(WORKSPACE_LIMITS.memory + 1) }), 'invalid-input');
  await rejectsCode(store.update({ action: 'createTask', title: 'x\u0000bad' }), 'invalid-input');
  const state = await store.update({ action: 'createBot', name: 'x'.repeat(WORKSPACE_LIMITS.name), role: 'x'.repeat(WORKSPACE_LIMITS.role) });
  assert.equal(state.bots.length, 1);
});

test('fixed entity count limits fail closed without changing the original file', async t => {
  const { store, file } = await fixture(t);
  const state = createEmptyWorkspace();
  state.bots = Array.from({ length: WORKSPACE_LIMITS.bots }, (_, index) => ({ id: randomUUID(), name: `Bot ${index}`, role: '', avatar: { color: '#123456', shape: 'circle' }, sessionId: null, archived: false, createdAt: 1, updatedAt: 1 }));
  assert.doesNotThrow(() => validateWorkspaceSnapshot(state));
  await store.update({ action: 'updateSettings', patch: { theme: 'dark' } });
  await writeFile(file, JSON.stringify(state));
  const original = await readFile(file, 'utf8');
  await rejectsCode(makeBot(store, 'Overflow'), 'limit-exceeded');
  assert.equal(await readFile(file, 'utf8'), original);
});

test('group messages cap is explicit; old transcript is never silently truncated', async t => {
  const { store, file } = await fixture(t); const botId = (await makeBot(store)).bots[0].id;
  const state = await store.update({ action: 'createGroup', name: 'Team', memberIds: [botId] });
  const groupId = state.groups[0].id;
  state.groups[0].messages = Array.from({ length: WORKSPACE_LIMITS.messagesPerGroup }, () => ({ id: randomUUID(), role: 'user', botId: null, text: 'old', sessionId: null, runId: null, createdAt: 1 }));
  await writeFile(file, JSON.stringify(state));
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'user', text: 'overflow' } }), 'limit-exceeded');
  assert.equal((await store.read()).groups[0].messages.length, WORKSPACE_LIMITS.messagesPerGroup);
});

test('atomic writes leave no temporary files or locks and use owner-only permissions', async t => {
  const { store, file } = await fixture(t); await makeBot(store);
  assert.deepEqual(await readdir(dirname(file)), ['workspace.json']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), await store.read());
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('corrupt JSON, invalid persisted fields and unsupported versions are never overwritten', async t => {
  const { store, file } = await fixture(t); await makeBot(store);
  for (const invalid of ['{broken', JSON.stringify({ ...createEmptyWorkspace(), version: 99 }), JSON.stringify({ ...createEmptyWorkspace(), apiKey: 'not part of this schema' }), JSON.stringify({ ...createEmptyWorkspace(), primaryBotId: randomUUID() })]) {
    await writeFile(file, invalid);
    await rejectsCode(store.read(), 'storage-corrupt');
    await rejectsCode(makeBot(store), 'storage-corrupt');
    assert.equal(await readFile(file, 'utf8'), invalid);
    assert.deepEqual(await readdir(dirname(file)), ['workspace.json']);
  }
});

test('exclusive mutation lock prevents cross-process/instance overwrites; retry reloads latest file', async t => {
  const { store, file } = await fixture(t); await makeBot(store, 'First');
  await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid }));
  await rejectsCode(makeBot(store, 'Cannot overwrite'), 'storage-busy');
  assert.equal((await store.read()).bots.length, 1);
  // The exact fixture lock path is owned by this test, not a discovered live lock.
  assert.equal(resolve(`${file}.lock`), join(dirname(file), 'workspace.json.lock'));
  await rm(`${file}.lock`);
  const second = new WorkspaceStore(file);
  await makeBot(second, 'Second'); await makeBot(store, 'Third');
  assert.deepEqual((await store.read()).bots.map(b => b.name), ['First', 'Second', 'Third']);
});

// npm ci installs the pinned public SDK peers; developers may target their DSH
// installation explicitly without hard-coding one OS or a personal directory.
const SDK_ROOT = process.env.DSH_SDK_ROOT || fileURLToPath(new URL('../node_modules/@deepseek-ai', import.meta.url));
async function sdkFixture(t) {
  try { await access(join(SDK_ROOT, 'dsh-typert-protocol/lib/index.js')); } catch { t.skip('Installed DSH SDK not present on this machine'); return null; }
  const hostPath = new URL('../src/host-service.js', import.meta.url);
  let source = await readFile(hostPath, 'utf8');
  source = source.replace("'@deepseek-ai/dsh-typert-protocol'", JSON.stringify(pathToFileURL(join(SDK_ROOT, 'dsh-typert-protocol/lib/index.js')).href));
  source = source.replace("'@deepseek-ai/dsh-home-paths'", JSON.stringify(pathToFileURL(join(SDK_ROOT, 'dsh-home-paths/lib/index.js')).href));
  source = source.replace("'./host-store.mjs'", JSON.stringify(new URL('../src/host-store.mjs', import.meta.url).href));
  const service = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${randomUUID()}`);
  const [{ Context }, protocol] = await Promise.all([import(pathToFileURL(join(SDK_ROOT, 'cordis/lib/index.js')).href), import(pathToFileURL(join(SDK_ROOT, 'dsh-typert-protocol/lib/index.js')).href)]);
  return { service, Context, protocol };
}

test('plain JS Remote markers register read/update using the actual installed DSH SDK', async t => {
  const sdk = await sdkFixture(t); if (!sdk) return;
  const ctx = new sdk.Context();
  const service = new sdk.service.BotWorkspaceService(ctx, { read: async () => createEmptyWorkspace(), update: async request => request });
  assert.equal(service.typertRemote.namespace, 'botWorkspace'); assert.equal(service.typertRemote.serviceKey, 'botWorkspace');
  assert.deepEqual(sdk.protocol.remoteMethods(service).map(m => ({ method: m.method, invocation: m.invocation })), [{ method: 'read', invocation: { kind: 'direct' } }, { method: 'update', invocation: { kind: 'direct' } }]);
  assert.equal(service.read.length, 0); assert.equal(service.update.length, 1, 'Source reflection needs one exact named request argument');
});

test('native Cordis invocation scoping admits only owner reads/mutations, never direct/root or guest', async t => {
  const sdk = await sdkFixture(t); if (!sdk) return;
  const ctx = new sdk.Context(); let reads = 0, mutations = 0;
  const service = new sdk.service.BotWorkspaceService(ctx, { read: async () => { reads++; return createEmptyWorkspace(); }, update: async () => { mutations++; return createEmptyWorkspace(); } });
  await assert.rejects(service.read(), error => error.code === 'remote-access/denied');
  await assert.rejects(service.update({ action: 'createBot', name: 'denied' }), error => error.code === 'remote-access/denied');
  const guest = ctx.extend({ invocation: { peer: { principal: { kind: 'guest' } } } });
  await assert.rejects(guest.botWorkspace.read(), error => error.code === 'remote-access/denied');
  await assert.rejects(guest.botWorkspace.update({}), error => error.code === 'remote-access/denied');
  assert.equal(reads, 0); assert.equal(mutations, 0);
  const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } });
  assert.deepEqual(await owner.botWorkspace.read(), createEmptyWorkspace());
  await owner.botWorkspace.update({ action: 'createBot', name: 'allowed' });
  assert.equal(reads, 1); assert.equal(mutations, 1);
  assert.equal(ctx.invocation, undefined, 'Owner invocation does not leak into root');
});

test('host RPC reports validated business errors but redacts raw IO paths', async t => {
  const sdk = await sdkFixture(t); if (!sdk) return;
  const ctx = new sdk.Context(); let failure = new WorkspaceError('revision-conflict', 'Refresh before editing.');
  new sdk.service.BotWorkspaceService(ctx, { read: async () => { throw failure; }, update: async () => { throw failure; } });
  const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } });
  await assert.rejects(owner.botWorkspace.update({}), error => error.code === 'bot-workspace/revision-conflict' && error.message === 'Refresh before editing.');
  failure = new Error('EACCES /private/credentials.json');
  await assert.rejects(owner.botWorkspace.read(), error => error.code === 'bot-workspace/storage-error' && !error.message.includes('/private'));
});


test('owned turn and pending native-result outbox round-trip without changing schema version', async t => {
  const { store, file } = await fixture(t), id = randomUUID();
  await store.update({ action: 'upsertRun', run: { id, status: 'running', afterSeq: 10, dispatchId: id, turn: 2, settled: false } });
  await store.update({ action: 'upsertRun', run: { id, status: 'completed', summary: 'real completion', reply: 'public reply', settled: false } });
  const state = await new WorkspaceStore(file).read(); assert.equal(state.version, 1); assert.equal(state.runs[0].dispatchId, id); assert.equal(state.runs[0].turn, 2); assert.equal(state.runs[0].reply, 'public reply'); assert.equal(state.runs[0].settled, false);
  const stale = await store.update({ action: 'upsertRun', run: { id, status: 'waiting', summary: 'stale observer' } }); assert.equal(stale.runs[0].status, 'completed'); assert.equal(stale.runs[0].summary, 'real completion');
  await store.update({ action: 'upsertRun', run: { id, status: 'completed', settled: true } }); assert.equal((await store.read()).runs[0].settled, true);
});
test('legacy run ownership is unknown while legacy terminal records do not invent pending deliveries', async t => {
  const { store, file } = await fixture(t); await store.update({ action: 'upsertRun', run: { status: 'running' } }); let snapshot = await store.update({ action: 'upsertRun', run: { status: 'completed' } });
  for (const run of snapshot.runs) for (const key of ['dispatchId', 'turn', 'settled', 'reply']) delete run[key]; await writeFile(file, JSON.stringify(snapshot));
  snapshot = await new WorkspaceStore(file).read(); assert.equal(snapshot.runs[0].dispatchId, null); assert.equal(snapshot.runs[0].turn, null); assert.equal(snapshot.runs[0].settled, false); assert.equal(snapshot.runs[1].settled, true);
});
test('archival and member removal do not lose an already-admitted matching terminal run delivery', async t => {
  const { store } = await fixture(t); let state = await makeBot(store); const botId = state.bots[0].id;
  state = await store.update({ action: 'createGroup', name: 'Crew', memberIds: [botId] }); const groupId = state.groups[0].id, runId = randomUUID();
  await store.update({ action: 'upsertRun', run: { id: runId, botId, groupId, sessionId: 'native-owned', dispatchId: runId, turn: 2, afterSeq: 10, status: 'completed', summary: 'real output', reply: 'real output', settled: false } });
  await store.update({ action: 'updateGroup', id: groupId, patch: { archived: true, memberIds: [] } });
  const request = { action: 'appendGroupMessage', groupId, message: { id: runId, role: 'assistant', botId, runId, sessionId: 'native-owned', text: 'real output' } };
  state = await store.update(request); assert.equal(state.groups[0].messages.length, 1); const revision = state.revision; assert.equal((await store.update(request)).revision, revision);
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'user', text: 'new work' } }), 'invalid-input');
  await rejectsCode(store.update({ action: 'appendGroupMessage', groupId, message: { role: 'assistant', botId, runId, sessionId: 'native-owned', text: 'unproven different output' } }), 'invalid-input');
});
for (const run of [{ status: 'queued', turn: -1 }, { status: 'queued', turn: 1.5 }, { status: 'queued', settled: 'false' }, { status: 'queued', dispatchId: 'not-a-uuid' }, { status: 'queued', reply: {} }]) test(`new run ownership/outbox rejects malformed ${Object.keys(run).at(-1)}`, async t => { const { store } = await fixture(t); await rejectsCode(store.update({ action: 'upsertRun', run }), 'invalid-input'); });


test('explicit group clear frees full history without deleting active task or durable reply proof', async t => {
  const { store, file } = await fixture(t); let state = await makeBot(store); const botId = state.bots[0].id;
  state = await store.update({ action: 'createGroup', name: 'Full history', memberIds: [botId] }); const groupId = state.groups[0].id;
  state = await store.update({ action: 'createTask', groupId, title: 'admitted work' }); const taskId = state.tasks[0].id, id = randomUUID();
  state = await store.update({ action: 'upsertRun', run: { id, taskId, botId, groupId, sessionId: 'native-safe', status: 'completed', dispatchId: id, turn: 2, summary: 'REAL PROOF', reply: 'REAL PROOF', settled: false } });
  state.groups[0].messages = Array.from({ length: 400 }, (_, i) => ({ id: randomUUID(), role: 'user', botId: null, sessionId: null, runId: null, text: `old ${i}`, createdAt: 1 })); await writeFile(file, JSON.stringify(state));
  const proof = structuredClone(state.runs[0]), task = structuredClone(state.tasks[0]); state = await store.update({ action: 'clearGroupMessages', id: groupId });
  assert.equal(state.groups[0].messages.length, 0); assert.deepEqual(state.runs[0], proof); assert.deepEqual(state.tasks[0], task);
  state = await store.update({ action: 'appendGroupMessage', groupId, message: { id, runId: id, botId, role: 'assistant', sessionId: 'native-safe', text: 'REAL PROOF' } }); assert.equal(state.groups[0].messages.length, 1); assert.equal(state.groups[0].messages[0].text, 'REAL PROOF');
});
test('explicit ended-record cleanup preserves every active or unsettled dependency in both directions', async t => {
  const { store } = await fixture(t); const keepTasks = [], keepRuns = [], removeTasks = [], removeRuns = [];
  const add = async (taskStatus, runStatus, settled) => { let taskId = null; if (taskStatus) { let state = await store.update({ action: 'createTask', title: taskStatus }); taskId = state.tasks.at(-1).id; if (taskStatus !== 'queued') await store.update({ action: 'updateTask', id: taskId, patch: { status: taskStatus } }); } let id = null; if (runStatus) { id = randomUUID(); await store.update({ action: 'upsertRun', run: { id, taskId, status: runStatus, ...(settled === undefined ? {} : { settled }) } }); } return [taskId, id]; };
  for (const args of [['running', 'completed', true], ['completed', 'running', true], ['failed', 'failed', false]]) { const [task, run] = await add(...args); keepTasks.push(task); keepRuns.push(run); }
  for (const args of [['completed', 'completed', true], ['cancelled', null], [null, 'completed']]) { const [task, run] = await add(...args); if (task) removeTasks.push(task); if (run) removeRuns.push(run); }
  for (const args of [[null, 'waiting', true], [null, 'completed', false]]) { const [, run] = await add(...args); keepRuns.push(run); }
  const state = await store.update({ action: 'cleanupEndedRecords' }); assert.deepEqual(state.tasks.map(task => task.id).sort(), keepTasks.sort()); assert.deepEqual(state.runs.map(run => run.id).sort(), keepRuns.sort());
  assert.ok(removeTasks.every(id => !state.tasks.some(task => task.id === id))); assert.ok(removeRuns.every(id => !state.runs.some(run => run.id === id)));
});
for (const action of ['deleteBot', 'deleteGroup', 'deleteTask']) test(`${action} cannot delete a pending terminal-proof dependency`, async t => {
  const { store } = await fixture(t); let state = await makeBot(store); const botId = state.bots[0].id;
  state = await store.update({ action: 'createGroup', name: 'Protected', memberIds: [botId] }); const groupId = state.groups[0].id;
  state = await store.update({ action: 'createTask', groupId, title: 'proof pending' }); const taskId = state.tasks[0].id;
  await store.update({ action: 'updateTask', id: taskId, patch: { status: 'completed' } }); const runId = randomUUID();
  await store.update({ action: 'upsertRun', run: { id: runId, taskId, botId, groupId, status: 'completed', settled: false, reply: 'not delivered' } });
  const request = { action, id: action === 'deleteBot' ? botId : action === 'deleteGroup' ? groupId : taskId }; const before = await store.read();
  await rejectsCode(store.update(request), 'work-active'); assert.deepEqual(await store.read(), before);
  await store.update({ action: 'upsertRun', run: { id: runId, status: 'completed', settled: true } }); await store.update(request);
});
