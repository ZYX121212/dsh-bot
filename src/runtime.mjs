/**
 * Authenticated DSH client-session bridge. No provider requests, owner peers,
 * credentials, hidden approval decisions, autonomous multi-Bot orchestration,
 * or cloud/sandbox assumptions. Keep one instance for the plugin lifetime.
 */

import { TEAM_CONTEXT_LIMIT } from './team-core.mjs';

const asText = value => typeof value === 'string' ? value : '';
const finite = value => Number.isFinite(value) ? value : undefined;
const textBlocks = blocks => Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => asText(block.text)).join('') : '';
const errorText = error => typeof error === 'string' ? error : asText(error?.message);
const assistantId = (data, seq) => Number.isFinite(data.turn) && Number.isFinite(data.step) ? `assistant:${data.turn}:${data.step}` : `assistant:${seq}`;

const DISPATCH_ID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
/** Correlate only our exact bounded public prompt envelope, never body substrings. */
export function dispatchIdFromPrompt(value) {
  if (typeof value !== 'string' || !value.startsWith('[[DSH_BOT_CONTEXT_V2]]\n')) return null;
  const start = '[[DSH_BOT_CONTEXT_V2]]\n'.length, end = value.indexOf('\n[[/DSH_BOT_CONTEXT_V2]]\n\n', start);
  if (end < start || end - start > TEAM_CONTEXT_LIMIT) return null;
  try {
    const context = JSON.parse(value.slice(start, end));
    return context && !Array.isArray(context) && context.product === 'dsh-bot' && Object.hasOwn(context, 'dispatchId') && typeof context.dispatchId === 'string' && DISPATCH_ID.test(context.dispatchId) ? context.dispatchId : null;
  } catch { return null; }
}
const nativeTurn = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Return only an unambiguous current native main-view CWD, not a guessed recent directory. */
export function currentWorkspaceCwd(ctx) {
  const rows = Object.values(ctx.sessions?.list?.getSnapshot?.()?.byId ?? {});
  const current = rows.filter(row => row?.retainedBy?.mainView > 0 && typeof row.cwd === 'string' && row.cwd.trim());
  const paths = [...new Set(current.map(row => row.cwd))];
  return paths.length === 1 ? paths[0] : undefined;
}

/**
 * Derive presentation-only text from the current authoritative event window.
 * Tool arguments, results, reasoning, hidden context, and provider metadata are
 * intentionally omitted. Render all strings as text; never inject as HTML.
 * Native eventSource settles transient rows atomically; turn/step matching also
 * prevents a racing durable frame from being shown beside its partial frame.
 */
export function extractRuntimeSnapshot(entries = [], sessionState = {}, pendingStatus) {
  const messages = new Map(), activities = new Map(), files = new Map(), live = new Map(), settled = new Map(), turnEnds = [];
  let latestTurn, currentTurn, lastSeq = 0, firstSeq = null, lastTurnEnd = null;
  const events = (Array.isArray(entries) ? entries : []).map(row => row?.event ?? row).filter(event => event && typeof event.type === 'string');
  // First remove historical surface nodes shadowed by native replacement events.
  const shadowed = new Set();
  for (const event of events) {
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const { startSeq, endSeq } = event.surfaceOp;
      if (Number.isFinite(startSeq) && Number.isFinite(endSeq)) for (const previous of events) {
        if (previous.seq >= startSeq && previous.seq <= endSeq && previous.seq !== event.seq && ['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(previous.type)) shadowed.add(previous.seq);
      }
    }
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index], data = event.data ?? {}, seq = finite(event.seq) ?? index + 1, time = finite(event.time);
    lastSeq = Math.max(lastSeq, seq);
    if (Number.isFinite(event.seq)) firstSeq = firstSeq === null ? event.seq : Math.min(firstSeq, event.seq);
    if (event.type === 'turn/start') { currentTurn = finite(data.turn); latestTurn = currentTurn ?? latestTurn; }
    if (Number.isFinite(data.turn)) latestTurn = Math.max(latestTurn ?? 0, data.turn);
    if (shadowed.has(seq)) continue;
    if (event.type === 'user/message') {
      // Injected AGENTS.md, runtime snapshots, recalls and other synthetic user
      // contexts are not ordinary user chat and can contain sensitive internals.
      if (data.source?.kind && data.source.kind !== 'user') continue;
      const text = textBlocks(data.content);
      if (text) messages.set(asText(data.id) || `user:${seq}`, { id: asText(data.id) || `user:${seq}`, role: 'user', text, turn: nativeTurn(data.turn) ?? currentTurn, dispatchId: dispatchIdFromPrompt(text), seq, time, partial: false });
    } else if (event.type === 'assistant/message') {
      const id = assistantId(data, seq), text = textBlocks(data.message?.content);
      settled.set(id, { seq, kind: 'message' });
      if (text) messages.set(id, { id, role: 'assistant', text, turn: finite(data.turn), seq, time, partial: false });
    } else if (event.type === 'assistant/attempt') {
      // Failed/retried attempt chunks are not a completed public message.
      settled.set(assistantId(data, seq), { seq, kind: 'attempt' });
    } else if (event.type === 'assistant/live-chunk') {
      if (data.chunk?.type !== 'text-delta') continue;
      const id = assistantId(data, seq), key = asText(data.attemptId) || id;
      const previous = live.get(key);
      live.set(key, { id, role: 'assistant', text: (previous?.text ?? '') + asText(data.chunk.text), turn: finite(data.turn), seq: previous?.seq ?? seq, time: previous?.time ?? time, partial: true });
    } else if (event.type === 'tool/call') {
      const id = asText(data.callId) || `tool:${seq}`;
      activities.set(id, { id, toolName: asText(data.name) || 'tool', status: 'running', turn: finite(data.turn), seq, time });
    } else if (event.type === 'tool/result') {
      const id = asText(data.message?.toolCallId) || asText(data.message?.source?.callId);
      if (!id) continue;
      const previous = activities.get(id);
      activities.set(id, { id, toolName: previous?.toolName ?? 'tool', status: data.message?.isError ? 'error' : 'done', turn: finite(data.turn), seq: previous?.seq ?? seq, time: previous?.time ?? time });
    } else if (event.type === 'deliverables/presented') {
      for (const file of Array.isArray(data.files) ? data.files : []) {
        if (typeof file?.path !== 'string' || !file.path.trim()) continue;
        files.set(file.path, { path: file.path, description: asText(file.description), turn: finite(data.turn), seq, time });
      }
    } else if (event.type === 'turn/end') {
      const reason = typeof data.reason === 'string' ? data.reason : asText(data.reason?.kind);
      lastTurnEnd = { turn: finite(data.turn), reason, seq, time };
      turnEnds.push(lastTurnEnd);
      for (const [id, activity] of activities) if (activity.status === 'running' && (activity.turn === data.turn || activity.turn === undefined)) activities.set(id, { ...activity, status: 'interrupted' });
    }
  }
  // Multiple live attempts in one step can coexist during retry; show only the
  // newest public prefix, never concatenate retried prefixes into fake output.
  const newestLive = new Map();
  for (const row of live.values()) {
    const settlement = settled.get(row.id);
    if (!settlement || (settlement.kind === 'attempt' && row.seq > settlement.seq)) newestLive.set(row.id, row);
  }
  for (const [id, row] of newestLive) if (row.text) messages.set(id, row);
  const pending = pendingStatus?.pendingInteraction;
  const approval = pending ? { kind: asText(pending.kind) || 'interaction', toolName: asText(pending.toolName), reason: asText(pending.reason) } : null;
  const endError = lastTurnEnd?.reason === 'error' ? 'DSH agent ended with an error. Open the native session for details.' : '';
  const error = errorText(sessionState.openError) || errorText(sessionState.lastAgentError) || errorText(sessionState.promptError?.error) || endError || null;
  return {
    sessionId: asText(sessionState.sessionId),
    messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
    activities: [...activities.values()].sort((a, b) => a.seq - b.seq), files: [...files.values()],
    lastSeq, firstSeq, latestTurn, lastTurnEnd, turnEnds,
    running: sessionState.running === true || sessionState.awaitingFirstTurn === true || pendingStatus?.running === true,
    error, approval, needsAttention: !!pending || lastTurnEnd?.reason === 'blocked',
    approvalStatusAvailable: pendingStatus !== undefined,
    hasMore: sessionState.hasMore === true, loadingOlder: sessionState.loadingOlder === true,
    openState: asText(sessionState.openState), removed: sessionState.removed === true
  };
}

/**
 * API:
 * acquire({id,sessionId?,agentPreset?:'standard',cwd?},{onSession?}) => handle
 *   onSession(sessionId) is awaited BEFORE handle/send is made available.
 * handle: {sessionId,send(text,{mode?}),cancel(),open(),loadOlder(),snapshot(),release()}
 * watch(sessionId,callback) => Promise<unsubscribe> (initial snapshot delivered)
 * send(target,text,{onSession?,mode?}) / run(...) => admission {sessionId,accepted:true}
 * cancel(sessionId|target), open(sessionId), snapshot(sessionId), dispose()/releaseAll()
 * watch and acquire retain independently; task retention survives UI unmount.
 * dispose releases Client references; it does NOT cancel Host work or change its
 * approvals. Host/app shutdown is not cloud execution and can stop work.
 */
export function createBotRuntime(ctx) {
  const byTarget = new Map(), creations = new Map(), acquisitions = new Map(), entries = new Map();
  let disposed = false;
  const statusSource = ctx.uiSession?.sessionStatus;
  const ensureAlive = () => { if (disposed) throw new Error('dsh-bot runtime is disposed.'); };
  const pendingFor = id => statusSource?.getSnapshot?.()?.get?.(id);
  function disposeEntry(entry) {
    if (entry.closed) return;
    entry.closed = true;
    for (const off of entry.off.splice(0)) off();
    entry.reference.release();
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  }
  function maybeRelease(entry) {
    if (entry.closed || !entry.ready || entry.leases || entry.listeners.size || entry.operations) return;
    if (entry.tasks.some(task => !task.finished) || entry.snapshot?.running || entry.snapshot?.approval) return;
    disposeEntry(entry);
  }
  function publish(entry) {
    if (disposed || entry.closed || !entry.binding) return;
    const window = entry.binding.eventSource.getSnapshot();
    const state = entry.binding.session.getSnapshot();
    const snapshot = extractRuntimeSnapshot(window.entries, state, pendingFor(entry.sessionId));
    snapshot.sessionId = entry.sessionId;
    snapshot.approvalStatusAvailable = !!statusSource;
    entry.snapshot = snapshot;
    // Queue admission does not identify a turn. Match our public user frame
    // first; unrelated queued work must not release this task's retention.
    const claimed = entry.claimedUserSeqs;
    for (const task of entry.tasks) {
      if (task.finished) continue;
      if (task.turn === undefined) {
        const user = snapshot.messages.find(message => message.role === 'user' && message.seq > task.baseline && nativeTurn(message.turn) !== undefined && !claimed.has(message.seq) && (task.dispatchId ? message.dispatchId === task.dispatchId : message.text === task.prompt));
        if (user) { task.turn = user.turn; task.userSeq = user.seq; claimed.add(user.seq); }
      }
      if (task.turn !== undefined && snapshot.turnEnds.some(end => end.turn === task.turn && end.seq > task.baseline)) task.finished = true;
    }
    if (state.removed) for (const task of entry.tasks) task.finished = true;
    entry.tasks = entry.tasks.filter(task => !task.finished || task.admitting);
    if (!entry.tasks.length) entry.claimedUserSeqs.clear();
    for (const callback of [...entry.listeners]) { try { callback(snapshot); } catch { /* One UI cannot break other subscribers or Host tracking. */ } }
    maybeRelease(entry);
  }
  function entryFor(sessionId) {
    ensureAlive();
    let entry = entries.get(sessionId);
    if (entry) return entry;
    const reference = ctx.sessions.retain(sessionId, { source: 'dshBotRuntime' });
    entry = { sessionId, reference, ready: false, closed: false, binding: null, leases: 0, operations: 0, listeners: new Set(), off: [], snapshot: null, tasks: [], claimedUserSeqs: new Set(), handledEndSeq: 0 };
    entries.set(sessionId, entry);
    entry.readiness = Promise.resolve(reference.ready).then(binding => {
      if (disposed || entry.closed) throw new Error('dsh-bot runtime is disposed.');
      entry.binding = binding;
      const initial = extractRuntimeSnapshot(binding.eventSource.getSnapshot().entries, binding.session.getSnapshot(), pendingFor(sessionId));
      entry.handledEndSeq = initial.lastTurnEnd?.seq ?? 0;
      entry.off.push(binding.eventSource.subscribe(() => publish(entry)));
      entry.off.push(binding.session.subscribe(() => publish(entry)));
      entry.ready = true;
      publish(entry);
      return entry;
    }).catch(error => { disposeEntry(entry); throw error; });
    // All acquisitions await this promise; avoid an unhandled rejection if a
    // plugin disposes before a caller attaches its own continuation.
    entry.readiness.catch(() => {});
    return entry;
  }
  async function retainEntry(sessionId) {
    const entry = entryFor(sessionId);
    entry.leases++;
    try { await entry.readiness; ensureAlive(); return entry; }
    catch (error) { entry.leases--; maybeRelease(entry); throw error; }
  }
  async function resolveTarget(target) {
    ensureAlive();
    if (!target || typeof target.id !== 'string' || !target.id.trim()) throw new Error('A stable Bot/group target id is required.');
    const id = target.id;
    if (target.sessionId && typeof target.sessionId !== 'string') throw new Error('sessionId must be a string.');
    if (target.sessionId) {
      const existing = byTarget.get(id);
      if (existing && existing !== target.sessionId) throw new Error('This Bot already has a different session. Use a new target id to reset it explicitly.');
      byTarget.set(id, target.sessionId);
      return target.sessionId;
    }
    if (byTarget.has(id)) return byTarget.get(id);
    if (!creations.has(id)) {
      const task = (async () => {
        const options = { agentPreset: target.agentPreset || 'standard' };
        const cwd = typeof target.cwd === 'string' && target.cwd.trim() ? target.cwd : currentWorkspaceCwd(ctx);
        if (cwd) options.cwd = cwd;
        const sessionId = await ctx.sessions.create(options);
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH did not return a session identity.');
        byTarget.set(id, sessionId);
        return sessionId;
      })();
      creations.set(id, task);
      task.finally(() => { if (creations.get(id) === task) creations.delete(id); }).catch(() => {});
    }
    return creations.get(id);
  }
  async function cancelDispatch(entry, dispatchId, options = {}) {
    if (typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)) throw new Error('A valid dispatch identity is required.');
    const unverified = () => { const error = new Error('尚未核实本条消息的原生队列或当前回合，未停止其他工作。请打开原生会话检查后重试。'); error.code = 'dispatch-unverified'; return error; };
    const owned = () => {
      publish(entry);
      const task = entry.tasks.find(task => task.dispatchId === dispatchId), user = entry.snapshot.messages.find(message => message.role === 'user' && message.dispatchId === dispatchId && nativeTurn(message.turn) !== undefined);
      const turn = nativeTurn(options.turn) ?? task?.turn ?? user?.turn;
      if (turn === undefined) return null;
      if (entry.snapshot.turnEnds.some(end => end.turn === turn)) return { scope: 'finished', turn };
      return entry.snapshot.running && entry.snapshot.latestTurn === turn ? { scope: 'turn', turn } : null;
    };
    const stopOwned = async state => {
      if (state.scope === 'turn') { const result = await entry.binding.session.cancel(); if (!result?.ok) throw new Error(errorText(result?.error) || 'DSH could not cancel this turn.'); }
      return { sessionId: entry.sessionId, accepted: true, ...state };
    };
    let state = owned(); if (state) return stopOwned(state);
    await ctx.sessions.refreshProjections?.(entry.sessionId);
    state = owned(); if (state) return stopOwned(state);
    const inbox = ctx.sessions.list?.getSnapshot?.()?.projectionsBySession?.[entry.sessionId]?.values?.inbox;
    const matches = ['next-turn', 'next-step'].flatMap(key => Array.isArray(inbox?.[key]) ? inbox[key] : []).filter(message => message && typeof message.id === 'string' && message.id && message.source?.kind === 'user' && dispatchIdFromPrompt(textBlocks(message.content)) === dispatchId);
    if (matches.length !== 1 || typeof entry.binding.session.updateQueue !== 'function') throw unverified();
    // Public Host contract locates this exact pending occurrence or fails; its
    // synchronous remove path cannot return success for an already-started item.
    const result = await entry.binding.session.updateQueue(matches[0].id, { kind: 'remove' });
    if (!result?.ok) {
      await ctx.sessions.refreshProjections?.(entry.sessionId);
      state = owned(); if (state) return stopOwned(state);
      const error = unverified(); if (result?.error?.message) error.message = result.error.message; throw error;
    }
    for (const task of entry.tasks) if (task.dispatchId === dispatchId) task.finished = true;
    publish(entry);
    return { sessionId: entry.sessionId, accepted: true, scope: 'queue', dispatchId, itemId: matches[0].id };
  }
  function makeHandle(entry) {
    let released = false;
    const requireHandle = () => { ensureAlive(); if (released || entry.closed) throw new Error('Session handle has been released.'); };
    return {
      sessionId: entry.sessionId,
      snapshot() { requireHandle(); return entry.snapshot; },
      async send(prompt, options = {}) {
        requireHandle();
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Message cannot be empty.');
        const mode = options.mode ?? 'queue';
        if (!['queue', 'steer'].includes(mode)) throw new Error('Unsupported send mode.');
        entry.operations++;
        const task = { baseline: entry.snapshot?.lastSeq ?? 0, dispatchId: dispatchIdFromPrompt(prompt), prompt, turn: undefined, userSeq: undefined, finished: false, admitting: true };
        entry.tasks.push(task);
        try {
          const receipt = await entry.binding.session.prompt([{ type: 'text', text: prompt }], mode, undefined, task.dispatchId ?? undefined);
          if (!receipt?.ok) throw new Error(errorText(receipt?.error) || 'DSH rejected the message.');
          return { sessionId: entry.sessionId, accepted: true };
        } catch (error) { task.finished = true; throw error; }
        finally { task.admitting = false; entry.operations--; publish(entry); maybeRelease(entry); }
      },
      async cancel() {
        requireHandle();
        const receipt = await entry.binding.session.cancel();
        if (!receipt?.ok) throw new Error(errorText(receipt?.error) || 'DSH could not cancel this turn.');
        return { sessionId: entry.sessionId, accepted: true };
      },
      async cancelDispatch(dispatchId, options = {}) { requireHandle(); return cancelDispatch(entry, dispatchId, options); },
      open() { requireHandle(); return open(entry.sessionId); },
      async loadOlder() { requireHandle(); await entry.binding.session.loadOlder(); },
      release() { if (released) return; released = true; entry.leases--; maybeRelease(entry); }
    };
  }
  async function acquire(target, options = {}) {
    const key = target?.id;
    // Serialize association/persistence per target, not the lifetime of handles.
    // A failed callback must not poison the next retry or cause another create.
    const previous = acquisitions.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const sessionId = await resolveTarget(target);
      // Persist even if disposal raced the create receipt: never lose the newly
      // created Host association merely because its panel/plugin went away.
      if (options.onSession) await options.onSession(sessionId);
      ensureAlive();
      return makeHandle(await retainEntry(sessionId));
    });
    acquisitions.set(key, operation);
    operation.finally(() => { if (acquisitions.get(key) === operation) acquisitions.delete(key); }).catch(() => {});
    return operation;
  }
  async function watch(sessionId, callback) {
    if (typeof callback !== 'function') throw new Error('watch requires a callback.');
    const entry = await retainEntry(sessionId);
    let released = false;
    entry.listeners.add(callback);
    try { callback(entry.snapshot); } catch { /* Keep subscription usable after consumer errors. */ }
    return () => {
      if (released) return;
      released = true;
      entry.listeners.delete(callback);
      entry.leases--;
      maybeRelease(entry);
    };
  }
  function open(sessionId) {
    ensureAlive();
    if (!ctx.uiWorkspace?.openSession) throw new Error('Native DSH session navigation is unavailable.');
    ctx.uiWorkspace.openSession(sessionId);
  }
  const offStatus = statusSource?.subscribe?.(() => { for (const entry of [...entries.values()]) publish(entry); });
  async function send(target, prompt, options = {}) {
    const handle = await acquire(target, options);
    try { return await handle.send(prompt, options); }
    finally { handle.release(); }
  }
  async function cancel(target) {
    const sessionId = typeof target === 'string' ? target : target?.sessionId || byTarget.get(target?.id);
    if (!sessionId) return { accepted: false };
    const entry = await retainEntry(sessionId), handle = makeHandle(entry);
    try { return await handle.cancel(); } finally { handle.release(); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    offStatus?.();
    for (const entry of [...entries.values()]) disposeEntry(entry);
    // Do not cancel Host tasks: browser/plugin lifetime is not task ownership.
    byTarget.clear();
  }
  return { acquire, watch, send, run: send, cancel, open, snapshot: sessionId => entries.get(sessionId)?.snapshot ?? null, currentCwd: () => currentWorkspaceCwd(ctx), dispose, releaseAll: dispose };
}
