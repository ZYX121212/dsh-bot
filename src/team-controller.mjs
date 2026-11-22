import { createBotRuntime, currentWorkspaceCwd } from './runtime.mjs';
import { emptyTeamWorkspace, buildTeammatePrompt, routeGroupMessage, summarizeRun } from './team-core.mjs';

export function createTeamController(ctx, options = {}) {
  const runtime = options.runtime ?? createBotRuntime(ctx);
  const listeners = new Set();
  let state = { workspace: emptyTeamWorkspace(), loaded: false, loading: false, error: '', selected: null, conversation: null, pending: false, jobs: {}, connection: 'loading' };
  let mutationQueue = Promise.resolve(), refreshOperation = null, unwatch = null, navigation = 0, disposed = false, poll = null;
  const jobs = new Map(), reservations = new Map(), workflows = new Map(), recovered = new Map();
  const emit = patch => { if (disposed) return; state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const report = error => { emit({ error: error?.message || String(error) }); };
  function adopt(workspace) {
    if (!workspace || !Array.isArray(workspace.bots) || !Array.isArray(workspace.groups)) throw new Error('Bot 工作区返回了无法识别的数据，请更新插件后重试。');
    if (workspace.revision < state.workspace.revision) return state.workspace;
    emit({ workspace, loaded: true, connection: 'ready' });
    queueMicrotask(() => recoverPendingRuns());
    if (!state.selected) {
      let saved; try { saved = JSON.parse(localStorage.getItem('dsh-bot:v2:selection') || 'null'); } catch {}
      const valid = saved && (saved.kind === 'bot' ? workspace.bots.some(b => b.id === saved.id && !b.archived) : workspace.groups.some(g => g.id === saved.id && !g.archived));
      const first = workspace.bots.find(b => b.id === workspace.primaryBotId && !b.archived) ?? workspace.bots.find(b => !b.archived);
      if (valid) select(saved.kind, saved.id); else if (first) select('bot', first.id);
    }
    return workspace;
  }
  async function rpc(method, payload) {
    const result = await ctx.connection.rpc.call('/api', `botWorkspace/${method}`, payload);
    if (!result?.ok) throw new Error(result?.error?.message ?? '无法连接 Bot 工作区。请确认插件已安装并重启 DSH。');
    return result.value;
  }
  function mutate(request) {
    const result = mutationQueue.catch(() => {}).then(async () => adopt(await rpc('update', { request })));
    mutationQueue = result;
    return result;
  }
  function refresh() {
    if (refreshOperation) return refreshOperation;
    emit({ loading: !state.loaded });
    refreshOperation = rpc('read', {}).then(adopt).catch(error => { emit({ connection: 'error' }); report(error); throw error; }).finally(() => { emit({ loading: false }); refreshOperation = null; });
    return refreshOperation;
  }
  function recoverPendingRuns() {
    if (disposed) return;
    const active = new Set(['queued', 'running', 'waiting']);
    for (const run of state.workspace.runs) {
      if (!active.has(run.status) || !run.sessionId || recovered.has(run.id) || workflows.has(run.taskId)) continue;
      const tracker = { off: null, settled: false, lastStatus: null };
      recovered.set(run.id, tracker);
      runtime.watch(run.sessionId, snapshot => {
        if (disposed || tracker.settled) return;
        const terminal = Number.isSafeInteger(run.afterSeq) && snapshot.lastTurnEnd?.seq > run.afterSeq;
        if (!terminal) {
          const status = snapshot.needsAttention || !snapshot.running ? 'waiting' : 'running';
          if (tracker.lastStatus !== status) {
            tracker.lastStatus = status;
            mutate({ action: 'upsertRun', run: { id: run.id, status, ...(!snapshot.running && !snapshot.needsAttention ? { summary: '已重新连接原生会话，尚未观察到本次任务的完成边界；没有自动重发。' } : {}) } }).catch(report);
          }
          return;
        }
        tracker.settled = true;
        const reason = typeof snapshot.lastTurnEnd.reason === 'object' ? snapshot.lastTurnEnd.reason.kind : snapshot.lastTurnEnd.reason;
        const status = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed';
        const summary = summarizeRun(snapshot, run.afterSeq) || snapshot.error || `结束原因：${reason}`;
        (async () => {
          await mutate({ action: 'upsertRun', run: { id: run.id, status, summary } });
          if (run.groupId && run.botId && summary && !state.workspace.groups.find(g => g.id === run.groupId)?.messages.some(m => m.runId === run.id && m.role === 'assistant')) {
            await mutate({ action: 'appendGroupMessage', groupId: run.groupId, message: { id: run.id, role: 'assistant', botId: run.botId, text: summary, sessionId: run.sessionId, runId: run.id } }).catch(report);
          }
          if (run.taskId && state.workspace.tasks.some(t => t.id === run.taskId)) await mutate({ action: 'updateTask', id: run.taskId, patch: { status: run.groupId && status === 'completed' ? 'waiting' : status, summary: run.groupId && status === 'completed' ? '已恢复当前成员的结果。为避免重复操作，未自动重放后续成员；请继续交办。' : summary } });
        })().catch(report).finally(() => { tracker.off?.(); });
      }).then(off => { tracker.off = off; if (tracker.settled || disposed) off(); }).catch(error => { recovered.delete(run.id); report(error); });
    }
  }
  async function select(kind, id) {
    const revision = ++navigation;
    unwatch?.(); unwatch = null;
    emit({ selected: { kind, id }, conversation: null, pending: false, error: '' });
    try { localStorage.setItem('dsh-bot:v2:selection', JSON.stringify({ kind, id })); } catch {}
    const sessionId = kind === 'bot' ? state.workspace.bots.find(b => b.id === id)?.sessionId
      : kind === 'group' ? ([...jobs.values()].find(j => j.groupId === id && j.sessionId)?.sessionId || state.workspace.runs.slice().reverse().find(r => r.groupId === id && r.sessionId)?.sessionId) : null;
    if (!sessionId) return;
    try {
      const off = await runtime.watch(sessionId, snapshot => { if (navigation === revision) emit({ conversation: snapshot }); });
      if (navigation !== revision || disposed) off(); else unwatch = off;
    } catch (error) { if (navigation === revision) report(error); }
  }
  function publishJobs() {
    const rows = [...reservations].map(([id, task]) => [id, { status: 'queued', sessionId: null, taskId: task.taskId, groupId: task.groupId }]);
    for (const [id, job] of jobs) rows.push([id, { status: job.status, sessionId: job.sessionId, taskId: job.taskId, groupId: job.groupId }]);
    emit({ jobs: Object.fromEntries(rows) });
  }
  async function newRecord(action, field, request) {
    const workspace = await mutate({ action, ...request });
    // The host appends the created row in the same locked mutation snapshot.
    const record = workspace[field].at(-1);
    if (!record) throw new Error('未找到刚创建的记录，请刷新后重试。');
    return record;
  }
  async function executeBot(botId, text, { taskId, groupId = null } = {}) {
    if (jobs.has(botId)) throw new Error('这个 Bot 已经在工作，请等待完成或先停止。');
    const job = { status: 'queued', sessionId: null, taskId, groupId, handle: null, cancelled: false };
    jobs.set(botId, job); publishJobs();
    const runId = crypto.randomUUID();
    let off = null, timer = null, rejectWait = null;
    try {
      const bot = state.workspace.bots.find(b => b.id === botId);
      if (!bot || bot.archived) throw new Error('这个 Bot 已被移除或归档。');
      const handle = await runtime.acquire({ id: bot.id, sessionId: bot.sessionId || undefined, agentPreset: 'standard', cwd: currentWorkspaceCwd(ctx) }, { onSession: async sessionId => {
        await mutate({ action: 'setSession', botId: bot.id, sessionId });
      } });
      job.handle = handle; job.sessionId = handle.sessionId;
      if (job.cancelled) throw new Error('任务已停止。');
      const baseline = runtime.snapshot(handle.sessionId);
      if (baseline?.running || baseline?.needsAttention || baseline?.approval) throw new Error('这个 Bot 的原生会话仍在工作或等待处理。请打开 DSH 会话查看进度并处理交互，再继续。');
      const afterSeq = baseline?.lastSeq ?? 0;
      await mutate({ action: 'upsertRun', run: { id: runId, taskId: taskId || null, botId, groupId, sessionId: handle.sessionId, afterSeq, status: 'running', title: text.slice(0, 200) } });
      if (taskId) await mutate({ action: 'updateTask', id: taskId, patch: { status: 'running', sessionId: handle.sessionId } });
      const complete = new Promise((resolve, reject) => { rejectWait = reject; job.reject = reject; job.resolve = resolve; });
      complete.catch(() => {});
      off = await runtime.watch(handle.sessionId, snapshot => {
        job.snapshot = snapshot;
        if (state.selected?.kind === 'group' && state.selected.id === groupId) emit({ conversation: snapshot });
        const waiting = snapshot.needsAttention;
        const status = waiting ? 'waiting' : 'running';
        if (job.status !== status) {
          job.status = status; publishJobs();
          mutate({ action: 'upsertRun', run: { id: runId, status } }).catch(report);
          if (taskId) mutate({ action: 'updateTask', id: taskId, patch: { status } }).catch(report);
        }
        if (snapshot.lastTurnEnd?.seq > afterSeq) job.resolve(snapshot);
        else if (snapshot.error && !snapshot.running && snapshot.lastSeq > afterSeq) job.reject(new Error(snapshot.error));
      });
      if (job.cancelled) throw new Error('任务已停止。');
      const group = groupId ? state.workspace.groups.find(g => g.id === groupId) : null;
      const prompt = buildTeammatePrompt(bot, text, state.workspace, group);
      job.status = 'running'; publishJobs();
      if (state.selected?.kind === 'bot' && state.selected.id === botId) await select('bot', botId);
      else if (groupId && state.selected?.kind === 'group' && state.selected.id === groupId) await select('group', groupId);
      await handle.send(prompt);
      if (job.cancelled && !disposed) await handle.cancel();
      timer = setTimeout(() => { const error = new Error('已跟踪 60 分钟，请打开原生会话查看最终状态；任务没有被自动取消。'); error.code = 'tracking-detached'; rejectWait?.(error); }, 3600000);
      const snapshot = await complete;
      const reason = snapshot.lastTurnEnd?.reason;
      const reasonName = typeof reason === 'object' ? reason?.kind : reason;
      const status = job.cancelled || reasonName === 'aborted' ? 'cancelled' : reasonName === 'completed' ? 'completed' : 'failed';
      const textResult = summarizeRun(snapshot, afterSeq);
      await mutate({ action: 'upsertRun', run: { id: runId, status, summary: textResult || snapshot.error || (status === 'cancelled' ? '任务已停止。' : `结束原因：${reasonName || '未返回文字'}`) } });
      if (groupId && textResult) await mutate({ action: 'appendGroupMessage', groupId, message: { id: crypto.randomUUID(), role: 'assistant', botId, text: textResult, sessionId: handle.sessionId, runId } });
      if (status === 'failed') throw new Error(snapshot.error || `任务未正常完成：${reasonName || '未知原因'}`);
      return { status, text: textResult, sessionId: handle.sessionId };
    } catch (error) {
      if (!disposed) await mutate({ action: 'upsertRun', run: { id: runId, taskId: taskId || null, botId, groupId, sessionId: job.sessionId, status: error.code === 'tracking-detached' ? 'waiting' : job.cancelled ? 'cancelled' : 'failed', title: text.slice(0, 200), summary: error.message } }).catch(report);
      throw error;
    } finally { clearTimeout(timer); off?.(); job.handle?.release(); jobs.delete(botId); publishJobs(); }
  }
  async function send(text, explicitIds = []) {
    if (state.pending) throw new Error('上一条工作正在提交，请稍等。');
    const selected = state.selected;
    if (!selected) throw new Error('先创建或选择一个 Bot。');
    const value = String(text).trim();
    if (!value) return;
    if (value.length > 24000) throw new Error('消息请控制在 24000 字以内。');
    let participants, group;
    if (selected.kind === 'group') {
      group = state.workspace.groups.find(g => g.id === selected.id);
      if (!group) throw new Error('群组不存在。');
      participants = routeGroupMessage(value, group, state.workspace.bots, state.workspace.primaryBotId, explicitIds);
    } else participants = [state.workspace.bots.find(b => b.id === selected.id)].filter(Boolean);
    if (!participants.length) throw new Error('没有可接收本条消息的 Bot。');
    if (participants.some(b => jobs.has(b.id) || reservations.has(b.id))) throw new Error('有参与的 Bot 正在工作，请等待或停止后再发送。');
    emit({ pending: true, error: '' });
    const workflow = { taskId: null, groupId: group?.id || null, participants: participants.map(b => b.id), cancelled: false };
    for (const bot of participants) reservations.set(bot.id, workflow);
    publishJobs();
    let task, launched = false;
    try {
      task = await newRecord('createTask', 'tasks', { title: value.slice(0, 200), ...(group ? { groupId: group.id } : { botId: participants[0].id }) });
      workflow.taskId = task.id; workflows.set(task.id, workflow);
      if (group) await mutate({ action: 'appendGroupMessage', groupId: group.id, message: { id: crypto.randomUUID(), role: 'user', text: value } });
      // Completion is owned by the controller, not by the mounted conversation.
      const execute = async () => {
        try {
          for (const bot of participants) {
            if (disposed) return;
            if (workflow.cancelled) break;
            const result = await executeBot(bot.id, value, { taskId: task.id, groupId: group?.id });
            if (result.status === 'cancelled') { workflow.cancelled = true; break; }
          }
          if (!disposed) await mutate({ action: 'updateTask', id: task.id, patch: { status: workflow.cancelled ? 'cancelled' : 'completed', summary: workflow.cancelled ? '任务已停止，未开始的成员不会再执行。' : '参与的 Bot 已完成本轮工作。' } });
        } catch (error) {
          if (disposed) return;
          await mutate({ action: 'updateTask', id: task.id, patch: { status: error.code === 'tracking-detached' ? 'waiting' : workflow.cancelled ? 'cancelled' : 'failed', summary: error.message } }).catch(report);
          if (group) await mutate({ action: 'appendGroupMessage', groupId: group.id, message: { role: 'system', text: `任务暂停：${error.message}` } }).catch(report);
          report(error);
        } finally {
          workflows.delete(task.id);
          for (const bot of participants) if (reservations.get(bot.id) === workflow) reservations.delete(bot.id);
          publishJobs();
        }
      };
      launched = true;
      execute().catch(report);
      return { taskId: task.id };
    } catch (error) {
      if (!launched && task && !disposed) await mutate({ action: 'updateTask', id: task.id, patch: { status: 'failed', summary: error.message } }).catch(report);
      throw error;
    } finally {
      if (!launched) { if (task) workflows.delete(task.id); for (const bot of participants) if (reservations.get(bot.id) === workflow) reservations.delete(bot.id); publishJobs(); }
      emit({ pending: false });
    }
  }
  async function stop(botId) {
    const ids = botId ? [botId] : state.selected?.kind === 'group' ? [...reservations].filter(([,w]) => w.groupId === state.selected.id).map(([id]) => id) : [state.selected?.id];
    if (!ids.filter(Boolean).length && state.selected?.kind === 'group') {
      const sessionId = state.conversation?.sessionId || state.workspace.runs.slice().reverse().find(r => r.groupId === state.selected.id && r.sessionId)?.sessionId;
      if (sessionId) await runtime.cancel(sessionId);
      return;
    }
    const cancelledWorkflows = new Set();
    for (const id of ids.filter(Boolean)) { const workflow = reservations.get(id); if (workflow) { workflow.cancelled = true; cancelledWorkflows.add(workflow); } }
    const allIds = new Set([...ids, ...[...jobs].filter(([, j]) => cancelledWorkflows.has(workflows.get(j.taskId))).map(([id]) => id)]);
    for (const id of [...allIds].filter(Boolean)) {
      const job = jobs.get(id);
      if (job) { job.cancelled = true; if (job.handle) await job.handle.cancel(); }
      else if (!reservations.has(id)) { const bot = state.workspace.bots.find(b => b.id === id); if (bot?.sessionId) await runtime.cancel(bot.sessionId); }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); if (listeners.size === 1) { refresh().catch(() => {}); poll = setInterval(() => refresh().catch(() => {}), 7000); } return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(poll); poll = null; } }; },
    refresh, mutate, select, send, stop, report,
    clearError: () => emit({ error: '' }),
    async createBot(data, primary = false) { const bot = await newRecord('createBot', 'bots', data); if (primary || !state.workspace.primaryBotId) await mutate({ action: 'setPrimary', id: bot.id }); await select('bot', bot.id); return bot; },
    async createGroup(data) { const group = await newRecord('createGroup', 'groups', data); await select('group', group.id); return group; },
    openNative(sessionId) {
      if (sessionId) return runtime.open(sessionId);
      if (state.selected?.kind === 'group') {
        const active = [...jobs.values()].find(j => j.groupId === state.selected.id && j.sessionId);
        const run = state.workspace.runs.slice().reverse().find(r => r.groupId === state.selected.id && r.sessionId);
        const id = active?.sessionId || run?.sessionId;
        if (id) return runtime.open(id);
        throw new Error('这个群组还没有开始过会话。先交给成员一项工作。');
      }
      const bot = state.workspace.bots.find(b => b.id === state.selected?.id);
      if (!bot?.sessionId) throw new Error('这个 Bot 还没有开始过会话。先交给它一项工作。');
      return runtime.open(bot.sessionId);
    },
    async loadOlder() {
      const bot = state.workspace.bots.find(b => b.id === state.selected?.id);
      if (!bot?.sessionId) return;
      const handle = await runtime.acquire({ id: bot.id, sessionId: bot.sessionId });
      try { await handle.loadOlder(); } finally { handle.release(); }
    },
    workspaceCwd: () => currentWorkspaceCwd(ctx),
    dispose() { disposed = true; clearInterval(poll); unwatch?.(); for (const tracker of recovered.values()) tracker.off?.(); for (const job of jobs.values()) { const error = new Error('插件已卸载。DSH 宿主中已开始的任务不会因此自动取消。'); error.code = 'tracking-detached'; job.reject?.(error); } runtime.dispose(); listeners.clear(); }
  };
}
