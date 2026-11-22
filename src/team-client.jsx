import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isSubmitKey, consumeSubmittedDraft, planTranscriptScroll, teamStageModel, taskDestination } from './chat-behavior.mjs';
import { createTeamController } from './team-controller.mjs';
import { BOT_PALETTE, BOT_TEMPLATES, membersOf, displayBotText, teamStatusLabel } from './team-core.mjs';
import BOT_CSS from './team-style.css';
import { BotAvatar } from './bot-avatar.jsx';
import { deriveBotPresence, deriveTeamPresence } from './bot-presence.mjs';
import AVATAR_CSS from './bot-avatar.css';
import POLISH_CSS from './team-polish.css';
import MINIMAL_CSS from './team-minimal.css';
import MessageContent from './message-content.jsx';
import MESSAGE_CSS from './message-content.css';
import { TEAM_THEME_CSS } from './team-theme.mjs';
import THEME_CSS from './team-theme.css';
import { collectConversationMessages } from './transcript-actions.mjs';
import WorkspaceSettings from './settings-dialog.jsx';

const paths = {
  pause: 'M8 5v14M16 5v14', plus: 'M12 5v14M5 12h14', search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6', close: 'm6 6 12 12M6 18 18 6', arrow: 'M12 19V5m-6 6 6-6 6 6',
  panel: 'M3 4h18v16H3zM15 4v16', menu: 'M4 6h16M4 12h16M4 18h16', more: 'M5 12h.01M12 12h.01M19 12h.01',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  files: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check: 'm5 12 4 4L19 6', bolt: 'm13 2-9 12h7l-1 8 10-13h-7z', external: 'M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
  plug: 'm8 3 0 5M16 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  memory: 'M9 3a3 3 0 0 0-3 3v1a4 4 0 0 0-2 7v1a4 4 0 0 0 5 5 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3m6 0a3 3 0 0 1 3 3v1a4 4 0 0 1 2 7v1a4 4 0 0 1-5 5 3 3 0 0 1-3-3V6a3 3 0 0 1 3-3',
  pen: 'm16 3 5 5M4 20l4-1L21 6l-4-4L4 15z', code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M10 12h4', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', stop: 'M6 6h12v12H6z', home: 'm3 10 9-7 9 7v11h-6v-7H9v7H3z'
};
function Icon({ name, size = 18, ...props }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.spark}/></svg>; }
function Avatar(props) { return <BotAvatar {...props}/>; }
const IDLE_PRESENCE = { state: 'idle', label: '待命' };
const BUSY_STATES = new Set(['thinking', 'researching', 'coding', 'writing', 'working']);
const presenceFor = (state, bot) => {
  if (state.botPresence?.[bot?.id]) return state.botPresence[bot.id];
  if (!bot?.archived) return IDLE_PRESENCE;
  const snapshot = state.conversation?.sessionId === bot.sessionId ? state.conversation : null, job = state.jobs?.[bot.id];
  return snapshot?.running || snapshot?.needsAttention || job ? deriveBotPresence({ snapshot, job, sessionId: bot.sessionId }) : { state: 'offline', label: '已归档', source: 'archive' };
};
function PresenceBadge({ presence = IDLE_PRESENCE, detail = false }) {
  return <span className={`dt-presence-badge dt-presence-${presence.state}`} data-presence={presence.state}><span className="dt-presence-light"/><span>{presence.label}</span>{detail && presence.toolName && <code>{presence.toolName}</code>}</span>;
}
function TeamStage({ workspace, presences, onSelect, onCreate }) {
  const stage = teamStageModel(workspace.bots, presences, workspace.primaryBotId);
  return <section className="dt-team-stage" aria-label="动态团队工作台">
    <div className="dt-stage-heading"><h1>团队</h1><div className="dt-stage-tools"><span className="dt-stage-count">{stage.summary}</span><Action icon="plus" label="新建 Bot" onClick={onCreate}/></div></div>
    <div className="dt-stage-grid">{stage.bots.map(bot => {
      const presence = presences?.[bot.id] || IDLE_PRESENCE;
      return <button type="button" key={bot.id} className="dt-companion-tile" onClick={() => onSelect('bot', bot.id)} aria-label={`与 ${bot.name} 对话 · ${presence.label}`}>
        <div className="dt-companion-scene"><Avatar bot={bot} size={96} presence={presence} interactive/></div>
        <div className="dt-companion-name"><strong>{bot.name}</strong>{bot.id === workspace.primaryBotId && <small>主 Bot</small>}</div>
        <PresenceBadge presence={presence}/>
      </button>;
    })}</div>
  </section>;
}
function Action({ icon, label, children, ...props }) { return <button type="button" className="dt-icon-button" title={label} aria-label={label} {...props}>{icon && <Icon name={icon}/>} {children}</button>; }
function SafeText({ text }) { return String(text || '').split(/(https?:\/\/[^\s<>"\u3000]+)/g).map((part, i) => /^https?:\/\//.test(part) ? <a key={i} href={part.replace(/[)\]。，；]+$/, '')} target="_blank" rel="noopener noreferrer">{part}</a> : part); }
function timeLabel(value) { if (!value) return ''; return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

function Dialog({ title, onClose, children, busy = false }) {
  const ref = useRef(null);
  useEffect(() => { const before = document.activeElement; ref.current?.querySelector('input,button,textarea,select')?.focus(); return () => before?.focus?.(); }, []);
  return <div className="dt-modal-backdrop" onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}><section ref={ref} className="dt-modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) onClose(); }
    if (e.key === 'Tab') { const list = [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')]; const first = list[0], last = list.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  }}><header><div><h2>{title}</h2></div><Action icon="close" label="关闭窗口" disabled={busy} onClick={onClose}/></header>{children}</section></div>;
}
function BotEditor({ bot, template, onSave, onClose }) {
  const initial = bot || template || BOT_TEMPLATES[0];
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role || '');
  const [avatar, setAvatar] = useState({ color: initial.avatar?.color || BOT_PALETTE[0], shape: 'circle' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), saveLock = useRef(false);
  async function submit(e) { e.preventDefault(); if (saveLock.current || !name.trim()) return; saveLock.current = true; setBusy(true); setError(''); try { await onSave({ name: name.trim(), role, avatar }); onClose(); } catch (e) { setError(e.message); } finally { saveLock.current = false; setBusy(false); } }
  return <Dialog title={bot ? '编辑 Bot' : '新建 Bot'} busy={busy} onClose={onClose}><form onSubmit={submit} aria-busy={busy}>
    <div className="dt-avatar-editor"><Avatar bot={{ avatar }} size={88}/><div><label className="dt-field-label">颜色</label><div className="dt-color-list">{BOT_PALETTE.map(color => <button type="button" key={color} disabled={busy} aria-label={`颜色 ${color}`} aria-pressed={avatar.color === color} className="dt-color" style={{ background: color }} onClick={() => setAvatar({ ...avatar, color })}/>)}</div></div></div>
    <label className="dt-field-label" htmlFor="dt-bot-name">名字</label><input id="dt-bot-name" readOnly={busy} className="dt-input" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="名字" required/>
    <label className="dt-field-label" htmlFor="dt-bot-role">职责</label><textarea id="dt-bot-role" readOnly={busy} className="dt-input dt-role-input" maxLength={12000} value={role} onChange={e => setRole(e.target.value)} placeholder="职责"/>
    {!bot && <div className="dt-template-list">{BOT_TEMPLATES.map(t => <button type="button" key={t.name} disabled={busy} onClick={() => { setName(t.name); setRole(t.role); setAvatar(t.avatar); }}><Icon name={t.icon} size={14}/>{t.label}</button>)}</div>}
    {error && <div className="dt-alert" role="alert">{error}</div>}<footer><button type="button" className="dt-button" disabled={busy} onClick={onClose}>取消</button><button className="dt-button dt-button-primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : bot ? '保存更改' : '创建 Bot'}</button></footer>
  </form></Dialog>;
}
function GroupEditor({ workspace, group, onSave, onClose }) {
  const [name, setName] = useState(group?.name || '新的协作群组');
  const [ids, setIds] = useState(group ? membersOf(group) : []);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), saveLock = useRef(false);
  return <Dialog title={group ? '管理群组' : '新建群组'} busy={busy} onClose={onClose}><form aria-busy={busy} onSubmit={async e => { e.preventDefault(); if (saveLock.current) return; saveLock.current = true; setBusy(true); setError(''); try { await onSave({ name, memberIds: ids }); onClose(); } catch (e) { setError(e.message); } finally { saveLock.current = false; setBusy(false); } }}>
    <label className="dt-field-label" htmlFor="dt-group-name">群组名称</label><input className="dt-input" id="dt-group-name" readOnly={busy} value={name} maxLength={80} onChange={e => setName(e.target.value)} required/>
    <div className="dt-field-label">选择 Bot · {ids.length} 位</div><div className="dt-group-picker">{workspace.bots.filter(b => !b.archived || membersOf(group).includes(b.id)).map(bot => <label key={bot.id}><Avatar bot={bot}/><span><strong>{bot.name}</strong><small>{bot.archived ? '已归档' : bot.role?.split(/[。\n]/)[0]?.slice(0, 45) || '你的 AI 同事'}</small></span><input type="checkbox" disabled={busy} checked={ids.includes(bot.id)} onChange={e => setIds(e.target.checked ? [...ids, bot.id] : ids.filter(id => id !== bot.id))}/></label>)}</div>
    {error && <div className="dt-alert" role="alert">{error}</div>}<footer><button type="button" className="dt-button" disabled={busy} onClick={onClose}>取消</button><button className="dt-button dt-button-primary" disabled={busy || ids.length < 1 || !name.trim()}>{busy ? '保存中…' : group ? '保存群组' : '创建群组'}</button></footer>
  </form></Dialog>;
}
function MemoryDialog({ bot, memory, initialContent = '', onSave, onClose }) {
  const [content, setContent] = useState(memory?.content || initialContent), [scope, setScope] = useState(memory?.scope || (bot ? 'bot' : 'shared')), [busy, setBusy] = useState(false), [error, setError] = useState(''), saveLock = useRef(false);
  return <Dialog title={memory ? '编辑记忆' : '添加记忆'} busy={busy} onClose={onClose}><form aria-busy={busy} onSubmit={async e => { e.preventDefault(); if (saveLock.current) return; saveLock.current = true; setBusy(true); setError(''); try { await onSave({ scope, ...(scope === 'bot' ? { botId: memory?.botId || bot?.id } : {}), content }); onClose(); } catch (e) { setError(e.message); } finally { saveLock.current = false; setBusy(false); } }}>
    <label className="dt-field-label" htmlFor="dt-memory">内容</label><textarea autoFocus id="dt-memory" readOnly={busy} className="dt-input dt-role-input" maxLength={8000} value={content} onChange={e => setContent(e.target.value)} placeholder="内容" required/>
    <label className="dt-field-label" htmlFor="dt-memory-scope">范围</label><select id="dt-memory-scope" className="dt-input" disabled={!!memory || busy} value={scope} onChange={e => setScope(e.target.value)}>{(bot || memory?.scope === 'bot') && <option value="bot">仅 {bot?.name || '对应 Bot'}</option>}<option value="shared">我的全部 Bot</option></select>
    {error && <div className="dt-alert" role="alert">{error}</div>}<footer><button type="button" className="dt-button" disabled={busy} onClick={onClose}>取消</button><button className="dt-button dt-button-primary" disabled={busy || !content.trim()}>{busy ? '保存中…' : '保存记忆'}</button></footer>
  </form></Dialog>;
}
function Message({ message, bot, live = false, onCopy, onRemember }) {
  if (message.role === 'system') return <div className="dt-system-message"><Icon name="clock" size={13}/><SafeText text={message.text}/></div>;
  const user = message.role === 'user';
  return <article className={`dt-message ${user ? 'dt-message-user' : ''}`} data-message-id={message.id}>
    {user ? <span className="dt-user-avatar">你</span> : <Avatar bot={bot} size={32} still={!message.partial || !live} presence={message.partial && live ? { state: 'writing', label: '正在回复' } : IDLE_PRESENCE}/>}
    <div className="dt-message-content"><div className="dt-message-byline"><strong>{user ? '你' : bot?.name || 'Bot'}</strong><time>{timeLabel(message.time || message.createdAt)}</time>{message.partial && live && <span className="dt-streaming-dot" aria-label="正在生成"/>}</div><div className="dt-message-text">{user ? <SafeText text={displayBotText(message.text)}/> : <MessageContent text={displayBotText(message.text)} onCopy={onCopy}/>}</div>{!message.partial && <div className="dt-message-actions"><button type="button" onClick={() => onCopy(displayBotText(message.text))}>复制</button>{!user && onRemember && <button type="button" onClick={onRemember}>记忆</button>}</div>}</div>
  </article>;
}
function WorkspacePanel({ bot, group, state, tab, setTab, onEdit, onMemory, onNative, onMutate, onClose }) {
  const workspace = state.workspace, ids = group ? membersOf(group) : bot ? [bot.id] : [];
  const runs = workspace.runs.filter(r => group ? r.groupId === group.id : r.botId === bot?.id).slice().reverse();
  const memories = workspace.memories.filter(m => m.scope === 'shared' || ids.includes(m.botId));
  const liveBot = bot || workspace.bots.find(b => ids.includes(b.id) && presenceFor(state, b).state === 'waiting' && presenceFor(state, b).source !== 'run') || workspace.bots.find(b => ids.includes(b.id) && BUSY_STATES.has(presenceFor(state, b).state)) || workspace.bots.find(b => ids.includes(b.id) && state.conversation?.sessionId === b.sessionId) || workspace.bots.find(b => ids.includes(b.id));
  const presence = presenceFor(state, liveBot), sessionId = liveBot?.sessionId || null;
  const conversation = state.conversation?.sessionId === sessionId ? state.conversation : null;
  const attention = presence.state === 'waiting' && presence.source !== 'run';
  return <aside className="dt-workspace" aria-label="工作侧栏">
    <header><span>工作空间</span><Action icon="close" label="关闭工作侧栏" onClick={onClose}/></header>
    <div className="dt-tabs" role="tablist" aria-label="工作侧栏内容">{[['work', '工作'], ['memory', '记忆'], ['about', '详情']].map(([id, title]) => <button type="button" key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{title}</button>)}</div>
    <div className="dt-workspace-scroll">
      {tab === 'work' && <>
        <section className="dt-live-companion" aria-label="Bot 实时状态"><Avatar bot={liveBot} size={56} presence={presence} interactive/><div className="dt-live-caption" role="status"><strong>{liveBot?.name || group?.name}</strong><PresenceBadge presence={presence}/></div></section>
        <button type="button" className={`dt-button dt-native-button ${attention ? 'dt-native-attention' : ''}`} disabled={!sessionId} onClick={() => onNative(sessionId)} aria-label={attention ? '前往 DSH 处理' : '打开原生工作区'}><Icon name="external" size={14}/>{attention ? '处理' : '原生会话'}</button>
        {!!conversation?.activities?.length && <><div className="dt-panel-heading"><span>活动</span><span>{conversation.activities.length}</span></div><div className="dt-activity-list">{conversation.activities.slice(-10).reverse().map(activity => <div key={activity.id}><span className={`dt-activity-icon dt-status-${activity.status}`}><Icon name={['completed', 'success', 'done'].includes(activity.status) ? 'check' : 'bolt'} size={13}/></span><span><strong>{activity.toolName}</strong><small>{teamStatusLabel(({ success: 'completed', error: 'failed' })[activity.status] || activity.status)}</small></span></div>)}</div></>}
        {!!conversation?.files?.length && <><div className="dt-panel-heading"><span>文件</span><span>{conversation.files.length}</span></div><div className="dt-files">{conversation.files.map((file, index) => <button type="button" key={`${file.path}-${index}`} onClick={() => onNative(sessionId)} title={file.path}><Icon name="files"/><span><strong>{file.path.split(/[\\/]/).at(-1)}</strong>{file.description && <small>{file.description}</small>}</span><Icon name="external" size={12}/></button>)}</div></>}
        {!!runs.length && <><div className="dt-panel-heading"><span>任务</span><span>{runs.length}</span></div><div className="dt-run-list">{runs.slice(0, 8).map(run => <button type="button" key={run.id} disabled={!run.sessionId} onClick={() => onNative(run.sessionId)}><span className={`dt-status-dot dt-status-${run.status}`}/><span><strong>{run.title || '任务'}</strong><small>{teamStatusLabel(run.status)}</small></span></button>)}</div></>}
      </>}
      {tab === 'memory' && <>
        <button type="button" className="dt-button dt-full-button" onClick={onMemory}><Icon name="plus" size={14}/>添加记忆</button>
        <div className="dt-memory-list">{memories.map(memory => <article key={memory.id}><div><span>{memory.scope === 'shared' ? '共享' : workspace.bots.find(b => b.id === memory.botId)?.name || 'Bot'}</span><Action icon="pen" label="编辑这条记忆" onClick={() => onMemory(memory)}/><Action icon="trash" label="删除这条记忆" onClick={() => { if (window.confirm('删除记忆？')) onMutate({ action: 'removeMemory', id: memory.id }); }}/></div><p>{memory.content}</p></article>)}</div>
        {!memories.length && <p className="dt-quiet-empty">暂无记忆</p>}
      </>}
      {tab === 'about' && <div className="dt-about"><Avatar bot={bot} group={!!group} size={80} presence={presence}/><h3>{bot?.name || group?.name}</h3><button type="button" className="dt-button dt-full-button" onClick={onEdit}><Icon name="pen" size={14}/>{group ? '编辑群组' : '编辑 Bot'}</button>{group ? ids.map(id => { const member = workspace.bots.find(b => b.id === id); return member && <div className="dt-member-row" key={id}><Avatar bot={member} presence={presenceFor(state, member)}/><span>{member.name}</span><PresenceBadge presence={presenceFor(state, member)}/></div>; }) : bot?.role && <p className="dt-role-text">{bot.role}</p>}{bot && !bot.archived && workspace.primaryBotId !== bot.id && <button type="button" className="dt-button dt-full-button" onClick={() => onMutate({ action: 'setPrimary', id: bot.id })}>设为主 Bot</button>}<button type="button" className="dt-button dt-full-button" onClick={() => onMutate(group ? { action: 'updateGroup', id: group.id, patch: { archived: !group.archived } } : { action: 'archiveBot', id: bot.id, archived: !bot.archived })}><Icon name="archive" size={14}/>{bot?.archived || group?.archived ? '恢复' : '归档'}</button>{(bot?.archived || group?.archived) && <button type="button" className="dt-button dt-full-button dt-danger-button" onClick={() => { if (window.confirm(group ? '删除群组及群聊记录？' : '删除 Bot 及其记忆并保留原生会话？')) onMutate({ action: group ? 'deleteGroup' : 'deleteBot', id: group?.id || bot?.id }); }}>删除</button>}</div>}
    </div>
  </aside>;
}

function TeamPage({ controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const workspace = state.workspace;
  const [query, setQuery] = useState(''), [drafts, setDrafts] = useState({}), [modal, setModal] = useState(null), [newMenu, setNewMenu] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [panel, setPanel] = useState(() => { try { return window.innerWidth >= 1100 && localStorage.getItem('dsh-bot:v4:panel') === 'open'; } catch { return false; } }), [panelTab, setPanelTab] = useState('work'), [rosterOpen, setRosterOpen] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { try { localStorage.setItem('dsh-bot:v4:panel', panel ? 'open' : 'closed'); } catch {} }, [panel]);
  const [searchMessages, setSearchMessages] = useState(false), [messageQuery, setMessageQuery] = useState('');
  const [historySearch, setHistorySearch] = useState({ loading: false, error: false }), [searchRetry, setSearchRetry] = useState(0);
  const searchOperation = useRef(null);
  const [scrollAway, setScrollAway] = useState(false), [hasUnseen, setHasUnseen] = useState(false);
  const [motionPaused, setMotionPaused] = useState(() => { try { return localStorage.getItem('dsh-bot:v3:motion') === 'paused'; } catch { return false; } });
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  useEffect(() => { const update = () => setPageHidden(document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  function toggleMotion() { setMotionPaused(value => { try { localStorage.setItem('dsh-bot:v3:motion', value ? 'live' : 'paused'); } catch {} return !value; }); }
  const input = useRef(null), transcript = useRef(null), following = useRef(true), submitting = useRef(new Set()), scrollState = useRef(null), selectedKey = state.selected ? `${state.selected.kind}:${state.selected.id}` : 'home';
  const bot = state.selected?.kind === 'bot' ? workspace.bots.find(b => b.id === state.selected.id) : null;
  const group = state.selected?.kind === 'group' ? workspace.groups.find(g => g.id === state.selected.id) : null;
  const title = bot?.name || group?.name || '你的 Bot 团队';
  const archived = !!(bot?.archived || group?.archived);
  const groupPresences = group ? membersOf(group).map(id => state.botPresence?.[id]).filter(Boolean) : [];
  const presence = bot ? presenceFor(state, bot) : deriveTeamPresence(groupPresences);
  const draft = drafts[selectedKey] || '';
  const messages = group ? (group.messages || []) : (state.conversation?.messages || []);
  const matchingMessages = searchMessages && messageQuery.trim() ? messages.filter(m => displayBotText(m.text).toLowerCase().includes(messageQuery.trim().toLowerCase())) : messages;
  const activeIds = group ? membersOf(group) : bot ? [bot.id] : [];
  const activeJobs = activeIds.filter(id => state.jobs[id]);
  const selectedPresences = activeIds.map(id => state.botPresence?.[id]).filter(Boolean);
  const trackedWork = activeJobs.length > 0 || !!state.conversation?.running || !!state.conversation?.needsAttention;
  const canStop = activeJobs.length > 0 || (!!bot && (!!state.conversation?.running || !!state.conversation?.needsAttention));
  const queuedWork = activeJobs.length > 0 && activeJobs.every(id => state.jobs[id]?.status === 'queued');
  const working = trackedWork || selectedPresences.some(p => p.source !== 'run' && (BUSY_STATES.has(p.state) || p.state === 'waiting'));
  const needsAttention = !!state.conversation?.needsAttention || activeIds.some(id => state.jobs[id]?.status === 'waiting') || selectedPresences.some(p => p.state === 'waiting' && p.source !== 'run');
  const attentionBot = workspace.bots.find(b => activeIds.includes(b.id) && state.botPresence?.[b.id]?.state === 'waiting' && state.botPresence[b.id].source !== 'run');
  const nativeSessionId = attentionBot?.sessionId || bot?.sessionId || state.conversation?.sessionId || workspace.bots.find(b => activeIds.includes(b.id) && b.sessionId)?.sessionId || null;
  const filteredBots = workspace.bots.filter(b => b.archived === showArchived && (!query || b.name.toLowerCase().includes(query.toLowerCase()) || b.role?.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => (b.id === workspace.primaryBotId ? 1 : 0) - (a.id === workspace.primaryBotId ? 1 : 0));
  const filteredGroups = workspace.groups.filter(g => !!g.archived === showArchived && (!query || g.name.toLowerCase().includes(query.toLowerCase())));
  useEffect(() => () => { searchOperation.current?.abort(); }, [selectedKey]);
  useEffect(() => {
    if (!searchMessages || !messageQuery.trim() || !bot || (!state.conversation?.hasMore && state.conversation)) { setHistorySearch({ loading: false, error: false }); return; }
    const abort = new AbortController(); searchOperation.current?.abort(); searchOperation.current = abort;
    setHistorySearch({ loading: true, error: false });
    const timer = setTimeout(async () => {
      try {
        await collectConversationMessages(controller, { key: selectedKey, signal: abort.signal });
        if (!abort.signal.aborted) { setHistorySearch({ loading: false, error: false }); }
      } catch (error) { if (!abort.signal.aborted && error.name !== 'AbortError') { setHistorySearch({ loading: false, error: error.message }); controller.report(error); } }
    }, 220);
    return () => { clearTimeout(timer); abort.abort(); if (searchOperation.current === abort) searchOperation.current = null; };
  }, [selectedKey, searchMessages, messageQuery, searchRetry]);
  function updateMessageQuery(value) { if (historySearch.error && state.error === historySearch.error) controller.clearError(); setMessageQuery(value); if (value.trim() && bot && (!state.conversation || state.conversation.hasMore)) setHistorySearch({ loading: true, error: false }); }
  function closeModal() { setModal(null); }
  async function mutateFromPanel(request) {
    await controller.mutate(request);
    const selected = controller.getSnapshot().selected;
    if (request.action === 'archiveBot' && selected?.kind === 'bot' && selected.id === request.id) { setShowArchived(request.archived !== false); setQuery(''); }
    if (request.action === 'updateGroup' && selected?.kind === 'group' && selected.id === request.id && typeof request.patch?.archived === 'boolean') { setShowArchived(request.patch.archived); setQuery(''); }
    if ((request.action === 'deleteBot' && selected?.kind === 'bot' || request.action === 'deleteGroup' && selected?.kind === 'group') && selected.id === request.id) { await controller.select('home', null); setShowArchived(false); setQuery(''); }
  }
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(t); }, [notice]);
  useLayoutEffect(() => {
    const el = transcript.current;
    if (!el) { scrollState.current = null; return; }
    const next = { key: selectedKey, first: matchingMessages[0]?.id, last: matchingMessages.at(-1)?.id, lastText: matchingMessages.at(-1)?.text, count: matchingMessages.length, searching: searchMessages, query: messageQuery };
    const plan = planTranscriptScroll(scrollState.current, next, following.current, el.scrollHeight);
    if (plan.action === 'latest') { following.current = true; el.scrollTop = el.scrollHeight; setHasUnseen(false); setScrollAway(false); }
    else if (plan.action === 'start') el.scrollTop = 0;
    else if (plan.action === 'preserve') el.scrollTop = plan.top;
    if (plan.unseen) setHasUnseen(true);
    scrollState.current = { ...next, top: el.scrollTop, height: el.scrollHeight };
  }, [selectedKey, searchMessages, messageQuery, matchingMessages.length, matchingMessages[0]?.id, matchingMessages.at(-1)?.id, matchingMessages.at(-1)?.text]);
  useLayoutEffect(() => {
    const el = input.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), 180)}px`;
    el.style.overflowY = el.scrollHeight > 180 ? 'auto' : 'hidden';
    if (following.current && !searchMessages && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [draft, selectedKey]);
  function readScroll() {
    const el = transcript.current; if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
    setScrollAway(!following.current); if (following.current) setHasUnseen(false);
    if (scrollState.current) Object.assign(scrollState.current, { top: el.scrollTop, height: el.scrollHeight });
  }
  function latest() { following.current = true; if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; setScrollAway(false); setHasUnseen(false); }
  function closeMessageSearch() { searchOperation.current?.abort(); searchOperation.current = null; setSearchMessages(false); setMessageQuery(''); setHistorySearch({ loading: false, error: false }); }
  useEffect(() => {
    const handler = e => {
      if (e.isComposing || modal) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setModal({ type: 'bot' }); }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setRosterOpen(true); const field = document.querySelector('.dt-roster-search input'); field?.focus(); field?.select(); }
      if (e.key === 'Escape' && !modal) { if (newMenu) setNewMenu(false); else if (rosterOpen) setRosterOpen(false); else if (searchMessages) closeMessageSearch(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [modal, newMenu, rosterOpen, searchMessages]);
  useEffect(() => { if (!newMenu) return; const close = e => { if (!e.target?.closest?.('.dt-new-control')) setNewMenu(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [newMenu]);
  async function safe(operation) { try { return await operation(); } catch (error) { controller.report(error); } }
  function select(kind, id) { controller.select(kind, id); setRosterOpen(false); setNewMenu(false); closeMessageSearch(); }
  async function send(e) {
    e?.preventDefault(); if (archived || !draft.trim() || state.pending || working || submitting.current.has(selectedKey)) return;
    const text = draft, key = selectedKey; submitting.current.add(key); latest();
    try { const task = await controller.send(text); await task?.admitted; setDrafts(values => consumeSubmittedDraft(values, key, text)); }
    catch (error) { controller.report(error); }
    finally { submitting.current.delete(key); }
  }
  function openTask(task) { const target = taskDestination(task, workspace); if (!target) return; if (target.kind === 'native') return native(target.sessionId); setShowArchived(target.archived); setQuery(''); select(target.kind, target.id); }
  function native(sessionId) { return safe(() => controller.openNative(sessionId || nativeSessionId)); }
  function memory(value) { setModal({ type: 'memory', memory: value?.id && value?.content ? value : null, bot: value?.botId ? workspace.bots.find(b => b.id === value.botId) : bot, content: typeof value === 'string' ? value : '' }); }
  function edit() { setModal({ type: group ? 'group' : 'bot', ...(group ? { group } : { bot }) }); }
  function copy(text) { safe(async () => { await navigator.clipboard.writeText(text); setNotice('已复制'); }); }
  const section = (label, children, action) => <section className="dt-roster-section"><div className="dt-roster-heading"><span>{label}</span>{action}</div>{children}</section>;
  return <section className="dt-app dt-minimal" data-theme={workspace.settings.theme} data-bot-motion={motionPaused || pageHidden ? 'paused' : 'live'} aria-label="dsh-bot AI 同事团队">
    <aside className={`dt-roster ${rosterOpen ? 'dt-roster-open' : ''}`} aria-label="Bot 名册">
      <header className="dt-roster-top"><button type="button" className="dt-brand" onClick={() => select('home', null)}><strong>dsh-bot</strong></button><div className="dt-new-control"><Action icon="plus" label="新建 Bot 或群组" onClick={() => setNewMenu(v => !v)} aria-expanded={newMenu}/>{newMenu && <div className="dt-popover"><button type="button" onClick={() => { setModal({ type: 'bot' }); setNewMenu(false); }}>新建 Bot</button><button type="button" disabled={workspace.bots.filter(b => !b.archived).length < 1} onClick={() => { setModal({ type: 'group' }); setNewMenu(false); }}>新建群组</button></div>}</div></header>
      <div className="dt-roster-search"><Icon name="search" size={15}/><input aria-label="搜索 Bot 和群组" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索"/>{query && <Action icon="close" label="清空团队搜索" onClick={() => setQuery('')}/>}</div>
      <button type="button" className={`dt-nav-home ${state.selected?.kind === 'home' || !state.selected ? 'dt-nav-selected' : ''}`} onClick={() => select('home', null)}><Icon name="home"/>概览</button>
      <div className="dt-roster-scroll">
        {section(showArchived ? '已归档' : 'Bot', <nav>{filteredBots.map(b => <button type="button" key={b.id} className={`dt-bot-row ${bot?.id === b.id ? 'dt-bot-selected' : ''}`} aria-current={bot?.id === b.id ? 'page' : undefined} onClick={() => select('bot', b.id)}><Avatar bot={b} size={40} presence={presenceFor(state, b)} interactive/><span className="dt-bot-row-copy"><strong>{b.name}{workspace.primaryBotId === b.id && <small className="dt-primary-label">主</small>}</strong><small className={`dt-roster-presence dt-presence-${presenceFor(state, b).state}`}><span className="dt-presence-light"/>{presenceFor(state, b).label}</small></span></button>)}{!filteredBots.length && <p className="dt-roster-empty">{query ? '无匹配结果' : '暂无 Bot'}</p>}</nav>, <Action icon="plus" label="创建 Bot" onClick={() => setModal({ type: 'bot' })}/>)}
        {section('群组', <nav>{filteredGroups.map(g => { const gp = deriveTeamPresence(membersOf(g).map(id => state.botPresence?.[id]).filter(Boolean)); return <button type="button" key={g.id} className={`dt-bot-row ${group?.id === g.id ? 'dt-bot-selected' : ''}`} aria-current={group?.id === g.id ? 'page' : undefined} onClick={() => select('group', g.id)}><Avatar group size={40} presence={gp}/><span className="dt-bot-row-copy"><strong>{g.name}</strong><small>{membersOf(g).length} 位 · {gp.label}</small></span></button>; })}{!filteredGroups.length && (query ? <p className="dt-roster-empty">无匹配结果</p> : <button type="button" className="dt-empty-group" disabled={workspace.bots.filter(b => !b.archived).length < 1} onClick={() => setModal({ type: 'group' })}><Icon name="plus" size={13}/>新建群组</button>)}</nav>)}
      </div>
      <footer className="dt-roster-bottom"><button type="button" onClick={() => setShowArchived(v => !v)}><Icon name="archive"/>{showArchived ? '返回团队' : '归档'}</button><div className="dt-account"><span className="dt-account-avatar">我</span><span><strong>工作空间</strong></span><Action icon="gear" label="工作空间设置" onClick={() => setModal({ type: 'settings' })}/></div></footer>
    </aside>
    {rosterOpen && <button type="button" aria-label="收起 Bot 名册" className="dt-drawer-shade" onClick={() => setRosterOpen(false)}/>}
    <main className="dt-main">
      <header className="dt-chat-header"><Action icon="menu" label="打开 Bot 名册" className="dt-mobile-menu dt-icon-button" onClick={() => setRosterOpen(true)}/>{bot || group ? <>
        <button type="button" className="dt-conversation-title" onClick={edit}><Avatar bot={bot} group={!!group} size={42} presence={presence} interactive/><span><strong>{title}<Icon name="down" size={12}/></strong><small className={`dt-roster-presence dt-presence-${presence.state}`}><span className="dt-presence-light"/>{presence.label}</small></span></button>
        <div className="dt-header-actions"><Action icon="search" label="搜索当前对话" aria-expanded={searchMessages} onClick={() => { setSearchMessages(v => !v); setMessageQuery(''); }}/><Action icon="external" label="打开 DSH 原生会话" onClick={() => native()} disabled={!nativeSessionId}/><Action icon="panel" label={panel ? '收起工作侧栏' : '打开工作侧栏'} onClick={() => setPanel(v => !v)} aria-expanded={panel}/></div>
      </> : <><span className="dt-home-header">概览</span><div className="dt-header-actions"></div></>}</header>
      {state.error && <div className="dt-banner dt-banner-error" role="alert"><span>{state.error}</span><Action icon="close" label="关闭错误提示" onClick={controller.clearError}/></div>}
      {notice && <div className="dt-toast" role="status">{notice}</div>}
      {state.loading && !state.loaded ? <div className="dt-loading" role="status"><span className="dt-spinner"/>加载中</div> : !bot && !group ? <div className="dt-home-scroll"><div className="dt-home-content">
        {workspace.bots.some(b => !b.archived) ? <TeamStage workspace={workspace} presences={state.botPresence} onSelect={select} onCreate={() => setModal({ type: 'bot' })}/> : <>
          <div className="dt-primary-card"><div className="dt-primary-card-art"><Avatar bot={BOT_TEMPLATES[0]} size={154} interactive/></div><div><h1>dsh-bot</h1><button type="button" aria-label="创建我的主 Bot" className="dt-button dt-button-primary" onClick={() => setModal({ type: 'bot', template: BOT_TEMPLATES[0] })}>创建 Bot<Icon name="plus" size={14}/></button></div></div>
          <div className="dt-template-grid">{BOT_TEMPLATES.slice(1).map(template => <button type="button" key={template.name} onClick={() => setModal({ type: 'bot', template })}><Avatar bot={template} size={40}/><span><strong>{template.label}</strong><small>{template.name}</small></span><Icon name="plus" size={14}/></button>)}</div>
        </>}
        {!!workspace.tasks.length && <><div className="dt-home-section-heading"><h2>最近任务</h2><span>{workspace.tasks.length}</span></div><div className="dt-home-tasks">{workspace.tasks.slice().reverse().slice(0, 8).map(task => <button type="button" key={task.id} disabled={!taskDestination(task, workspace)} onClick={() => openTask(task)}><span className={`dt-task-status dt-status-${task.status}`}><Icon name={task.status === 'completed' ? 'check' : 'clock'} size={16}/></span><span><strong>{task.title}</strong><small>{taskDestination(task, workspace)?.name || '已移除'} · {teamStatusLabel(task.status)}</small></span><Icon name="chevron" size={14}/></button>)}</div></>}
      </div></div> : <>
        {searchMessages && <div className="dt-message-search"><Icon name="search" size={15}/><input autoFocus aria-label="搜索当前对话内容" value={messageQuery} onChange={e => updateMessageQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeMessageSearch(); } }} placeholder="搜索消息"/><span role="status">{historySearch.loading ? '搜索中' : matchingMessages.length}</span>{historySearch.error && <button type="button" className="dt-button" onClick={() => { if (state.error === historySearch.error) controller.clearError(); setSearchRetry(n => n + 1); }}>重试</button>}<Action icon="close" label="结束对话搜索" onClick={closeMessageSearch}/></div>}
        <div className="dt-transcript-shell"><div ref={transcript} className={`dt-transcript ${!messages.length ? 'dt-transcript-empty' : ''}`} aria-label="持续对话" aria-busy={working} onScroll={readScroll}><div className="dt-message-column">
          {!group && !searchMessages && state.conversation?.hasMore && <div className="dt-load-older"><button type="button" className="dt-button" disabled={state.conversation.loadingOlder} onClick={() => safe(controller.loadOlder)}>{state.conversation.loadingOlder ? '加载中' : '更早消息'}</button></div>}
          {!messages.length && !searchMessages && <div className="dt-chat-welcome"><div className="dt-welcome-scene"><Avatar bot={bot} group={!!group} size={142} presence={presence} interactive/></div><h1>{title}</h1></div>}
          {searchMessages && messageQuery.trim() && !matchingMessages.length && !historySearch.loading && !historySearch.error && <div className="dt-search-empty" role="status">无匹配消息</div>}
          {matchingMessages.map((message, index) => <Message key={message.id || `${message.seq}-${index}`} message={message} bot={group ? workspace.bots.find(b => b.id === message.botId) : bot} live={!!state.conversation?.running && message.turn === state.conversation.latestTurn && message.seq > (state.conversation.lastTurnEnd?.seq || 0)} onCopy={copy} onRemember={() => memory(displayBotText(message.text))}/>)}
          {working && !searchMessages && <div className="dt-working-line" data-working-state={presence.state}><Avatar bot={bot || workspace.bots.find(b => activeIds.includes(b.id) && BUSY_STATES.has(presenceFor(state, b).state))} size={36} presence={presence}/><span>{needsAttention ? '等待处理' : presence.state === 'idle' ? '同步中' : presence.label}{presence.toolName && <code>{presence.toolName}</code>}</span>{needsAttention && <button type="button" onClick={() => native()}>处理<Icon name="external" size={12}/></button>}</div>}
        </div></div>{scrollAway && !searchMessages && <button type="button" className="dt-jump-latest" onClick={latest}><Icon name="down" size={14}/>{hasUnseen ? '新回复' : '最新消息'}</button>}</div>
        <div className="dt-compose-wrap"><form className="dt-compose" onSubmit={send}><textarea ref={input} readOnly={archived} aria-label="给 Bot 发消息" value={draft} maxLength={24000} onChange={e => setDrafts(d => ({ ...d, [selectedKey]: e.target.value }))} onKeyDown={e => { if (isSubmitKey(e)) { e.preventDefault(); send(); } }} placeholder={archived ? '已归档' : group ? '消息，@成员' : '消息'} rows={2}/><div className="dt-compose-toolbar"><div><Action icon="memory" label="添加持久记忆" onClick={memory}/>{group && <button type="button" className="dt-mention-button" disabled={archived} onClick={() => { setDrafts(d => ({ ...d, [selectedKey]: `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@everyone ` })); input.current?.focus(); }}>@everyone</button>}</div><div>{working ? <button type="button" className="dt-send-button dt-stop-button" aria-label={canStop ? queuedWork ? '停止排队任务' : '停止当前工作' : '查看原生进度'} onClick={() => canStop ? safe(() => controller.stop()) : native()}><Icon name={canStop ? 'stop' : 'external'} size={16}/></button> : <button type="submit" className="dt-send-button" aria-label="发送消息" disabled={archived || state.pending || !draft.trim()}><Icon name="arrow" size={19}/></button>}</div></div></form></div>
      </>}
    </main>
    {panel && (bot || group) && <WorkspacePanel bot={bot} group={group} state={state} tab={panelTab} setTab={setPanelTab} onEdit={edit} onMemory={memory} onNative={native} onMutate={request => safe(() => mutateFromPanel(request))} onClose={() => setPanel(false)}/>}
    {modal?.type === 'bot' && <BotEditor bot={modal.bot} template={modal.template} onClose={closeModal} onSave={async data => { if (modal.bot) await controller.mutate({ action: 'updateBot', id: modal.bot.id, patch: data }); else { await controller.createBot(data); setShowArchived(false); setQuery(''); } }}/>}
    {modal?.type === 'group' && <GroupEditor workspace={workspace} group={modal.group} onClose={closeModal} onSave={async data => { if (modal.group) await controller.mutate({ action: 'updateGroup', id: modal.group.id, patch: data }); else { await controller.createGroup(data); setShowArchived(false); setQuery(''); } }}/>}
    {modal?.type === 'memory' && <MemoryDialog bot={modal.bot} memory={modal.memory} initialContent={modal.content} onClose={closeModal} onSave={data => controller.mutate(modal.memory ? { action: 'updateMemory', id: modal.memory.id, content: data.content } : { action: 'addMemory', ...data })}/>}
    {modal?.type === 'settings' && <WorkspaceSettings Dialog={Dialog} controller={controller} workspace={workspace} bot={bot} group={group} conversation={state.conversation} messages={messages} title={title} selectedKey={selectedKey} motionPaused={motionPaused} toggleMotion={toggleMotion} onClose={closeModal} onNotice={setNotice}/>}
  </section>;
}
export const inject = ['slots', 'layout', 'sessions', 'connection', 'uiWorkspace', 'uiSession'];
export function apply(ctx) {
  const controller = createTeamController(ctx);
  ctx.effect(() => () => controller.dispose());
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshBot = 'team-v3'; style.textContent = `${BOT_CSS}\n${AVATAR_CSS}\n${POLISH_CSS}\n${MINIMAL_CSS}\n${MESSAGE_CSS}\n${TEAM_THEME_CSS}\n${THEME_CSS}`; document.head.append(style); return () => style.remove(); });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-bot', inject: () => ({ controller }) }, TeamPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-bot', order: 12, label: () => 'dsh-bot' }, ({ size = 20 }) => <Icon name="people" size={size}/>));
}
