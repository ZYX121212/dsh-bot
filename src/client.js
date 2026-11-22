// Built into the DSH lazy-CJS module factory; React is supplied by the host.
const React = require('react');
const h = React.createElement;
const { useState, useRef, useEffect } = React;
const STORAGE_KEY = 'dsh-bot:v1:records';
function loadRecords() { try { return sanitizeRecords(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { return []; } }
function download(records) {
  const url = URL.createObjectURL(new Blob([exportMarkdown(records)], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `dsh-bot-${new Date().toISOString().slice(0, 10)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function linkedText(text) {
  return text.split(/(https?:\/\/[^\s<>"\u3000]+)/g).map((part, i) => /^https?:\/\//.test(part)
    ? h('a', { key: i, href: part.replace(/[)\]。，；]+$/, ''), target: '_blank', rel: 'noreferrer noopener' }, part) : part);
}
function BotPage({ bridge }) {
  const [records, setRecords] = useState(loadRecords);
  const [selected, setSelected] = useState(null);
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [mode, setMode] = useState('ask');
  const [tone, setTone] = useState('balanced');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [starred, setStarred] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mobileHistory, setMobileHistory] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const input = useRef(null);
  const current = records.find(r => r.id === selected);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (busyRef.current) bridge.stop().catch(() => {}); }; }, [bridge]);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { setError('浏览器存储空间不足，记录暂未保存。请先导出。'); } }, [records]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const patch = (id, data) => { if (mounted.current) setRecords(rows => rows.map(r => r.id === id ? { ...r, ...data } : r)); };
  function reset() { if (busyRef.current) return; setSelected(null); setQuestion(''); setContext(''); setShowContext(false); setError(''); setMobileHistory(false); input.current?.focus(); }
  function select(record) { if (busyRef.current) return; setSelected(record.id); setQuestion(record.question); setContext(record.context); setShowContext(!!record.context); setMode(record.mode); setTone(record.tone); setError(''); setMobileHistory(false); }
  async function send() {
    if (busyRef.current) return;
    let data; try { data = normalizeInput({ question, context, mode, tone }); } catch (e) { setError(e.message); input.current?.focus(); return; }
    const record = { ...data, id: crypto.randomUUID(), createdAt: Date.now(), status: 'running', answer: '', error: '', starred: false };
    busyRef.current = true; setBusy(true); setError(''); setSelected(record.id);
    setRecords(rows => [record, ...rows].slice(0, LIMITS.records));
    let lastText = '';
    try {
      const result = await bridge.run(buildPrompt(data), {
        onSession: sessionId => patch(record.id, { sessionId }),
        onUpdate: answer => { if (answer !== lastText) { lastText = answer; patch(record.id, { answer }); } }
      });
      if (!result.text && !result.stopped) throw new Error(`模型未返回文字（${result.reason ?? '未知结束原因'}）。请检查 DSH 模型配置后重试。`);
      const failed = ['error', 'failed', 'blocked', 'interrupted', 'forked', 'input-required', 'max-steps', 'max-tokens'].includes(result.reason);
      patch(record.id, { answer: result.text, status: result.stopped ? 'stopped' : failed ? 'error' : 'done', error: failed ? `会话结束原因：${result.reason}` : '' });
    } catch (e) { patch(record.id, { status: 'error', error: e.message || '生成失败，请稍后重试。' }); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop() { try { await bridge.stop(); setNotice('已请求停止，正在保留已生成的文字。'); } catch (e) { setError(e.message); } }
  async function copy(text) { try { await navigator.clipboard.writeText(text); setNotice('已复制到剪贴板'); } catch { setError('剪贴板不可用，请选中文字复制或导出。'); } }
  const visible = records.filter(r => (!starred || r.starred) && `${r.question} ${r.answer}`.toLowerCase().includes(filter.toLowerCase()));
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
  return h('section', { className: 'dsb', 'aria-label': 'dsh-bot 工作台' },
    h('header', { className: 'dsb-header' }, h('div', { className: 'dsb-mark', 'aria-hidden': true }, '↗'), h('div', null, h('div', { className: 'dsb-brand' }, 'dsh-bot'), h('div', { className: 'dsb-tag' }, 'A LITTLE CURIOUS. A LOT CAPABLE.')),
      h('div', { className: 'dsb-header-actions' }, btn('历史', () => setMobileHistory(v => !v), { className: 'dsb-mobile-history', 'aria-expanded': mobileHistory }), btn('导出', () => download(records), { disabled: !records.length, title: '导出全部本地对话为 Markdown' }), btn('设置', () => setSettings(v => !v), { 'aria-expanded': settings }))),
    h('div', { className: 'dsb-body' },
      h('aside', { className: `dsb-rail ${mobileHistory ? 'dsb-open' : ''}`, 'aria-label': '对话历史' },
        btn('＋  新的提问', reset, { className: 'dsb-primary', disabled: busy }),
        h('input', { className: 'dsb-search', placeholder: '搜索对话…', 'aria-label': '搜索对话', value: filter, onChange: e => setFilter(e.target.value) }),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', { className: 'dsb-small' }, `本地记录 · ${records.length}`), btn(starred ? '★ 收藏' : '☆ 收藏', () => setStarred(v => !v), { 'aria-pressed': starred, style: { fontSize: 11, padding: '3px 7px' } })),
        h('nav', { className: 'dsb-history' }, visible.length ? visible.map(r => btn(h(React.Fragment, null, h('div', { className: 'dsb-history-title' }, r.starred ? `★ ${r.question}` : r.question), h('div', { className: 'dsb-history-meta' }, `${MODES.find(m => m.id === r.mode)?.label} · ${new Date(r.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}${r.status === 'running' ? ' · 生成中' : ''}`)), () => select(r), { key: r.id, disabled: busy, 'aria-current': selected === r.id ? 'true' : undefined })) : h('div', { className: 'dsb-empty' }, records.length ? '没有匹配的对话。' : '你的好问题，会留在这里。')),
        h('div', { className: 'dsb-privacy' }, '仅在你点击发送时调用模型。', h('br'), '本地历史存于此浏览器；DSH 会话由宿主管理。')),
      h('main', { className: 'dsb-main' }, h('div', { className: 'dsb-content' },
        settings && h('section', { className: 'dsb-settings', 'aria-label': '设置与隐私' }, h('h2', null, '你的 Bot，你做主。'), h('p', null, '模型：复用 DSH 默认模型，不需要在插件中填写 API Key。每次提问使用独立会话，避免串入其他对话。'), h('p', null, '权限：专用 dsh-bot 预设禁用全部工具，仅生成文字。不自动搜索、不执行代码、不对外发布；事实核查会明确说明证据限制。'), h('p', null, `历史：当前浏览器最多保留 ${LIMITS.records} 条。清除本地记录不会删除 DSH 宿主会话，也不会停止宿主的保留策略。`), btn('清除本地记录', () => { if (window.confirm('清除当前浏览器的全部 dsh-bot 记录？DSH 宿主会话不会删除。建议先导出。')) { setRecords([]); reset(); } }, { disabled: busy })),
        h('div', { className: 'dsb-eyebrow' }, h('span', { className: 'dsb-dot' }), 'YOUR ON-DEMAND THINKING PARTNER'),
        h('h1', null, '有问题？', h('br'), '叫一声 @dsh-bot。'),
        h('p', { className: 'dsb-intro' }, '一个随叫随到的思考搭子。问清楚、看明白，再说得漂亮。'),
        h('div', { className: 'dsb-modes', 'aria-label': '选择任务模式' }, MODES.map(m => btn(h(React.Fragment, null, h('span', { className: 'dsb-mode-icon', 'aria-hidden': true }, m.icon), h('span', { className: 'dsb-mode-name' }, m.label), h('span', { className: 'dsb-mode-hint' }, m.hint)), () => setMode(m.id), { key: m.id, 'aria-pressed': mode === m.id, disabled: busy }))),
        h('form', { className: 'dsb-composer', onSubmit: e => { e.preventDefault(); send(); } },
          h('div', { className: 'dsb-composer-head' }, h('span', { className: 'dsb-dot' }), '@dsh-bot', h('span', { className: 'dsb-small' }, '提问即唤起')),
          h('textarea', { ref: input, 'aria-label': '向 dsh-bot 提问', placeholder: '这个说法靠谱吗？帮我看看…', value: question, maxLength: LIMITS.question, disabled: busy, onChange: e => setQuestion(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } } }),
          showContext && h('div', { className: 'dsb-context' }, h('label', { htmlFor: 'dsb-source' }, '引用原文 · 只分析这次提供的内容'), h('textarea', { id: 'dsb-source', value: context, disabled: busy, maxLength: LIMITS.context, placeholder: '粘贴文章、帖子或需要回复的内容。链接本身不会被自动抓取。', onChange: e => setContext(e.target.value) })),
          h('div', { className: 'dsb-composer-foot' }, btn(showContext ? '− 收起原文' : '＋ 引用原文', () => setShowContext(v => !v), { disabled: busy }), h('div', { className: 'dsb-tone', 'aria-label': '选择回答风格' }, TONES.map(t => btn(t.label, () => setTone(t.id), { key: t.id, 'aria-pressed': tone === t.id, disabled: busy }))), busy ? btn('■ 停止', stop) : h('button', { type: 'submit', className: 'dsb-primary', disabled: !question.trim() }, '发送 ↗'))),
        h('div', { className: 'dsb-bottom-note' }, h('span', null, 'Enter 发送 · Shift + Enter 换行'), h('span', null, 'AI 可能出错 · 无自动联网 · 不自动发布')),
        !current && h('div', { className: 'dsb-suggestions' }, ['把这段内容总结成三个重点', '帮我区分这个说法里的事实和观点', '写一条有趣但不冒犯的回复'].map((s, i) => btn(s, () => { setQuestion(s); setMode(['summarize', 'verify', 'reply'][i]); setShowContext(true); input.current?.focus(); }, { key: s, disabled: busy }))),
        error && h('div', { className: 'dsb-error', role: 'alert' }, error),
        notice && h('div', { className: 'dsb-notice', role: 'status' }, notice),
        current && h('article', { 'aria-label': 'dsh-bot 回答', 'aria-busy': current.status === 'running' },
          h('div', { className: 'dsb-divider' }), h('div', { className: 'dsb-answer-head' }, h('span', { className: 'dsb-mark', 'aria-hidden': true }, '↗'), 'dsh-bot', h('span', { className: 'dsb-badge' }, ({ running: '正在思考', done: '回答完成', error: '生成失败', stopped: '已停止', interrupted: '上次会话中断' })[current.status])),
          current.answer ? h('div', { className: 'dsb-answer-text' }, linkedText(current.answer)) : current.status === 'running' ? h('div', { className: 'dsb-loading', role: 'status' }, '正在连接 DSH 模型，想一想…') : null,
          current.error && h('div', { className: 'dsb-error', role: 'alert' }, current.error),
          current.status === 'interrupted' && h('p', { className: 'dsb-small' }, '页面关闭或刷新中断了跟踪。已保留文字；宿主会话可能仍在运行。'),
          h('div', { className: 'dsb-answer-actions' }, btn('复制回答', () => copy(current.answer), { disabled: !current.answer }), btn(current.starred ? '★ 已收藏' : '☆ 收藏', () => patch(current.id, { starred: !current.starred }), { 'aria-pressed': current.starred }), btn('导出这一条', () => download([current])), btn('重新生成', send, { disabled: busy }), btn('删除本地记录', () => { if (window.confirm('删除这条本地记录？DSH 宿主会话不会删除。')) { setRecords(rows => rows.filter(r => r.id !== current.id)); reset(); } }, { disabled: busy })),
          current.sessionId && h('p', { className: 'dsb-small' }, `DSH 会话：${current.sessionId}`))))));
}
const inject = ['slots', 'layout', 'sessions'];
function apply(ctx) {
  const bridge = createDshBridge(ctx);
  ctx.effect(() => () => bridge.dispose());
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshBot = 'true'; style.textContent = BOT_CSS; document.head.append(style); return () => style.remove(); });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-bot', inject: () => ({ bridge }) }, BotPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-bot', order: 12, label: () => 'dsh-bot' }, ({ size = 20 }) => h('span', { style: { fontSize: size, lineHeight: 1 }, 'aria-hidden': true }, '↗')));
}
