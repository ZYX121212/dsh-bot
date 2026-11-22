import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { WorkspaceStore, WorkspaceError } from './host-store.mjs';

const remoteInitializers = [];
/**
 * Authenticated owner-only metadata endpoint; no model calls or elevated peers.
 * Wire: botWorkspace/read {args:{}} and botWorkspace/update {args:{request:{action,...}}}.
 * Both return the full snapshot through the native RemoteResult carrier.
 */
export class BotWorkspaceService extends TypertRemoteService {
  static inject = ['typertGateway'];
  constructor(ctx, store) {
    super(ctx, 'botWorkspace');
    for (const initialize of remoteInitializers) initialize.call(this);
    this.store = store ?? new WorkspaceStore(dshHomePath('storages', 'dsh-bot', 'workspace.json'));
  }
  requireOwner(method) {
    // Explicitly deny direct/root and non-owner invocations too. The Gateway's
    // native policy is an additional boundary; we never create/promote a peer.
    if (this.ctx.invocation?.peer?.principal?.kind !== 'owner') {
      throw new RemoteError('remote-access/denied', 'Only the authenticated DSH owner may access the Bot workspace.', { action: `botWorkspace/${method}`, reason: 'owner-required' });
    }
  }
  async read() {
    this.requireOwner('read');
    try { return await this.store.read(); } catch (error) { throw workspaceRemoteError(error); }
  }
  async update(request) {
    this.requireOwner('update');
    try { return await this.store.update(request); } catch (error) { throw workspaceRemoteError(error); }
  }
}
function workspaceRemoteError(error) {
  if (error instanceof WorkspaceError) return new RemoteError(`bot-workspace/${error.code}`, error.message, {});
  // Never include host filesystem paths, stack traces, or raw IO errors on RPC.
  return new RemoteError('bot-workspace/storage-error', 'Bot workspace storage is unavailable. Check the host logs and storage permissions.', {});
}
// Apply the SDK's standard stage-3 method markers from plain JavaScript. This
// uses the public Remote API, not a fabricated private descriptor or TS compiler.
for (const method of ['read', 'update']) {
  Remote(BotWorkspaceService.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(initialize) { remoteInitializers.push(initialize); }
  });
}
export const name = 'dsh-bot-host';
export const inject = ['typertGateway'];
export function apply(ctx) { new BotWorkspaceService(ctx); }
