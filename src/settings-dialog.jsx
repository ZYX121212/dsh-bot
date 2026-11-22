import React, { useEffect, useRef, useState } from 'react';
import { chatExport } from './team-core.mjs';
import { collectConversationMessages, transcriptFilename } from './transcript-actions.mjs';
const ended = new Set(['completed', 'failed', 'cancelled']);
function requestDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
export default function WorkspaceSettings({ Dialog, controller, workspace, bot, group, conversation, messages, title, selectedKey, motionPaused, toggleMotion, onClose, onNotice }) {
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  const saving = useRef(false), active = useRef(true), readAbort = useRef(null);
  useEffect(() => { active.current = true; return () => { active.current = false; readAbort.current?.abort(); }; }, []);
  useEffect(() => () => readAbort.current?.abort(), [selectedKey]);
  function close() { readAbort.current?.abort(); onClose(); }
  async function perform(kind, job, notice) {
    if (saving.current) return;
    saving.current = true; setPending(kind); setError('');
    if (error && controller.getSnapshot().error === error) controller.clearError();
    const abort = kind === 'export' ? new AbortController() : null;
    readAbort.current = abort;
    try { await job(abort?.signal); if (active.current && !abort?.signal.aborted && notice) onNotice(notice); }
    catch (failure) { if (active.current && !abort?.signal.aborted && failure.name !== 'AbortError') setError(failure.message); }
    finally { saving.current = false; if (readAbort.current === abort) readAbort.current = null; if (active.current) setPending(''); }
  }
  async function exportConversation(signal) {
    const rows = group ? messages : await collectConversationMessages(controller, { key: selectedKey, signal });
    if (signal.aborted || !active.current) return;
    const bots = controller.getSnapshot().workspace.bots;
    requestDownload(transcriptFilename(title), chatExport(title, rows.map(row => ({ ...row, name: row.botId ? bots.find(item => item.id === row.botId)?.name : bot?.name }))));
  }
  const protectedTasks = new Set(workspace.runs.filter(run => !ended.has(run.status) || run.settled === false).map(run => run.taskId));
  const hasEndedRecords = workspace.tasks.some(task => ended.has(task.status) && !protectedTasks.has(task.id)) || workspace.runs.some(run => ended.has(run.status) && run.settled !== false && !workspace.tasks.some(task => task.id === run.taskId && !ended.has(task.status)));
  const canExport = messages.length > 0 || (!!bot?.sessionId && (!conversation || conversation.hasMore));
  return <Dialog title="工作空间设置" onClose={close} busy={!!pending && pending !== 'export'}><div className="dt-settings" aria-busy={!!pending}>
    <label htmlFor="dt-theme">外观<select id="dt-theme" aria-label="外观" className="dt-input" value={workspace.settings.theme} disabled={!!pending} onChange={event => { const theme = event.target.value; perform('theme', () => controller.mutate({ action: 'updateSettings', patch: { theme } })); }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
    <div className="dt-settings-row"><strong>动画</strong><button type="button" className="dt-button" disabled={!!pending} aria-label={motionPaused ? '开启角色动画' : '暂停角色动画'} onClick={toggleMotion}>{motionPaused ? '开启' : '暂停'}</button></div>
    <div className="dt-settings-row"><strong>对话</strong><button type="button" className="dt-button" disabled={!!pending || !canExport} onClick={() => perform('export', exportConversation, '已请求下载')}>{pending === 'export' ? '导出中…' : '导出'}</button></div>
    {group && <div className="dt-settings-row"><strong>群聊</strong><button type="button" className="dt-button" aria-label="清空群聊记录" disabled={!!pending || !group.messages?.length} onClick={() => { if (window.confirm('清空群聊记录并保留运行中的任务？')) perform('clear', () => controller.mutate({ action: 'clearGroupMessages', id: group.id }), '已清空'); }}>{pending === 'clear' ? '清空中…' : '清空记录'}</button></div>}
    <div className="dt-settings-row"><strong>记录</strong><button type="button" className="dt-button" disabled={!!pending || !hasEndedRecords} onClick={() => { if (window.confirm('清理已结束的任务与运行记录？')) perform('cleanup', () => controller.mutate({ action: 'cleanupEndedRecords' }), '已清理'); }}>{pending === 'cleanup' ? '清理中…' : '清理已结束记录'}</button></div>
    <div className="dt-settings-row"><strong>工作空间</strong><button type="button" className="dt-button" disabled={!!pending} onClick={() => perform('refresh', controller.refresh)}>刷新</button></div>
    {error && <div className="dt-alert" role="alert">{error}</div>}
  </div></Dialog>;
}
