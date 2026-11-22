// Mounted INSIDE the bot preset, never globally.
// Denies tool dispatch even if a different root plugin advertises an inherited tool.
export const inject = ['tools'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(() => 'dsh-bot is text-only. Tool execution is disabled for this agent.'));
}
