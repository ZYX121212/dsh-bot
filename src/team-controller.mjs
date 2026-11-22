import { createBotRuntime, currentWorkspaceCwd } from './runtime.mjs';
import { emptyTeamWorkspace, buildTeammatePrompt, routeGroupMessage, summarizeRun } from './team-core.mjs';
import { createPresenceTracker } from './presence-tracker.mjs';

export function createTeamController(ctx, options = {}) {
  const runtime = options.runtime ?? createBotRuntime(ctx);
  const listeners = new Set();
  let state = { workspace: emptyTeamWorkspace(), loaded: false, loading: false, error: '', selected: null, conversation: null, pending: false, jobs: {}, botPresence: {}, connection: 'loading' };
  let mutationQueue = Promise.resolve(), refreshOperation = null, unwatch = null, navigation = 0, disposed = false, poll = null, writeRetry = null;
  const jobs = new Map(), reservations = new Map(), workflows = new Map(), recovered = new Map(), admissions = new Set(), pendingWrites = new Set();
  const emit = patch => { if (disposed) return; state = { ...state, ...patch }; for (const fn of listeners) { try { fn(); } catch {} } };
  const report = error => { emit({ error: error?.message || String(error) }); };
  const detachedError = () => { const error = new Error('插件已卸载。DSH 宿主中已开始的任务不会因此自动取消。'); error.code = 'tracking-detached'; return error; };
  function createAdmission() {
    let resolve, reject, settled = false;
    const admitted = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Existing callers only use taskId; rejecting an ignored client-side signal
    // must not produce an unhandled rejection or persist a Promise to the host.
    admitted.catch(() => {});
    const signal = {
      admitted,
      resolve(receipt) { if (settled) return; settled = true; admissions.delete(signal); resolve(receipt); },
      reject(error) { if (settled) return; settled = true; admissions.delete(signal); reject(error); }
    };
    admissions.add(signal);
    return signal;
  }
  const presence = createPresenceTracker(runtime, { onChange: botPresence => emit({ botPresence }), statusSource: ctx.uiSession?.sessionStatus, catalogSource: ctx.sessions?.list });
  function syncPresence() {
    const rows = Object.fromEntries([...reservations].map(([id]) => [id, { status: 'queued' }]));
    for (const [id, job] of jobs) rows[id] = { status: job.status, sessionId: job.sessionId, snapshot: job.snapshot };
    // Workspace metadata availability is not native-session connectivity.
    // Actual removed/open-error evidence is already present in runtime snapshots.
    presence.update({ bots: state.workspace.bots, runs: state.workspace.runs, jobs: rows, selectedBotId: state.selected?.kind === 'bot' ? state.selected.id : null, activeBotIds: state.selected?.kind === 'group' ? state.workspace.groups.find(g => g.id === state.selected.id)?.memberIds || [] : [], connected: true, enabled: listeners.size > 0 });
  }
  function adopt(workspace) {
    if (!workspace || !Array.isArray(workspace.bots) || !Array.isArray(workspace.groups)) throw new Error('Bot 工作区返回了无法识别的数据，请更新插件后重试。');
    if (workspace.revision < state.workspace.revision) return state.workspace;
    emit({ workspace, loaded: true, connection: 'ready' });
    queueMicrotask(() => { recoverPendingRuns(); for (const write of pendingWrites) write.attempt(); });
    if (!state.selected) {
      let saved; try { saved = JSON.parse(localStorage.getItem('dsh-bot:v2:selection') || 'null'); } catch {}
      const valid = saved && (saved.kind === 'bot' ? workspace.bots.some(b => b.id === saved.id && !b.archived) : workspace.groups.some(g => g.id === saved.id && !g.archived));
      const first = workspace.bots.find(b => b.id === workspace.primaryBotId && !b.archived) ?? workspace.bots.find(b => !b.archived);
      if (valid) select(saved.kind, saved.id); else if (first) select('bot', first.id);
    }
    syncPresence();
    return workspace;
  }
  async function rpc(method, payload) {
    const result = await ctx.connection.rpc.call('/api', `botWorkspace/${method}`, { args: payload });
    if (!result?.ok) { const error = new Error(result?.error?.message ?? '无法连接 Bot 工作区。请确认插件已安装并重启 DSH。'); error.code = result?.error?.code; throw error; }
    return result.value;
  }
  function mutate(request) {
    const result = mutationQueue.catch(() => {}).then(async () => { const workspace = await rpc('update', { request }); adopt(workspace); return workspace; });
    mutationQueue = result;
    return result;
  }
  function refresh() {
    if (refreshOperation) return refreshOperation;
    emit({ loading: !state.loaded });
    refreshOperation = rpc('read', {}).then(adopt).catch(error => { emit({ connection: 'error' }); syncPresence(); report(error); throw error; }).finally(() => { emit({ loading: false }); refreshOperation = null; });
    return refreshOperation;
  }
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const hasTurn = value => Number.isSafeInteger(value) && value >= 0;
  function matchOwnedTurn(owner, snapshot) {
    if (!hasTurn(owner.turn) && owner.dispatchId) {
      const user = snapshot.messages?.find(message => message.role === 'user' && message.dispatchId === owner.dispatchId && message.seq > (owner.afterSeq ?? 0) && hasTurn(message.turn));
      if (user) owner.turn = user.turn;
    }
    if (!hasTurn(owner.turn)) return null;
    return (snapshot.turnEnds ?? [snapshot.lastTurnEnd]).find(end => end && end.turn === owner.turn && end.seq > (owner.afterSeq ?? 0)) ?? null;
  }
  function nativeResult(owner, snapshot, end) {
    const reason = typeof end.reason === 'object' ? end.reason.kind : end.reason;
    const status = reason === 'completed' ? 'completed' : ['aborted', 'cancelled', 'stopped'].includes(reason) ? 'cancelled' : 'failed';
    const text = summarizeRun({ ...snapshot, messages: snapshot.messages.filter(message => message.turn === owner.turn) }, owner.afterSeq);
    return { status, text, summary: text || snapshot.error || `结束原因：${reason}`, sessionId: owner.sessionId };
  }
  // Keep a failed metadata write pending, never turn actual native success into
  // model failure. Refresh retries idempotent operations without replaying work.
  function stopWriteRetry() { if (!pendingWrites.size) { clearInterval(writeRetry); writeRetry = null; } }
  function retryWrite(operation) {
    let resolve, reject, running = false, finished = false;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
    const write = {
      cancel() { if (finished) return; finished = true; pendingWrites.delete(write); stopWriteRetry(); reject(detachedError()); },
      async attempt() {
        if (finished || running || disposed) return;
        running = true;
        try { const value = await operation(); finished = true; pendingWrites.delete(write); stopWriteRetry(); resolve(value); }
        catch (error) { if (!disposed) report(error); }
        finally { running = false; }
      }
    };
    pendingWrites.add(write);
    if (!writeRetry) { writeRetry = setInterval(() => { for (const write of pendingWrites) write.attempt(); }, 7000); writeRetry.unref?.(); }
    write.attempt(); return promise;
  }
  async function appendResult(run, text) {
    if (!state.workspace.runs.some(row => row.id === run.id)) return;
    const group = state.workspace.groups.find(group => group.id === run.groupId);
    if (run.groupId && run.botId && group && text) await mutate({ action: 'appendGroupMessage', groupId: run.groupId, message: { id: run.id, role: 'assistant', botId: run.botId, text, sessionId: run.sessionId, runId: run.id } });
  }
  async function repairRecovered(run) {
    if (!state.workspace.runs.some(row => row.id === run.id)) return;
    await appendResult(run, run.reply ?? '');
    const task = state.workspace.tasks.find(task => task.id === run.taskId);
    // An overlapping owner may already have completed the full workflow. CAS
    // prevents a stale recovery callback from downgrading that terminal task.
    if (task && !terminalStatuses.has(task.status)) await mutate({ action: 'updateTask', expectedRevision: state.workspace.revision, id: task.id, patch: { status: run.groupId && run.status === 'completed' ? 'waiting' : run.status, summary: run.groupId && run.status === 'completed' ? '已恢复当前成员的结果。为避免重复操作，未自动重放后续成员；请继续交办。' : run.summary } });
    await mutate({ action: 'upsertRun', run: { id: run.id, settled: true, status: run.status, summary: run.summary, reply: run.reply ?? '' } });
  }
  function recoverPendingRuns() {
    if (disposed) return;
    const active = new Set(['queued', 'running', 'waiting']);
    for (const source of state.workspace.runs) {
      if (!source.sessionId || workflows.has(source.taskId) || (!active.has(source.status) && !(terminalStatuses.has(source.status) && source.settled === false))) continue;
      let existing = recovered.get(source.id);
      if (existing?.done && source.settled === false) { recovered.delete(source.id); existing = null; }
      if (existing) { existing.attempt?.(); continue; }
      const run = { ...source }, tracker = { off: null, done: false, running: false, proofReady: terminalStatuses.has(run.status), terminal: terminalStatuses.has(run.status), lastStatus: null, attempt: null };
      recovered.set(run.id, tracker);
      tracker.attempt = async () => {
        if (disposed || tracker.done || tracker.running || !tracker.terminal || !tracker.proofReady) return;
        tracker.running = true;
        try { await repairRecovered(run); tracker.done = true; tracker.off?.(); }
        catch (error) { report(error); }
        finally { tracker.running = false; }
      };
      if (tracker.terminal) { tracker.attempt(); continue; }
      runtime.watch(run.sessionId, snapshot => {
        if (disposed || tracker.done) return;
        if (tracker.terminal) { tracker.attempt(); return; }
        const previousTurn = run.turn, end = matchOwnedTurn(run, snapshot);
        if (end) {
          const result = nativeResult(run, snapshot, end);
          Object.assign(run, { status: result.status, summary: result.summary, reply: result.text, settled: false }); tracker.terminal = true;
          // Persist the native proof/result before attempting optional delivery.
          retryWrite(async () => { if (!state.workspace.runs.some(row => row.id === run.id)) return; return mutate({ action: 'upsertRun', run: { id: run.id, dispatchId: run.dispatchId ?? null, turn: run.turn, status: run.status, summary: run.summary, reply: run.reply, settled: false } }); }).then(() => { tracker.proofReady = true; tracker.attempt(); }).catch(report);
          return;
        }
        const ownsCurrent = hasTurn(run.turn) && snapshot.latestTurn === run.turn;
        const status = ownsCurrent && snapshot.running ? (snapshot.needsAttention ? 'waiting' : 'running') : 'waiting';
        if (tracker.lastStatus !== status || previousTurn !== run.turn) {
          tracker.lastStatus = status;
          mutate({ action: 'upsertRun', run: { id: run.id, status, ...(hasTurn(run.turn) ? { turn: run.turn } : {}), ...(!ownsCurrent || !snapshot.running ? { summary: '尚未核实本次消息对应的原生完成边界；没有自动重发。' } : {}) } }).catch(report);
        }
      }).then(off => { tracker.off = off; if (tracker.done || disposed) off(); }).catch(error => { recovered.delete(run.id); report(error); });
    }
  }
  async function select(kind, id) {
    const revision = ++navigation;
    unwatch?.(); unwatch = null;
    emit({ selected: { kind, id }, conversation: null, pending: false, error: '' });
    syncPresence();
    try { localStorage.setItem('dsh-bot:v2:selection', JSON.stringify({ kind, id })); } catch {}
    const sessionId = kind === 'bot' ? state.workspace.bots.find(b => b.id === id)?.sessionId
      : kind === 'group' ? ([...jobs.values()].find(j => j.groupId === id && j.sessionId)?.sessionId || state.workspace.runs.slice().reverse().find(r => r.groupId === id && r.sessionId)?.sessionId) : null;
    if (!sessionId) return;
    try {
      const off = await runtime.watch(sessionId, snapshot => { if (navigation === revision) { emit({ conversation: snapshot }); syncPresence(); } });
      if (navigation !== revision || disposed) off(); else unwatch = off;
    } catch (error) { if (navigation === revision) report(error); }
  }
  function publishJobs() {
    const rows = [...reservations].map(([id, task]) => [id, { status: 'queued', sessionId: null, taskId: task.taskId, groupId: task.groupId }]);
    for (const [id, job] of jobs) rows.push([id, { status: job.status, sessionId: job.sessionId, taskId: job.taskId, groupId: job.groupId }]);
    emit({ jobs: Object.fromEntries(rows) });
    syncPresence();
  }
  async function newRecord(action, field, request) {
    const workspace = await mutate({ action, ...request });
    // The host appends the created row in the same locked mutation snapshot.
    const record = workspace[field].at(-1);
    if (!record) throw new Error('未找到刚创建的记录，请刷新后重试。');
    return record;
  }
  function requestJobStop(job) {
    if (job.nativeFinished || !job.handle || !job.dispatched) return Promise.resolve();
    if (job.stopping) return job.stopping;
    job.stopping = Promise.resolve().then(async () => {
      let receipt;
      try {
        if (typeof job.handle.cancelDispatch === 'function') receipt = await job.handle.cancelDispatch(job.dispatchId, { turn: job.turn });
        else {
          const snapshot = runtime.snapshot(job.sessionId);
          if (!hasTurn(job.turn) || !snapshot?.running || snapshot.latestTurn !== job.turn) { const error = new Error('尚未核实本条消息的原生回合，未停止其他工作。'); error.code = 'dispatch-unverified'; throw error; }
          receipt = await job.handle.cancel();
        }
      } catch (error) { if (job.admitting && error.code === 'dispatch-unverified') return; throw error; }
      if (receipt?.scope === 'queue' && !job.nativeFinished) { job.nativeFinished = true; job.resolve?.({ removed: true }); }
    }).finally(() => { job.stopping = null; });
    return job.stopping;
  }
  async function executeBot(botId, text, { taskId, groupId = null, admission } = {}) {
    if (jobs.has(botId)) throw new Error('这个 Bot 已经在工作，请等待完成或先停止。');
    const job = { turn: null, afterSeq: null, dispatchId: null, nativeFinished: false, admitting: false, stopping: null, status: 'queued', sessionId: null, taskId, groupId, handle: null, stopRequested: false, dispatched: false };
    const stopBeforeDispatch = () => { const error = new Error('任务已停止，尚未向原生会话提交。'); error.code = 'cancelled-before-dispatch'; throw error; };
    jobs.set(botId, job); publishJobs();
    const runId = crypto.randomUUID(); job.dispatchId = runId; workflows.get(taskId)?.runIds?.add(runId);
    let off = null, timer = null, rejectWait = null;
    try {
      const bot = state.workspace.bots.find(b => b.id === botId);
      if (!bot || bot.archived) throw new Error('这个 Bot 已被移除或归档。');
      const handle = await runtime.acquire({ id: bot.id, sessionId: bot.sessionId || undefined, agentPreset: 'standard', cwd: currentWorkspaceCwd(ctx) }, { onSession: async sessionId => {
        await mutate({ action: 'setSession', botId: bot.id, sessionId });
      } });
      job.handle = handle; job.sessionId = handle.sessionId;
      if (disposed) throw detachedError();
      if (job.stopRequested) stopBeforeDispatch();
      const baseline = runtime.snapshot(handle.sessionId);
      if (baseline?.running || baseline?.needsAttention || baseline?.approval) throw new Error('这个 Bot 的原生会话仍在工作或等待处理。请打开 DSH 会话查看进度并处理交互，再继续。');
      const afterSeq = baseline?.lastSeq ?? 0; job.afterSeq = afterSeq;
      await mutate({ action: 'upsertRun', run: { id: runId, taskId: taskId || null, botId, groupId, sessionId: handle.sessionId, afterSeq, dispatchId: runId, turn: null, settled: false, status: 'queued', title: text.slice(0, 200) } });
      if (taskId) await mutate({ action: 'updateTask', id: taskId, patch: { status: 'queued', sessionId: handle.sessionId } });
      const complete = new Promise((resolve, reject) => { rejectWait = reject; job.reject = reject; job.resolve = resolve; });
      complete.catch(() => {});
      off = await runtime.watch(handle.sessionId, snapshot => {
        job.snapshot = snapshot;
        syncPresence();
        if (state.selected?.kind === 'group' && state.selected.id === groupId) emit({ conversation: snapshot });
        if (!job.dispatched || job.nativeFinished) return;
        const previousTurn = job.turn, end = matchOwnedTurn(job, snapshot);
        if (end) { job.nativeFinished = true; job.resolve({ snapshot, end }); return; }
        if (snapshot.removed || ['error', 'failed'].includes(snapshot.openState)) { const error = new Error('原生会话已不可用，尚未确认本次工作结果。'); error.code = 'tracking-detached'; job.reject(error); return; }
        if (job.stopRequested && previousTurn !== job.turn && hasTurn(job.turn)) requestJobStop(job).catch(report);
        const ownsCurrent = hasTurn(job.turn) && snapshot.latestTurn === job.turn;
        const status = ownsCurrent && snapshot.running ? (snapshot.needsAttention ? 'waiting' : 'running') : 'queued';
        if (job.status !== status || previousTurn !== job.turn) {
          job.status = status; publishJobs();
          mutate({ action: 'upsertRun', run: { id: runId, status, ...(hasTurn(job.turn) ? { turn: job.turn } : {}) } }).catch(report);
          if (taskId) mutate({ action: 'updateTask', id: taskId, patch: { status } }).catch(report);
        }
      });
      if (job.stopRequested) stopBeforeDispatch();
      const group = groupId ? state.workspace.groups.find(g => g.id === groupId) : null;
      const prompt = buildTeammatePrompt(bot, text, state.workspace, group, runId);
      job.status = 'queued'; publishJobs();
      if (state.selected?.kind === 'bot' && state.selected.id === botId) await select('bot', botId);
      else if (groupId && state.selected?.kind === 'group' && state.selected.id === groupId) await select('group', groupId);
      if (job.stopRequested) stopBeforeDispatch();
      if (disposed) throw detachedError();
      // Metadata writes/navigation above await I/O. Revalidate at the final
      // synchronous dispatch boundary rather than adopting an unrelated result.
      const beforeDispatch = runtime.snapshot(handle.sessionId);
      if (beforeDispatch?.running || beforeDispatch?.needsAttention || beforeDispatch?.approval || (beforeDispatch?.lastSeq ?? 0) !== afterSeq) throw new Error('原生会话在提交准备期间已发生变化，本次消息尚未发送。请确认会话状态后重试。');
      job.dispatched = true; job.admitting = true;
      try { await handle.send(prompt); } finally { job.admitting = false; }
      admission?.resolve({ taskId, sessionId: handle.sessionId, accepted: true });
      // A cancellation receipt is only a request, not proof the native turn
      // aborted. Even a rejected retry must not detach completion observation.
      if (job.stopRequested && !disposed && !job.nativeFinished) { if (job.stopping) await job.stopping.catch(report); if (!job.nativeFinished) await requestJobStop(job).catch(report); }
      timer = setTimeout(() => { const error = new Error('已跟踪 60 分钟，请打开原生会话查看最终状态；任务没有被自动取消。'); error.code = 'tracking-detached'; rejectWait?.(error); }, 3600000);
      const outcome = await complete;
      clearTimeout(timer); timer = null;
      const { snapshot, end } = outcome;
      const result = outcome.removed ? { status: 'cancelled', text: '', summary: '已从原生队列移除，尚未开始执行。', sessionId: job.sessionId } : nativeResult(job, snapshot, end);
      const completedRun = { id: runId, taskId: taskId || null, botId, groupId, sessionId: handle.sessionId, afterSeq, dispatchId: runId, turn: job.turn, status: result.status, summary: result.summary, reply: result.text, settled: false };
      await retryWrite(async () => { if (state.workspace.runs.some(run => run.id === runId)) return mutate({ action: 'upsertRun', run: completedRun }); });
      await retryWrite(async () => appendResult(completedRun, result.text));
      if (result.status === 'failed') { const error = new Error(snapshot.error || `任务未正常完成：${end.reason || '未知原因'}`); error.nativeOutcome = true; throw error; }
      return result;
    } catch (error) {
      admission?.reject(error);
      if (!disposed && !job.nativeFinished) await mutate({ action: 'upsertRun', run: { id: runId, dispatchId: runId, turn: job.turn, settled: false, taskId: taskId || null, botId, groupId, sessionId: job.sessionId, status: error.code === 'tracking-detached' ? 'waiting' : error.code === 'cancelled-before-dispatch' ? 'cancelled' : 'failed', title: text.slice(0, 200), summary: error.message } }).catch(report);
      throw error;
    } finally { clearTimeout(timer); off?.(); job.handle?.release(); jobs.delete(botId); publishJobs(); }
  }
  async function send(text, explicitIds = []) {
    if (disposed) throw detachedError();
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
      if (group.archived) throw new Error('群组已归档，请先恢复再发送。');
      participants = routeGroupMessage(value, group, state.workspace.bots, state.workspace.primaryBotId, explicitIds);
    } else { const bot = state.workspace.bots.find(b => b.id === selected.id); if (bot?.archived) throw new Error('Bot 已归档，请先恢复再发送。'); participants = [bot].filter(Boolean); }
    if (!participants.length) throw new Error('没有可接收本条消息的 Bot。');
    if (group && (group.messages?.length ?? 0) + 1 + participants.length > 400) throw new Error('群聊记录空间不足，请先清空群聊记录再发送。');
    if (participants.some(b => jobs.has(b.id) || reservations.has(b.id))) throw new Error('有参与的 Bot 正在工作，请等待或停止后再发送。');
    emit({ pending: true, error: '' });
    const workflow = { taskId: null, groupId: group?.id || null, participants: participants.map(b => b.id), stopRequested: false, cancelled: false, runIds: new Set(), admission: createAdmission() };
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
            if (disposed) { workflow.admission.reject(detachedError()); return; }
            if (workflow.stopRequested) { workflow.cancelled = true; workflow.admission.reject(new Error('任务已停止，消息尚未确认接收。')); break; }
            const result = await executeBot(bot.id, value, { taskId: task.id, groupId: group?.id, admission: workflow.admission });
            if (result.status === 'cancelled') { workflow.cancelled = true; break; }
          }
          if (!disposed) {
            await retryWrite(async () => { if (!state.workspace.tasks.some(row => row.id === task.id)) return; return mutate({ action: 'updateTask', id: task.id, patch: { status: workflow.cancelled ? 'cancelled' : 'completed', summary: workflow.cancelled ? '任务已停止，未开始的成员不会再执行。' : '参与的 Bot 已完成本轮工作。' } }); });
            await retryWrite(async () => { for (const id of workflow.runIds) { const run = state.workspace.runs.find(run => run.id === id); if (run) await mutate({ action: 'upsertRun', run: { id, status: run.status, settled: true } }); } });
          }
        } catch (error) {
          workflow.admission.reject(error);
          if (disposed) return;
          await retryWrite(async () => { if (!state.workspace.tasks.some(row => row.id === task.id)) return; return mutate({ action: 'updateTask', id: task.id, patch: { status: error.code === 'tracking-detached' ? 'waiting' : workflow.cancelled || error.code === 'cancelled-before-dispatch' ? 'cancelled' : 'failed', summary: error.message } }); });
          if (group && state.workspace.groups.some(item => item.id === group.id && !item.archived) && state.workspace.tasks.some(item => item.id === task.id)) { const id = crypto.randomUUID(); await retryWrite(async () => mutate({ action: 'appendGroupMessage', groupId: group.id, message: { id, role: 'system', text: `任务暂停：${error.message}` } })); }
          if (error.code !== 'tracking-detached') await retryWrite(async () => { for (const id of workflow.runIds) { const run = state.workspace.runs.find(run => run.id === id); if (run) await mutate({ action: 'upsertRun', run: { id, status: run.status, settled: true } }); } });
          report(error);
        } finally {
          workflows.delete(task.id);
          for (const bot of participants) if (reservations.get(bot.id) === workflow) reservations.delete(bot.id);
          publishJobs();
        }
      };
      launched = true;
      execute().catch(report);
      return { ...task, taskId: task.id, admitted: workflow.admission.admitted };
    } catch (error) {
      workflow.admission.reject(error);
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
    for (const id of ids.filter(Boolean)) { const workflow = reservations.get(id); if (workflow) { workflow.stopRequested = true; workflow.admission?.reject(new Error('任务已停止，消息尚未确认接收。')); cancelledWorkflows.add(workflow); } }
    const allIds = new Set([...ids, ...[...jobs].filter(([, j]) => cancelledWorkflows.has(workflows.get(j.taskId))).map(([id]) => id)]);
    for (const id of [...allIds].filter(Boolean)) {
      const job = jobs.get(id);
      if (job) { job.stopRequested = true; if (job.handle && job.dispatched && !job.nativeFinished) await requestJobStop(job); }
      else if (!reservations.has(id)) { const bot = state.workspace.bots.find(b => b.id === id); if (bot?.sessionId) await runtime.cancel(bot.sessionId); }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); if (listeners.size === 1) { if (state.selected) select(state.selected.kind, state.selected.id).catch(report); syncPresence(); refresh().catch(() => {}); poll = setInterval(() => refresh().catch(() => {}), 7000); } return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(poll); poll = null; navigation++; unwatch?.(); unwatch = null; syncPresence(); } }; },
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
    dispose() { disposed = true; clearInterval(poll); clearInterval(writeRetry); unwatch?.(); for (const tracker of recovered.values()) tracker.off?.(); for (const admission of admissions) admission.reject(detachedError()); for (const write of pendingWrites) write.cancel(); for (const job of jobs.values()) job.reject?.(detachedError()); presence.dispose(); runtime.dispose(); listeners.clear(); }
  };
}
