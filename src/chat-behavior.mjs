/** Enter during IME candidate confirmation must never submit a message. */
export function isSubmitKey(event = {}) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229 && event.nativeEvent?.keyCode !== 229;
}

/** Clear only the exact draft admitted to the host, never later user edits. */
export function consumeSubmittedDraft(drafts, key, submitted) {
  return drafts[key] === submitted ? { ...drafts, [key]: '' } : drafts;
}

/** A small, testable scroll policy; DOM positioning remains in the component. */
export function planTranscriptScroll(previous, next, following, scrollHeight) {
  if (!previous || previous.key !== next.key) return { action: 'latest', unseen: false };
  if (next.searching) return { action: !previous.searching || previous.query !== next.query ? 'start' : 'none', unseen: false };
  if (previous.searching) return { action: 'latest', unseen: false };
  const prepended = previous.first && previous.first !== next.first && previous.last === next.last && next.count > previous.count;
  if (prepended) return { action: 'preserve', top: Math.max(0, previous.top + scrollHeight - previous.height), unseen: false };
  const changed = previous.last !== next.last || previous.lastText !== next.lastText || next.count > previous.count;
  return { action: following ? 'latest' : 'none', unseen: changed && !following };
}

export function taskDestination(task, workspace) {
  const subject = task.groupId ? workspace.groups.find(group => group.id === task.groupId) : workspace.bots.find(bot => bot.id === task.botId);
  if (subject) return { kind: task.groupId ? 'group' : 'bot', id: subject.id, name: subject.name, archived: !!subject.archived };
  const sessionId = task.sessionId || workspace.runs.slice().reverse().find(run => run.taskId === task.id && run.sessionId)?.sessionId;
  return sessionId ? { kind: 'native', sessionId, name: '原生会话' } : null;
}

/** Prioritize actual attention before decorative primary-Bot placement. */
export function teamStageModel(bots = [], presences = {}, primaryBotId) {
  const rows = bots.filter(bot => !bot.archived);
  const busy = new Set(['thinking', 'researching', 'coding', 'writing', 'working']);
  const counts = { working: 0, waiting: 0, queued: 0, error: 0, unavailable: 0, completed: 0, stopped: 0 };
  for (const bot of rows) {
    const p = presences[bot.id];
    if (!p || p.state === 'offline' || p.label === '待核实' || p.source === 'run') counts.unavailable++;
    else if (busy.has(p.state)) counts.working++;
    else if (p.state === 'waiting') counts.waiting++;
    else if (p.state === 'queued') counts.queued++;
    else if (p.state === 'error') counts.error++;
    else if (p.state === 'completed') counts.completed++;
    else if (p.state === 'stopped') counts.stopped++;
  }
  const rank = bot => {
    const p = presences[bot.id];
    if (p?.state === 'waiting' && p.source !== 'run') return 0;
    if (p?.state === 'error' && p.source !== 'run') return 1;
    if (busy.has(p?.state)) return 2;
    if (p?.state === 'queued') return 3;
    return 4;
  };
  const sorted = rows.slice().sort((a, b) => rank(a) - rank(b) || Number(b.id === primaryBotId) - Number(a.id === primaryBotId));
  const parts = [];
  if (counts.waiting) parts.push(`${counts.waiting} 位等你处理`);
  if (counts.working) parts.push(`${counts.working} 位工作中`);
  if (counts.queued) parts.push(`${counts.queued} 位排队中`);
  if (counts.error) parts.push(`${counts.error} 位需检查`);
  if (counts.unavailable) parts.push(`${counts.unavailable} 位状态待确认`);
  if (!parts.length && counts.completed) parts.push(`${counts.completed} 位刚完成`);
  if (!parts.length && counts.stopped) parts.push(`${counts.stopped} 位已停止`);
  return { bots: sorted, counts, summary: `${rows.length} 位同事 · ${parts.join(' · ') || '都在待命'}` };
}
