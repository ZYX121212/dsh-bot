/** Presentation-only presence. Never infer activity from a Bot's role or saved prompt.
 * `snapshot` is the canonical createBotRuntime snapshot, not a persisted run.
 * Consumers own subscriptions and should rederive at `until` to expire a flash.
 * No input text, arguments, results, error details, or run titles are returned.
 */
export const BOT_PRESENCE_FLASH_MS = 6000;

/** Aggregate a team without turning an unavailable or failed team into 'idle'. */
export function deriveTeamPresence(values = []) {
  const rows = values.filter(Boolean);
  const first = state => rows.find(row => row.state === state);
  const active = first('waiting') || rows.find(row => ['thinking', 'researching', 'coding', 'writing', 'working'].includes(row.state)) || first('queued') || first('error');
  if (active) return active;
  if (rows.length && rows.every(row => row.state === 'offline')) return { state: 'offline', label: '状态不可用', source: 'connection' };
  if (first('completed')) return { ...first('completed'), label: '有成员刚完成' };
  if (first('stopped')) return { ...first('stopped'), label: '有成员已停止' };
  return { state: 'idle', label: first('offline') ? '部分状态不可用' : '待命' };
}

const labels = Object.freeze({ idle: '待命', queued: '排队中', thinking: '思考中', researching: '检索中', coding: '动手中', writing: '正在回复', working: '执行中', waiting: '等待处理', completed: '已完成', error: '遇到问题', stopped: '已停止', offline: '离线' });
const icons = Object.freeze({ idle: 'spark', queued: 'clock', thinking: 'bolt', researching: 'research', coding: 'code', writing: 'pen', working: 'bolt', waiting: 'clock', completed: 'check', error: 'alert', stopped: 'stop', offline: 'offline' });
const timestamp = value => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};
const reasonName = value => typeof value === 'string' ? value : value?.kind;
// Tool names are identifiers, not arbitrary display text. Bound them before any
// matching, strip controls/markup, and never fall back to args or result content.
const safeToolName = value => typeof value === 'string' ? value.slice(0, 96).replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 64) : '';
const toolState = name => {
  const value = name.toLowerCase();
  if (/(?:web|search|fetch|research|browse)/.test(value)) return 'researching';
  if (/(?:bash|terminal|edit|write|test|git|exec|shell|patch)/.test(value)) return 'coding';
  return 'working';
};

/**
 * @returns {{state: 'idle'|'queued'|'thinking'|'researching'|'coding'|'writing'|'working'|'waiting'|'completed'|'error'|'stopped'|'offline', label: string, icon: string, source?: string, toolName?: string, updatedAt?: number, until?: number}}
 */
export function deriveBotPresence({ snapshot = null, job = null, run = null, sessionId = null, connected = true, now = Date.now() } = {}) {
  now = Number.isFinite(now) ? now : Date.now();
  snapshot ??= job?.snapshot ?? null;
  // Never attribute a different session's activity to this Bot during navigation.
  if (sessionId && snapshot?.sessionId && snapshot.sessionId !== sessionId) snapshot = null;
  const result = (state, source, extra = {}) => ({ state, label: labels[state], icon: icons[state], ...(source ? { source } : {}), ...extra });
  const dated = time => { const updatedAt = timestamp(time); return updatedAt === undefined ? {} : { updatedAt }; };
  const flash = (state, source, time) => {
    const updatedAt = timestamp(time);
    // Missing/future timestamps cannot establish a recent real terminal event.
    if (updatedAt === undefined || updatedAt > now || now - updatedAt >= BOT_PRESENCE_FLASH_MS) return null;
    return result(state, source, { updatedAt, until: updatedAt + BOT_PRESENCE_FLASH_MS });
  };
  const hasSession = !!(sessionId || snapshot?.sessionId || job?.sessionId || run?.sessionId);
  if (snapshot?.removed) return result('offline', 'snapshot');
  if (!connected && hasSession) return result('offline', 'connection');
  if (snapshot?.openError || ['error', 'failed'].includes(snapshot?.openState)) return result('error', 'snapshot');
  if (snapshot?.needsAttention || snapshot?.approval) return result('waiting', 'snapshot');

  const end = snapshot?.lastTurnEnd;
  const reason = reasonName(end?.reason);
  if (snapshot?.running === true) {
    const current = row => {
      if (Number.isFinite(snapshot.latestTurn) && Number.isFinite(row?.turn) && row.turn !== snapshot.latestTurn) return false;
      // Old public partials can remain in an event window after turn/end.
      if (Number.isFinite(end?.seq) && Number.isFinite(row?.seq) && row.seq <= end.seq) return false;
      if (Number.isFinite(end?.turn) && Number.isFinite(row?.turn) && row.turn <= end.turn) return false;
      return true;
    };
    const activities = (Array.isArray(snapshot.activities) ? snapshot.activities : []).filter(row => row?.status === 'running' && current(row));
    const activity = activities.reduce((latest, row) => !latest || (row.seq ?? 0) >= (latest.seq ?? 0) ? row : latest, null);
    if (activity) {
      const toolName = safeToolName(activity.toolName);
      return result(toolState(toolName), 'snapshot', { ...(toolName ? { toolName } : {}), ...dated(activity.time) });
    }
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const partial = messages.filter(row => row?.role === 'assistant' && row.partial === true && typeof row.text === 'string' && row.text.trim() && current(row)).at(-1);
    if (partial) return result('writing', 'snapshot', dated(partial.time));
    return result('thinking', 'snapshot');
  }
  // A controller reservation is real queue admission, unlike a persisted run.
  if (job?.status === 'queued') return result('queued', 'job');
  if (snapshot) {
    if (reason === 'blocked') return result('waiting', 'snapshot', dated(end.time));
    if (reason === 'error' || snapshot.error) return result('error', 'snapshot', dated(end?.time));
    if (reason === 'aborted' || reason === 'cancelled' || reason === 'stopped') return flash('stopped', 'snapshot', end?.time) ?? result('idle', 'snapshot');
    if (reason === 'completed') return flash('completed', 'snapshot', end?.time) ?? result('idle', 'snapshot');
    return result('idle', 'snapshot');
  }
  // Local/persisted bookkeeping without a native snapshot is NOT evidence that
  // a model/tool is running. Make its provenance explicit for honest UI labels.
  const record = job ?? run;
  const source = job ? 'job' : run ? 'run' : undefined;
  if (record?.status === 'waiting' || record?.status === 'blocked') return result('waiting', source, { label: '待处理（记录）' });
  if (record?.status === 'running' || record?.status === 'queued') return result('idle', source, { label: '待核实' });
  if (record?.status === 'failed' || record?.status === 'error') return result('error', source, { label: '遇到问题（记录）' });
  // Only explicit end timestamps count; record.updatedAt may merely be a rename.
  const endedAt = record?.completedAt ?? record?.endedAt ?? record?.finishedAt;
  if (record?.status === 'completed') return flash('completed', source, endedAt) ?? result('idle', source);
  if (['aborted', 'cancelled', 'stopped'].includes(record?.status)) return flash('stopped', source, endedAt) ?? result('idle', source);
  return result('idle', source);
}
