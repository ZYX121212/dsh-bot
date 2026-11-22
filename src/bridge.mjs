import { extractResponse } from './core.mjs';

// Uses only the authenticated DSH client service faces. No keys or custom HTTP server.
export function createDshBridge(ctx) {
  let active = null;
  let disposed = false;
  return {
    async run(prompt, callbacks = {}) {
      if (disposed) throw new Error('插件已卸载，请刷新页面。');
      if (active) throw new Error('已有一条回答正在生成。');
      const token = { ref: null, session: null, stop: false, closed: false, off: [], timer: null, reject: null };
      active = token;
      const clean = () => {
        token.closed = true;
        for (const off of token.off.splice(0)) off();
        clearTimeout(token.timer);
        token.ref?.release();
        if (active === token) active = null;
      };
      try {
        const sessionId = await ctx.sessions.create({ agentPreset: 'dsh-bot' });
        if (token.stop || disposed) throw new Error('已停止。');
        token.ref = ctx.sessions.retain(sessionId, { source: 'dsh-bot' });
        const binding = await token.ref.ready;
        token.session = binding.session;
        if (token.stop || disposed) throw new Error('已停止。');
        callbacks.onSession?.(sessionId);
        const completion = new Promise((resolve, reject) => {
          token.reject = reject;
          const check = () => {
            if (token.closed) return;
            const result = extractResponse(binding.eventSource.getSnapshot().entries);
            callbacks.onUpdate?.(result.text);
            if (result.ended) resolve(result);
            else {
              const state = binding.session.getSnapshot();
              if (state.lastAgentError) reject(new Error(state.lastAgentError));
              else if (state.openError) reject(new Error(state.openError.message ?? '会话连接失败。'));
            }
          };
          token.off.push(binding.eventSource.subscribe(check), binding.session.subscribe(check));
          token.timer = setTimeout(() => { token.session.cancel().catch(() => {}); reject(new Error('生成超过 5 分钟，已请求停止。请检查模型连接后重试。')); }, 300000);
          check();
        });
        // Always attach a handler before admission, which may itself reject.
        completion.catch(() => {});
        const receipt = await token.session.prompt([{ type: 'text', text: prompt }], 'queue');
        if (!receipt.ok) throw new Error(receipt.error?.message ?? 'DSH 未接受本次请求。');
        if (token.stop && !disposed) await token.session.cancel();
        const result = await completion;
        if (result.reason && !['completed', 'complete', 'stop'].includes(result.reason)) {
          // Preserve partial answers for cancelled or failed turns.
          return { ...result, sessionId, stopped: token.stop || result.reason === 'cancelled' || result.reason === 'aborted' };
        }
        return { ...result, sessionId, stopped: token.stop };
      } finally { clean(); }
    },
    async stop() {
      if (!active) return;
      active.stop = true;
      if (active.session) {
        const result = await active.session.cancel();
        if (!result.ok) throw new Error(result.error?.message ?? '停止失败。');
      }
    },
    dispose() {
      disposed = true;
      if (active) {
        active.stop = true;
        active.session?.cancel().catch(() => {});
        active.reject?.(new Error('插件已卸载，生成已请求停止。'));
      }
    }
  };
}
