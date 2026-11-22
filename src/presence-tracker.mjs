import { deriveBotPresence } from './bot-presence.mjs';

/** Presentation-only observation: never creates, prompts, cancels or mutates a session. */
export function createPresenceTracker(runtime, { onChange, statusSource, catalogSource, maxWatched = 8, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let input = { bots: [], jobs: {}, runs: [], selectedBotId: null, activeBotIds: [], connected: true, enabled: false };
  let stopped = false, expiry = null, published = {}, signature = '';
  const watchers = new Map(), snapshots = new Map(), failures = new Map();
  const status = id => statusSource?.getSnapshot?.()?.get?.(id);
  const catalog = id => catalogSource?.getSnapshot?.()?.byId?.[id];
  const isActive = bot => { const pending = status(bot.sessionId); return !!(pending?.running || pending?.pendingInteraction || catalog(bot.sessionId)?.running); };
  function publish() {
    if (stopped) return;
    clearTimer(expiry); expiry = null;
    const timestamp = now(), next = {};
    let nextExpiry = Infinity;
    for (const bot of input.bots) {
      const job = input.jobs[bot.id];
      let snapshot = job?.snapshot || snapshots.get(bot.sessionId) || runtime.snapshot?.(bot.sessionId) || null;
      const pending = status(bot.sessionId);
      // The catalog can lag a fresh turn/end. Never overwrite a directly
      // observed terminal snapshot with that coarser historical running bit.
      const running = pending?.running === true || (!snapshot && catalog(bot.sessionId)?.running === true);
      if (pending?.pendingInteraction || running) snapshot = { ...(snapshot || {}), running: running || snapshot?.running === true, ...(pending?.pendingInteraction ? { needsAttention: true, approval: { kind: pending.pendingInteraction.kind || 'interaction' } } : {}) };
      const run = input.runs.findLast?.(r => r.botId === bot.id) ?? [...input.runs].reverse().find(r => r.botId === bot.id);
      const presence = deriveBotPresence({ snapshot, job, run, sessionId: bot.sessionId, connected: input.connected, now: timestamp });
      next[bot.id] = presence;
      if (presence.until > timestamp) nextExpiry = Math.min(nextExpiry, presence.until);
    }
    const nextSignature = JSON.stringify(next);
    if (nextSignature !== signature) { signature = nextSignature; published = next; onChange?.(next); }
    if (input.enabled && Number.isFinite(nextExpiry)) expiry = setTimer(publish, Math.min(Math.max(20, nextExpiry - timestamp + 5), 2147483647));
  }
  function release(token) {
    token.cancelled = true;
    token.off?.();
    if (watchers.get(token.id) === token) watchers.delete(token.id);
    snapshots.delete(token.id);
  }
  function reconcile() {
    if (stopped) return;
    const visible = input.bots.filter(b => !b.archived && b.sessionId);
    const priorities = new Set([input.selectedBotId, ...input.activeBotIds, ...Object.keys(input.jobs)]);
    const ordered = [...visible.filter(b => b.id === input.selectedBotId), ...visible.filter(b => priorities.has(b.id)), ...visible.filter(isActive), ...visible];
    const targets = input.enabled ? [...new Set(ordered.map(b => b.sessionId))].slice(0, Math.max(0, maxWatched)) : [];
    const wanted = new Set(targets);
    for (const token of [...watchers.values()]) if (!wanted.has(token.id)) release(token);
    for (const id of failures.keys()) if (!wanted.has(id)) { failures.delete(id); snapshots.delete(id); }
    for (const id of targets) {
      if (watchers.has(id) || (failures.get(id) || 0) > now()) continue;
      failures.delete(id);
      const token = { id, off: null, cancelled: false }; watchers.set(id, token);
      // An initial callback may happen before watch resolves; cancelled receipts
      // are still released when they arrive after navigation or disposal.
      Promise.resolve().then(() => {
        if (stopped || token.cancelled) return null;
        return runtime.watch(id, snapshot => {
          if (stopped || token.cancelled) return;
          snapshots.set(id, snapshot); publish();
        });
      }).then(off => { if (!off) return; token.off = off; if (stopped || token.cancelled) off(); }).catch(() => {
        if (stopped || token.cancelled) return;
        if (watchers.get(id) === token) watchers.delete(id);
        token.cancelled = true;
        failures.set(id, now() + 1500);
        snapshots.set(id, { openState: 'error', error: '会话状态暂不可读' });
        publish();
      });
    }
    publish();
  }
  const offStatus = statusSource?.subscribe?.(() => reconcile());
  const offCatalog = catalogSource?.subscribe?.(() => reconcile());
  return {
    update(patch) { if (stopped) return; input = { ...input, ...patch }; reconcile(); },
    getSnapshot: () => published,
    dispose() { if (stopped) return; stopped = true; clearTimer(expiry); offStatus?.(); offCatalog?.(); for (const token of [...watchers.values()]) release(token); snapshots.clear(); failures.clear(); }
  };
}
