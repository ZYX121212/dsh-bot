import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Durable user-managed metadata only. Native conversation logs remain owned by DSH. */
export const WORKSPACE_LIMITS = Object.freeze({ bots: 100, groups: 100, messagesPerGroup: 400, memories: 1000, tasks: 1000, runs: 3000, name: 80, role: 12000, memory: 8000, text: 32000, summary: 32000, title: 240, bytes: 32 * 1024 * 1024 });
const STATUSES = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
const SHAPES = ['circle', 'square', 'diamond', 'hexagon'];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const clone = value => JSON.parse(JSON.stringify(value));
export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspaceError'; this.code = code; }
}
const fail = message => { throw new WorkspaceError('invalid-input', message); };
function object(value, keys, required = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected a plain object.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Unexpected or unsafe field: ${String(key).slice(0, 80)}`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`Missing field: ${key}`);
  return value;
}
function text(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > max || result.includes('\u0000')) fail(`${label} must contain ${allowEmpty ? '0' : '1'}–${max} characters and no NUL.`);
  return result;
}
function id(value, label = 'id') { if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`); return value; }
function nullableId(value, label = 'id') { return value === null ? null : id(value, label); }
function sessionId(value) { if (value === null) return null; if (typeof value !== 'string' || !SESSION.test(value)) fail('sessionId must be a native DSH identity, not a URL or path.'); return value; }
function bool(value) { if (typeof value !== 'boolean') fail('Expected a boolean.'); return value; }
function choice(value, allowed, label) { if (!allowed.includes(value)) fail(`Invalid ${label}.`); return value; }
function count(value, max, label) { if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds its allowed count.`); return value; }
function timestamp(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail('Invalid timestamp.'); return value; }
function afterSeq(value) { if (value === null) return null; if (!Number.isSafeInteger(value) || value < 0) fail('afterSeq must be null or a nonnegative safe integer.'); return value === 0 ? 0 : value; }
function avatar(value) { object(value, ['color', 'shape'], ['color', 'shape']); if (typeof value.color !== 'string' || !/^#[a-f\d]{6}$/i.test(value.color)) fail('Avatar color must be #RRGGBB.'); return { color: value.color.toLowerCase(), shape: choice(value.shape, SHAPES, 'avatar shape') }; }
function memberIds(value) { const result = count(value, WORKSPACE_LIMITS.bots, 'Members').map(item => id(item, 'memberId')); if (new Set(result).size !== result.length) fail('Group members must be unique.'); return result; }
function patchFields(value, validators) {
  object(value, Object.keys(validators));
  if (!Object.keys(value).length) fail('An empty patch has no effect.');
  return Object.fromEntries(Object.keys(value).map(key => [key, validators[key](value[key])]));
}
const botPatch = { name: v => text(v, 'name', WORKSPACE_LIMITS.name), role: v => text(v, 'role', WORKSPACE_LIMITS.role, true), avatar };
const taskPatch = { title: v => text(v, 'title', WORKSPACE_LIMITS.title), status: v => choice(v, STATUSES, 'status'), sessionId, summary: v => text(v, 'summary', WORKSPACE_LIMITS.summary, true) };
const runPatch = { taskId: nullableId, botId: nullableId, groupId: nullableId, sessionId, afterSeq, status: v => choice(v, STATUSES, 'status'), title: v => text(v, 'title', WORKSPACE_LIMITS.title, true), summary: v => text(v, 'summary', WORKSPACE_LIMITS.summary, true) };

/** Strict allowlisted mutation contract. No unknown action/field reaches storage. */
export function validateWorkspaceRequest(request) {
  object(request, ['action', 'expectedRevision', 'name', 'role', 'avatar', 'id', 'patch', 'archived', 'botId', 'sessionId', 'expectedSessionId', 'memberIds', 'groupId', 'message', 'scope', 'content', 'title', 'run']);
  if (typeof request.action !== 'string' || request.action.length > 40) fail('action must be a supported operation name.');
  if (Object.hasOwn(request, 'expectedRevision') && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) fail('expectedRevision must be a nonnegative integer.');
  const base = ['action', 'expectedRevision'];
  const allow = (keys, required = keys) => object(request, [...base, ...keys], ['action', ...required]);
  const result = { action: request.action };
  if (Object.hasOwn(request, 'expectedRevision')) result.expectedRevision = request.expectedRevision;
  switch (request.action) {
    case 'createBot': allow(['name', 'role', 'avatar'], ['name']); Object.assign(result, { name: botPatch.name(request.name), role: Object.hasOwn(request, 'role') ? botPatch.role(request.role) : '', avatar: Object.hasOwn(request, 'avatar') ? avatar(request.avatar) : { color: '#b7d7ff', shape: 'circle' } }); break;
    case 'updateBot': allow(['id', 'patch']); Object.assign(result, { id: id(request.id), patch: patchFields(request.patch, botPatch) }); break;
    case 'archiveBot': allow(['id', 'archived']); Object.assign(result, { id: id(request.id), archived: bool(request.archived) }); break;
    case 'deleteBot': case 'deleteGroup': case 'removeMemory': case 'deleteTask': allow(['id']); result.id = id(request.id); break;
    case 'setPrimary': allow(['id']); result.id = nullableId(request.id); break;
    case 'setSession': allow(['botId', 'sessionId', 'expectedSessionId'], ['botId', 'sessionId']); Object.assign(result, { botId: id(request.botId), sessionId: sessionId(request.sessionId) }); if (Object.hasOwn(request, 'expectedSessionId')) result.expectedSessionId = sessionId(request.expectedSessionId); break;
    case 'createGroup': allow(['name', 'memberIds']); Object.assign(result, { name: text(request.name, 'name', WORKSPACE_LIMITS.name), memberIds: memberIds(request.memberIds) }); if (!result.memberIds.length) fail('A group needs at least one Bot.'); break;
    case 'updateGroup': allow(['id', 'patch']); Object.assign(result, { id: id(request.id), patch: patchFields(request.patch, { name: botPatch.name, memberIds, archived: bool }) }); break;
    case 'appendGroupMessage': {
      allow(['groupId', 'message']); result.groupId = id(request.groupId);
      object(request.message, ['id', 'role', 'botId', 'text', 'sessionId', 'runId'], ['role', 'text']);
      const value = request.message;
      result.message = { role: choice(value.role, ['user', 'assistant', 'system'], 'message role'), botId: Object.hasOwn(value, 'botId') ? nullableId(value.botId) : null, text: text(value.text, 'text', WORKSPACE_LIMITS.text), sessionId: Object.hasOwn(value, 'sessionId') ? sessionId(value.sessionId) : null, runId: Object.hasOwn(value, 'runId') ? nullableId(value.runId) : null };
      if (Object.hasOwn(value, 'id')) result.message.id = id(value.id);
      if (result.message.role === 'assistant' && !result.message.botId) fail('Assistant group messages must identify a Bot.');
      break;
    }
    case 'addMemory': allow(['scope', 'botId', 'content'], ['scope', 'content']); Object.assign(result, { scope: choice(request.scope, ['bot', 'shared'], 'memory scope'), botId: Object.hasOwn(request, 'botId') ? nullableId(request.botId) : null, content: text(request.content, 'content', WORKSPACE_LIMITS.memory) }); if ((result.scope === 'bot') !== (result.botId !== null)) fail('Bot memory requires botId; shared memory must not identify a Bot.'); break;
    case 'updateMemory': allow(['id', 'content']); Object.assign(result, { id: id(request.id), content: text(request.content, 'content', WORKSPACE_LIMITS.memory) }); break;
    case 'createTask': allow(['title', 'botId', 'groupId', 'sessionId'], ['title']); Object.assign(result, { title: text(request.title, 'title', WORKSPACE_LIMITS.title), botId: Object.hasOwn(request, 'botId') ? nullableId(request.botId) : null, groupId: Object.hasOwn(request, 'groupId') ? nullableId(request.groupId) : null, sessionId: Object.hasOwn(request, 'sessionId') ? sessionId(request.sessionId) : null }); break;
    case 'updateTask': allow(['id', 'patch']); Object.assign(result, { id: id(request.id), patch: patchFields(request.patch, taskPatch) }); break;
    case 'upsertRun': allow(['run']); object(request.run, ['id', ...Object.keys(runPatch)], ['status']); result.run = patchFields(Object.fromEntries(Object.entries(request.run).filter(([key]) => key !== 'id')), runPatch); if (Object.hasOwn(request.run, 'id')) result.run.id = id(request.run.id); break;
    case 'updateSettings': allow(['patch']); result.patch = patchFields(request.patch, { theme: v => choice(v, ['system', 'light', 'dark'], 'theme'), notifications: bool }); break;
    default: fail(`Unknown workspace action: ${request.action}`);
  }
  return result;
}

export function createEmptyWorkspace() { return { version: 1, revision: 0, primaryBotId: null, bots: [], groups: [], memories: [], tasks: [], runs: [], settings: { theme: 'system', notifications: true } }; }
function unique(rows, label) { const ids = rows.map(row => row.id); if (new Set(ids).size !== ids.length) fail(`Duplicate ${label} identity.`); }
function storedEntity(value, keys) { object(value, keys, keys); id(value.id); timestamp(value.createdAt); timestamp(value.updatedAt); }
/** Corruption is reported, never silently replaced with an empty workspace. */
export function validateWorkspaceSnapshot(value) {
  object(value, ['version', 'revision', 'primaryBotId', 'bots', 'groups', 'memories', 'tasks', 'runs', 'settings'], ['version', 'revision', 'primaryBotId', 'bots', 'groups', 'memories', 'tasks', 'runs', 'settings']);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('Unsupported workspace version or revision.');
  nullableId(value.primaryBotId);
  for (const bot of count(value.bots, WORKSPACE_LIMITS.bots, 'Bots')) { storedEntity(bot, ['id', 'name', 'role', 'avatar', 'sessionId', 'archived', 'createdAt', 'updatedAt']); botPatch.name(bot.name); botPatch.role(bot.role); avatar(bot.avatar); sessionId(bot.sessionId); bool(bot.archived); }
  for (const group of count(value.groups, WORKSPACE_LIMITS.groups, 'Groups')) {
    storedEntity(group, ['id', 'name', 'memberIds', 'messages', 'archived', 'createdAt', 'updatedAt']); botPatch.name(group.name); memberIds(group.memberIds); bool(group.archived);
    for (const message of count(group.messages, WORKSPACE_LIMITS.messagesPerGroup, 'Group messages')) { object(message, ['id', 'role', 'botId', 'text', 'createdAt', 'sessionId', 'runId'], ['id', 'role', 'botId', 'text', 'createdAt', 'sessionId', 'runId']); id(message.id); choice(message.role, ['user', 'assistant', 'system'], 'message role'); nullableId(message.botId); text(message.text, 'text', WORKSPACE_LIMITS.text); timestamp(message.createdAt); sessionId(message.sessionId); nullableId(message.runId); if (message.role === 'assistant' && message.botId === null) fail('Invalid assistant group author.'); }
    unique(group.messages, 'message');
  }
  for (const memory of count(value.memories, WORKSPACE_LIMITS.memories, 'Memories')) { storedEntity(memory, ['id', 'scope', 'botId', 'content', 'createdAt', 'updatedAt']); choice(memory.scope, ['bot', 'shared'], 'scope'); nullableId(memory.botId); text(memory.content, 'content', WORKSPACE_LIMITS.memory); if ((memory.scope === 'bot') !== (memory.botId !== null)) fail('Invalid stored memory scope.'); }
  for (const task of count(value.tasks, WORKSPACE_LIMITS.tasks, 'Tasks')) { storedEntity(task, ['id', 'botId', 'groupId', 'title', 'status', 'sessionId', 'summary', 'createdAt', 'updatedAt']); nullableId(task.botId); nullableId(task.groupId); taskPatch.title(task.title); taskPatch.status(task.status); sessionId(task.sessionId); taskPatch.summary(task.summary); }
  for (const run of count(value.runs, WORKSPACE_LIMITS.runs, 'Runs')) {
    // Schema-v1 files written before recovery baselines existed omit afterSeq.
    const required = ['id', 'taskId', 'botId', 'groupId', 'sessionId', 'status', 'title', 'summary', 'createdAt', 'updatedAt'];
    object(run, [...required, 'afterSeq'], required); id(run.id); timestamp(run.createdAt); timestamp(run.updatedAt);
    for (const [key, validate] of Object.entries(runPatch)) if (key !== 'afterSeq' || Object.hasOwn(run, key)) validate(run[key]);
  }
  object(value.settings, ['theme', 'notifications'], ['theme', 'notifications']); choice(value.settings.theme, ['system', 'dark', 'light'], 'theme'); bool(value.settings.notifications);
  for (const [label, rows] of [['Bot', value.bots], ['group', value.groups], ['memory', value.memories], ['task', value.tasks], ['run', value.runs]]) unique(rows, label);
  if (value.primaryBotId && !value.bots.some(bot => bot.id === value.primaryBotId && !bot.archived)) fail('Primary Bot must exist and be unarchived.');
  for (const group of value.groups) for (const member of group.memberIds) if (!value.bots.some(bot => bot.id === member)) fail('Group member does not exist.');
  for (const memory of value.memories) if (memory.botId && !value.bots.some(bot => bot.id === memory.botId)) fail('Memory Bot does not exist.');
  return value;
}
function found(rows, target, label) { const item = rows.find(row => row.id === target); if (!item) throw new WorkspaceError('not-found', `${label} not found.`); return item; }
function capacity(rows, max, label) { if (rows.length >= max) throw new WorkspaceError('limit-exceeded', `${label} limit reached. Archive/delete records before adding more.`); }
function applyMutation(state, request, now, uuid) {
  const stamp = () => ({ id: uuid(), createdAt: now, updatedAt: now });
  const bot = target => found(state.bots, target, 'Bot');
  const group = target => found(state.groups, target, 'Group');
  const verifyMembers = values => { for (const target of values) bot(target); };
  const verifyRefs = value => { if (value.botId) bot(value.botId); if (value.groupId) group(value.groupId); if (value.taskId) found(state.tasks, value.taskId, 'Task'); };
  switch (request.action) {
    case 'createBot': capacity(state.bots, WORKSPACE_LIMITS.bots, 'Bots'); state.bots.push({ ...stamp(), name: request.name, role: request.role, avatar: request.avatar, sessionId: null, archived: false }); break;
    case 'updateBot': Object.assign(bot(request.id), request.patch, { updatedAt: now }); break;
    case 'archiveBot': bot(request.id).archived = request.archived; bot(request.id).updatedAt = now; if (request.archived && state.primaryBotId === request.id) state.primaryBotId = null; break;
    case 'deleteBot': bot(request.id); state.bots = state.bots.filter(item => item.id !== request.id); state.memories = state.memories.filter(item => item.botId !== request.id); for (const item of state.groups) if (item.memberIds.includes(request.id)) { item.memberIds = item.memberIds.filter(member => member !== request.id); item.updatedAt = now; } if (state.primaryBotId === request.id) state.primaryBotId = null; break;
    case 'setPrimary': if (request.id && bot(request.id).archived) fail('An archived Bot cannot be primary.'); state.primaryBotId = request.id; break;
    case 'setSession': {
      const target = bot(request.botId);
      if (Object.hasOwn(request, 'expectedSessionId') ? target.sessionId !== request.expectedSessionId : target.sessionId !== null && target.sessionId !== request.sessionId) throw new WorkspaceError('session-conflict', 'This Bot already has a different native session. Refresh before replacing it.');
      target.sessionId = request.sessionId; target.updatedAt = now; break;
    }
    case 'createGroup': capacity(state.groups, WORKSPACE_LIMITS.groups, 'Groups'); verifyMembers(request.memberIds); state.groups.push({ ...stamp(), name: request.name, memberIds: request.memberIds, messages: [], archived: false }); break;
    case 'updateGroup': if (request.patch.memberIds) verifyMembers(request.patch.memberIds); Object.assign(group(request.id), request.patch, { updatedAt: now }); break;
    case 'deleteGroup': group(request.id); state.groups = state.groups.filter(item => item.id !== request.id); break;
    case 'appendGroupMessage': {
      const target = group(request.groupId);
      if (target.archived) fail('Cannot append to an archived group.');
      if (request.message.botId && !target.memberIds.includes(request.message.botId)) fail('Message author must be a current group member.');
      const message = { ...request.message, id: request.message.id ?? uuid(), createdAt: now };
      const existing = target.messages.find(row => row.id === message.id);
      if (existing) { if (['role', 'botId', 'text', 'sessionId', 'runId'].some(key => existing[key] !== message[key])) throw new WorkspaceError('message-conflict', 'Message identity already has different content.'); return false; }
      capacity(target.messages, WORKSPACE_LIMITS.messagesPerGroup, 'Group messages'); target.messages.push(message); target.updatedAt = now; break;
    }
    case 'addMemory': capacity(state.memories, WORKSPACE_LIMITS.memories, 'Memories'); if (request.botId) bot(request.botId); state.memories.push({ ...stamp(), scope: request.scope, botId: request.botId, content: request.content }); break;
    case 'updateMemory': Object.assign(found(state.memories, request.id, 'Memory'), { content: request.content, updatedAt: now }); break;
    case 'removeMemory': found(state.memories, request.id, 'Memory'); state.memories = state.memories.filter(item => item.id !== request.id); break;
    case 'createTask': capacity(state.tasks, WORKSPACE_LIMITS.tasks, 'Tasks'); verifyRefs(request); state.tasks.push({ ...stamp(), botId: request.botId, groupId: request.groupId, title: request.title, sessionId: request.sessionId, status: 'queued', summary: '' }); break;
    case 'updateTask': Object.assign(found(state.tasks, request.id, 'Task'), request.patch, { updatedAt: now }); break;
    case 'deleteTask': found(state.tasks, request.id, 'Task'); state.tasks = state.tasks.filter(item => item.id !== request.id); for (const run of state.runs) if (run.taskId === request.id) { run.taskId = null; run.updatedAt = now; } break;
    case 'upsertRun': {
      const old = request.run.id ? state.runs.find(item => item.id === request.run.id) : null;
      if (old) { verifyRefs(Object.fromEntries(Object.entries(request.run).filter(([key, value]) => ['taskId', 'botId', 'groupId'].includes(key) && value !== old[key]))); Object.assign(old, request.run, { updatedAt: now }); }
      else { capacity(state.runs, WORKSPACE_LIMITS.runs, 'Runs'); verifyRefs(request.run); state.runs.push({ ...stamp(), taskId: null, botId: null, groupId: null, sessionId: null, afterSeq: null, title: '', summary: '', ...request.run }); }
      break;
    }
    case 'updateSettings': Object.assign(state.settings, request.patch); break;
  }
  return true;
}

/** One queue per instance plus an exclusive on-disk mutation lock across instances/processes. */
export class WorkspaceStore {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('A fixed storage path is required.');
    this.filePath = resolve(filePath);
    this.queue = Promise.resolve();
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
  }
  read() { return this.enqueue(async () => clone(await this.load())); }
  update(input) {
    // Validate and detach synchronously so a queued caller cannot mutate its request later.
    let request;
    try { request = validateWorkspaceRequest(input); } catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const lockPath = `${this.filePath}.lock`;
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new WorkspaceError('storage-busy', 'Another process is changing the Bot workspace, or a stale lock remains after a crash. Retry; do not delete a live process lock.'); throw error; }
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        const state = await this.load();
        if (Object.hasOwn(request, 'expectedRevision') && request.expectedRevision !== state.revision) throw new WorkspaceError('revision-conflict', 'The Bot workspace changed. Refresh before applying this edit.');
        if (!applyMutation(state, request, this.now(), this.uuid)) return clone(state);
        state.revision += 1;
        validateWorkspaceSnapshot(state);
        await this.save(state);
        return clone(state);
      } finally { await lock.close(); await unlink(lockPath); }
    });
  }
  enqueue(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async load() {
    let source;
    try { source = await readFile(this.filePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return createEmptyWorkspace(); throw error; }
    if (Buffer.byteLength(source) > WORKSPACE_LIMITS.bytes) throw new WorkspaceError('storage-corrupt', 'Bot workspace exceeds the storage size limit; original file was not changed.');
    try {
      const snapshot = validateWorkspaceSnapshot(JSON.parse(source));
      for (const run of snapshot.runs) if (!Object.hasOwn(run, 'afterSeq')) run.afterSeq = null;
      return snapshot;
    } catch (error) { throw new WorkspaceError('storage-corrupt', 'Cannot read Bot workspace: stored JSON/schema is invalid. The original file was not changed.'); }
  }
  async save(state) {
    const source = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(source) > WORKSPACE_LIMITS.bytes) throw new WorkspaceError('limit-exceeded', 'Bot workspace exceeds 32 MiB. Export and remove old records before adding more.');
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(source, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, this.filePath);
      // Atomic rename is the commit. Directory fsync is best effort on unsupported platforms.
      try { const directory = await open(dirname(this.filePath), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
    } finally {
      if (handle) await handle.close();
      // This exact temp name was exclusively created by this operation.
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
