const cancelled = () => Object.assign(new Error('已取消历史读取。'), { name: 'AbortError' });
const keyOf = state => state.selected ? `${state.selected.kind}:${state.selected.id}` : 'home';
const loading = row => !row || row.loadingOlder || ['opening', 'loading'].includes(row.openState);
const identity = row => row.id || (Number.isFinite(row.seq) ? `${row.role}:${row.seq}` : `${row.role}:${row.turn ?? ''}:${row.time ?? row.createdAt ?? ''}:${row.text}`);
export function mergeTranscriptMessages(...pages) {
  const rows = new Map();
  for (const page of pages) for (const row of page || []) rows.set(identity(row), row);
  return [...rows.values()].map((row, index) => ({ row, index })).sort((a, b) => Number.isFinite(a.row.seq) && Number.isFinite(b.row.seq) ? a.row.seq - b.row.seq : a.index - b.index).map(x => x.row);
}
function awaitRead(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => done(cancelled());
    const timer = setTimeout(() => done(new Error('历史读取超时，请重试或打开原生会话。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => done(null, value), error => done(error));
    if (signal?.aborted) abort();
  });
}
function waitForReady(controller, inspect, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let off, finished = false;
    const done = error => { if (finished) return; finished = true; clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const check = () => { try { const row = inspect(); if (!loading(row)) done(); } catch (error) { done(error); } };
    const abort = () => done(cancelled());
    const timer = setTimeout(() => done(new Error('会话仍在加载，请稍后重试。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    off = controller.subscribe(check); if (finished) off(); else check();
    if (signal?.aborted) abort();
  });
}
export async function collectConversationMessages(controller, { key = keyOf(controller.getSnapshot()), signal, maxPages = 200, maxMessages = 10000, maxChars = 4000000, timeoutMs = 30000 } = {}) {
  const initial = controller.getSnapshot();
  if (signal?.aborted) throw cancelled();
  if (initial.selected?.kind !== 'bot' || keyOf(initial) !== key) throw cancelled();
  const sessionId = initial.conversation?.sessionId || initial.workspace?.bots.find(bot => bot.id === initial.selected.id)?.sessionId;
  if (!sessionId) return [];
  const inspect = () => {
    if (signal?.aborted || keyOf(controller.getSnapshot()) !== key) throw cancelled();
    const row = controller.getSnapshot().conversation;
    if (row && row.sessionId !== sessionId) throw cancelled();
    if (row?.removed || ['error', 'failed'].includes(row?.openState)) throw new Error(row.error || '原生会话无法读取。');
    return row;
  };
  let messages = [], pages = 0;
  while (true) {
    let snapshot = inspect();
    if (loading(snapshot)) { await waitForReady(controller, inspect, signal, timeoutMs); snapshot = inspect(); }
    messages = mergeTranscriptMessages(snapshot.messages);
    if (messages.length > maxMessages || messages.reduce((sum, row) => sum + String(row.text || '').length, 0) > maxChars) throw new Error('历史消息过多，请在原生会话中查看或导出。');
    if (!snapshot.hasMore) return messages;
    if (pages++ >= maxPages) throw new Error('历史尚未读取完整，请在原生会话中查看或导出。');
    const before = snapshot.firstSeq;
    await awaitRead(controller.loadOlder(), signal, timeoutMs);
    snapshot = inspect();
    if (loading(snapshot)) { await waitForReady(controller, inspect, signal, timeoutMs); snapshot = inspect(); }
    if (snapshot.hasMore && Number.isFinite(before) && Number.isFinite(snapshot.firstSeq) && snapshot.firstSeq >= before) throw new Error('历史读取未取得进展，请重试或打开原生会话。');
  }
}
export function transcriptFilename(title) {
  let value = String(title || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '');
  value = [...value].slice(0, 48).join('') || 'dsh-bot';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `dsh-bot-${value}`;
  return `${value}-chat.md`;
}
