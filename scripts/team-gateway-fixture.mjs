import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection';
import { BotWorkspaceService } from '../lib/host-service.js';

/**
 * Exercise the built Host service through the real public Gateway and
 * Connection Fetch carrier without binding a socket or starting native work.
 * The caller owns the supplied isolated WorkspaceStore and its cleanup.
 */
export async function createWorkspaceGatewayFixture(store) {
  const ctx = new Context();
  const records = new Map();
  let owner, disposal, disposed = false;
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      try { await owner?.dispose(); }
      finally {
        try { await ctx.fiber.dispose(); }
        finally { records.clear(); }
      }
    })();
    return disposal;
  }
  try {
    // Connection initializes its own signing record against this empty,
    // ephemeral provider. Never inspect an installed profile or credentials.
    ctx.provide('credentials');
    ctx.set('credentials', {
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      }
    });
    await applyConnection(ctx);
    new TypertRegistry(ctx);
    new RemoteAccessService(ctx);
    new TypertGatewayService(ctx, {});
    new BotWorkspaceService(ctx, store);
    await ctx.fiber.await();
    // This is an isolated in-process Host. Mint a real lifetime-scoped owner
    // through the public API, never a fabricated invocation or live credential.
    owner = ctx.connection.createPeer({ principal: { kind: 'owner' } });
    const handler = ctx.connection.createSharedFetchHandler('/api');
    return {
      async call(channel, endpoint, payload) {
        assert.equal(disposed, false, 'Workspace Gateway fixture is disposed');
        assert.equal(channel, '/api', 'Workspace metadata uses the shared API channel');
        const rpcId = randomUUID();
        const response = await handler.fetch(new Request(`http://gateway.test${channel}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
        }), owner);
        assert.equal(response.status, 200, `Connection must dispatch ${endpoint} to Gateway`);
        const envelope = await response.json();
        assert.equal(envelope.type, 'server-response');
        assert.equal(envelope.rpcId, rpcId);
        assert.equal(typeof envelope.result?.ok, 'boolean', 'Connection must return a RemoteResult');
        return envelope.result;
      },
      dispose
    };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Workspace Gateway fixture construction and cleanup failed'); }
    throw error;
  }
}
