import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBotPresence as derive, BOT_PRESENCE_FLASH_MS } from '../src/bot-presence.mjs';
import { extractRuntimeSnapshot } from '../src/runtime.mjs';

const now = 1_800_000_000_000;
const running = extra => ({ sessionId: 's1', running: true, activities: [], messages: [], ...extra });
const presence = options => derive({ now, ...options });
const tool = (toolName, extra = {}) => ({ toolName, status: 'running', turn: 2, seq: 20, time: now - 50, ...extra });

test('empty and role-only inputs are idle, not invented activity', () => {
  assert.equal(derive().state, 'idle');
  for (const role of ['researcher', 'coder', 'writer']) assert.equal(presence({ run: { role, title: 'bash research writing' } }).state, 'idle');
  assert.equal(presence({ snapshot: { running: false, activities: [tool('bash')] } }).state, 'idle');
});

test('real pending attention wins over running tools, partial output and queue', () => {
  for (const pending of [{ needsAttention: true }, { approval: { reason: 'private', toolName: 'bash' } }]) {
    const value = presence({ snapshot: running({ ...pending, activities: [tool('web_search')], messages: [{ role: 'assistant', partial: true, text: 'secret' }] }), job: { status: 'queued' } });
    assert.equal(value.state, 'waiting');
    assert.equal(value.source, 'snapshot');
    assert.ok(!JSON.stringify(value).includes('private'));
  }
});

test('only currently running tool calls determine tool activity', () => {
  for (const toolName of ['web_search', 'functions.research', 'web_fetch', 'browser', 'research_bash']) assert.equal(presence({ snapshot: running({ activities: [tool(toolName)] }) }).state, 'researching');
  for (const toolName of ['bash', 'terminal_send', 'edit', 'write', 'test', 'git_status', 'apply_patch']) assert.equal(presence({ snapshot: running({ activities: [tool(toolName)] }) }).state, 'coding');
  assert.equal(presence({ snapshot: running({ activities: [tool('weather')] }) }).state, 'working');
  for (const status of ['done', 'error', 'interrupted', undefined]) assert.equal(presence({ snapshot: running({ activities: [tool('bash', { status })] }) }).state, 'thinking');
});

test('latest running tool wins and stale earlier-turn calls are ignored', () => {
  assert.equal(presence({ snapshot: running({ latestTurn: 2, activities: [tool('bash', { seq: 21 }), tool('search', { seq: 20 })] }) }).state, 'coding');
  assert.equal(presence({ snapshot: running({ latestTurn: 3, activities: [tool('bash')] }) }).state, 'thinking');
  assert.equal(presence({ snapshot: running({ lastTurnEnd: { seq: 30, turn: 2 }, activities: [tool('bash')] }) }).state, 'thinking');
});

test('live public assistant text requires an actually running session', () => {
  const messages = [{ role: 'assistant', partial: true, text: 'private partial', seq: 31, turn: 3, time: now - 1 }];
  assert.equal(presence({ snapshot: running({ messages }) }).state, 'writing');
  assert.equal(presence({ snapshot: { running: false, messages } }).state, 'idle');
  assert.equal(presence({ snapshot: running({ messages, activities: [tool('bash')] }) }).state, 'coding');
  assert.equal(presence({ snapshot: running({ messages, latestTurn: 4 }) }).state, 'thinking');
  assert.equal(presence({ snapshot: running({ messages, lastTurnEnd: { seq: 32, turn: 3 } }) }).state, 'thinking');
  for (const text of ['', '  ', null]) assert.equal(presence({ snapshot: running({ messages: [{ role: 'assistant', partial: true, text }] }) }).state, 'thinking');
  for (const row of [{ role: 'user', partial: true, text: 'hi' }, { role: 'assistant', partial: false, text: 'hi' }]) assert.equal(presence({ snapshot: running({ messages: [row] }) }).state, 'thinking');
});

test('generic native running is thinking, regardless of role and stale error', () => {
  assert.equal(presence({ snapshot: running({ error: 'previous turn', lastTurnEnd: { reason: 'error', time: now - 1 } }), run: { role: 'coder' } }).state, 'thinking');
});

test('queued reservations are legitimate but saved running records are not native activity', () => {
  assert.equal(presence({ job: { status: 'queued' } }).state, 'queued');
  assert.equal(presence({ snapshot: running(), job: { status: 'queued' } }).state, 'thinking');
  for (const record of [{ run: { status: 'running' } }, { run: { status: 'queued' } }, { job: { status: 'running' } }]) {
    const value = presence(record);
    assert.equal(value.state, 'idle');
    assert.equal(value.label, '待核实');
  }
  assert.equal(presence({ run: { status: 'waiting' } }).source, 'run');
  assert.equal(presence({ run: { status: 'waiting' } }).state, 'waiting');
  assert.equal(presence({ snapshot: { running: false }, run: { status: 'running' } }).state, 'idle');
});

test('completion flashes only for a recent actual end and exposes its expiry', () => {
  const value = presence({ snapshot: { lastTurnEnd: { reason: 'completed', time: now - 10 } } });
  assert.equal(value.state, 'completed');
  assert.equal(value.updatedAt, now - 10);
  assert.equal(value.until, now - 10 + BOT_PRESENCE_FLASH_MS);
  for (const time of [undefined, null, 0, NaN, now + 1, now - BOT_PRESENCE_FLASH_MS, now - 86_400_000]) {
    assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'completed', time } } }).state, 'idle');
  }
  assert.equal(derive({ now: value.until, snapshot: { lastTurnEnd: { reason: 'completed', time: value.updatedAt } } }).state, 'idle');
});

test('remount does not replay historical completed runs or metadata updatedAt', () => {
  assert.equal(presence({ run: { status: 'completed', updatedAt: now } }).state, 'idle');
  assert.equal(presence({ run: { status: 'completed', completedAt: now - 10 } }).state, 'completed');
  assert.equal(presence({ run: { status: 'completed', endedAt: new Date(now - 10).toISOString() } }).state, 'completed');
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'completed' } }, run: { status: 'completed', completedAt: now } }).state, 'idle');
});

test('terminal error and blocked remain actionable; recent abort expires', () => {
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'error' } } }).state, 'error');
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: { kind: 'blocked' } } } }).state, 'waiting');
  assert.equal(presence({ snapshot: { error: 'private error' } }).state, 'error');
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'aborted', time: now - 1 } } }).state, 'stopped');
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'aborted', time: now - 7000 } } }).state, 'idle');
  assert.equal(presence({ snapshot: { lastTurnEnd: { reason: 'aborted' } } }).state, 'idle');
  assert.equal(presence({ run: { status: 'failed' } }).label, '遇到问题（记录）');
});

test('offline only applies to known sessions and opening/removal errors are honest', () => {
  assert.equal(presence({ connected: false }).state, 'idle');
  for (const input of [{ sessionId: 's1' }, { run: { sessionId: 's1' } }, { snapshot: running() }]) assert.equal(presence({ connected: false, ...input }).state, 'offline');
  assert.equal(presence({ snapshot: running({ removed: true }) }).state, 'offline');
  assert.equal(presence({ snapshot: running({ openError: 'private' }) }).state, 'error');
  assert.equal(presence({ snapshot: running({ openState: 'error' }) }).state, 'error');
});

test('a mismatched session snapshot never makes another Bot busy', () => {
  assert.equal(presence({ sessionId: 'other', snapshot: running() }).state, 'idle');
  assert.equal(presence({ sessionId: 's1', snapshot: running() }).state, 'thinking');
  assert.equal(presence({ job: { status: 'running', snapshot: running() } }).state, 'thinking');
});

test('output is bounded presentation metadata only and does not mutate input', () => {
  const activity = Object.freeze(tool('web_search<script>\n' + 'x'.repeat(300), { args: 'secret args', result: 'secret result' }));
  const snapshot = Object.freeze(running({ activities: Object.freeze([activity]), messages: Object.freeze([]) }));
  const value = presence({ snapshot, run: { title: 'secret title', summary: 'secret summary' } });
  assert.ok(value.toolName.length <= 64);
  assert.match(value.toolName, /^[a-zA-Z0-9_.:/-]+$/);
  assert.ok(!JSON.stringify(value).includes('secret'));
  assert.ok(!JSON.stringify(value).includes('<'));
  assert.deepEqual(Object.keys(value).sort(), ['icon', 'label', 'source', 'state', 'toolName', 'updatedAt']);
});

test('canonical extraction integrates public streaming, tool completion and real end', () => {
  const entries = [
    { type: 'turn/start', seq: 1, time: now - 40, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: now - 30, data: { turn: 1, name: 'web_search', callId: 't' } },
  ];
  const from = running => extractRuntimeSnapshot(entries, { sessionId: 's1', running });
  assert.equal(presence({ snapshot: from(true) }).state, 'researching');
  entries.push({ type: 'tool/result', seq: 3, time: now - 20, data: { turn: 1, message: { toolCallId: 't' } } });
  assert.equal(presence({ snapshot: from(true) }).state, 'thinking');
  entries.push({ type: 'assistant/live-chunk', seq: 4, time: now - 10, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'public text' } } });
  assert.equal(presence({ snapshot: from(true) }).state, 'writing');
  entries.push({ type: 'turn/end', seq: 5, time: now - 1, data: { turn: 1, reason: 'completed' } });
  assert.equal(presence({ snapshot: from(false) }).state, 'completed');
  assert.equal(derive({ now: now + 7000, snapshot: from(false) }).state, 'idle');
});
