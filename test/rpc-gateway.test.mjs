import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore, createEmptyWorkspace } from '../src/host-store.mjs';
import { createTeamController } from '../src/team-controller.mjs';

// Match host-store.test.mjs's explicit SDK override, but never skip this wire
// regression: npm ci must install the public SDK test dependencies in CI.
const SDK_ROOT = process.env.DSH_SDK_ROOT || fileURLToPath(new URL('../node_modules/@deepseek-ai', import.meta.url));
const sdkUrl = name => pathToFileURL(join(SDK_ROOT, name, 'lib/index.js')).href;
async function publicSdk() {
  const packages = ['cordis', 'dsh-typert-protocol', 'dsh-home-paths', 'dsh-api-gateway', 'dsh-typert-registry', 'dsh-api-remote-access', 'dsh-client-connection'];
  for (const name of packages) {
    await assert.doesNotReject(access(join(SDK_ROOT, name, 'lib/index.js')),
      `Missing public SDK @deepseek-ai/${name}; install the pinned SDK devDependencies or set DSH_SDK_ROOT (this regression must not be skipped).`);
  }
  // Load the real service with the same SDK instance as Gateway/Cordis when a
  // developer explicitly selects an installed DSH runtime rather than npm peers.
  let source = await readFile(new URL('../src/host-service.js', import.meta.url), 'utf8');
  source = source.replace("'@deepseek-ai/dsh-typert-protocol'", JSON.stringify(sdkUrl('dsh-typert-protocol')))
    .replace("'@deepseek-ai/dsh-home-paths'", JSON.stringify(sdkUrl('dsh-home-paths')))
    .replace("'./host-store.mjs'", JSON.stringify(new URL('../src/host-store.mjs', import.meta.url).href));
  const [cordis, gateway, registry, accessControl, connection, service] = await Promise.all([
    import(sdkUrl('cordis')), import(sdkUrl('dsh-api-gateway')), import(sdkUrl('dsh-typert-registry')),
    import(sdkUrl('dsh-api-remote-access')), import(sdkUrl('dsh-client-connection')),
    import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${randomUUID()}`)
  ]);
  return { ...cordis, ...gateway, ...registry, ...accessControl, connection, ...service };
}

const legacyMessage = 'Remote payload must contain exactly one plain-object args field';

test('real public Gateway enforces args envelope for controller read/create/update and owner-only workspace access', { timeout: 15000 }, async t => {
  const sdk = await publicSdk();
  const base = await mkdtemp(join(tmpdir(), 'dsh-bot-rpc-gateway-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert.ok(base.startsWith(join(tmpdir(), 'dsh-bot-rpc-gateway-test-')));
    await rm(base, { recursive: true, force: true });
  });
  const file = join(base, 'workspace.json'), store = new WorkspaceStore(file);
  const ctx = new sdk.Context();
  t.after(() => ctx.fiber.dispose());
  // Connection needs a signing-record provider even with no HTTP listener.
  // This isolated record starts empty and lives only in memory: no installed
  // profile, token, cookie or real credential is read or scraped by this test.
  const records = new Map();
  ctx.provide('credentials');
  ctx.set('credentials', {
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    }
  });
  await sdk.connection.apply(ctx);
  new sdk.TypertRegistry(ctx);
  new sdk.RemoteAccessService(ctx);
  new sdk.TypertGatewayService(ctx, {});
  new sdk.BotWorkspaceService(ctx, store);
  await ctx.fiber.await();

  // Real lifetime-scoped peers, minted by the public Connection service. Never
  // manufacture ctx.invocation or an object merely claiming owner privilege.
  const owner = ctx.connection.createPeer({ principal: { kind: 'owner' } });
  const guest = ctx.connection.createPeer({ principal: { kind: 'guest' } });
  t.after(async () => { await guest.dispose(); await owner.dispose(); });
  const fetchHandler = ctx.connection.createSharedFetchHandler('/api');
  const calls = [];
  const callAs = peer => async (channel, endpoint, payload) => {
    calls.push({ peer: peer.id, channel, endpoint, payload: structuredClone(payload) });
    const rpcId = randomUUID();
    const response = await fetchHandler.fetch(new Request(`http://gateway.test${channel}/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    }), peer);
    assert.equal(response.status, 200, `Connection must dispatch ${endpoint} to Gateway`);
    const envelope = await response.json();
    assert.equal(envelope.type, 'server-response');
    assert.equal(envelope.rpcId, rpcId);
    return envelope.result;
  };
  const ownerCall = callAs(owner), guestCall = callAs(guest);

  // The exact former controller payloads must fail in the SDK's real wire
  // parser, including the screenshot diagnostic, before touching storage.
  for (const [endpoint, payload] of [
    ['botWorkspace/read', {}],
    ['botWorkspace/update', { request: { action: 'createBot', name: 'Legacy must not persist' } }]
  ]) {
    const result = await ownerCall('/api', endpoint, payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'gateway/internal');
    assert.equal(result.error.message, legacyMessage);
  }
  assert.deepEqual(await store.read(), createEmptyWorkspace());
  await assert.rejects(access(file), { code: 'ENOENT' });

  const makeController = call => createTeamController({ connection: { rpc: { call } } }, {
    // Metadata-only operations must never acquire native sessions or invoke a
    // model. Any unexpected runtime operation is an immediate test failure.
    runtime: {
      snapshot: () => null,
      watch: () => assert.fail('Metadata RPC must not watch a native session'),
      acquire: () => assert.fail('Metadata RPC must not acquire a native session'),
      dispose() {}
    }
  });
  const controller = makeController(ownerCall);
  t.after(() => controller.dispose());
  assert.deepEqual(await controller.refresh(), createEmptyWorkspace());
  assert.equal(controller.getSnapshot().loaded, true);
  assert.equal(controller.getSnapshot().connection, 'ready');
  assert.deepEqual(calls.at(-1).payload, { args: {} });

  const bot = await controller.createBot({ name: 'Gateway teammate', role: 'Metadata only.' });
  assert.match(bot.id, /^[a-f\d-]{36}$/);
  const created = controller.getSnapshot().workspace;
  assert.equal(created.bots.length, 1);
  assert.equal(created.bots[0].name, 'Gateway teammate');
  assert.equal(created.primaryBotId, bot.id);
  assert.equal(created.revision, 2, 'createBot and the controller primary assignment both cross Gateway');
  assert.ok(calls.some(call => call.endpoint === 'botWorkspace/update'
    && call.payload.args?.request?.action === 'createBot'));

  const request = { action: 'updateBot', id: bot.id, patch: { name: 'Updated through Gateway', role: 'Still metadata only.' } };
  const updated = await controller.mutate(request);
  assert.equal(updated.revision, 3);
  assert.equal(updated.bots[0].name, 'Updated through Gateway');
  assert.deepEqual(calls.at(-1).payload, { args: { request } });
  assert.deepEqual(await controller.refresh(), updated);
  assert.deepEqual(await new WorkspaceStore(file).read(), updated, 'actual service argument binding reaches durable WorkspaceStore');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), updated);

  // Valid wire shapes must not bypass real Gateway policy for a non-owner.
  const beforeDenied = await readFile(file, 'utf8');
  for (const [endpoint, args] of [
    ['botWorkspace/read', {}],
    ['botWorkspace/update', { request: { action: 'createBot', name: 'Guest must not persist' } }]
  ]) {
    const result = await guestCall('/api', endpoint, { args });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'remote-access/denied');
    assert.equal(result.error.details.action, endpoint);
  }
  const deniedController = makeController(guestCall);
  t.after(() => deniedController.dispose());
  await assert.rejects(deniedController.refresh(), { code: 'remote-access/denied' });
  assert.equal(deniedController.getSnapshot().loaded, false);
  assert.equal(deniedController.getSnapshot().connection, 'error');
  await assert.rejects(deniedController.mutate({ action: 'updateBot', id: bot.id, patch: { name: 'Denied edit' } }), { code: 'remote-access/denied' });
  assert.equal(await readFile(file, 'utf8'), beforeDenied);
  assert.deepEqual(await store.read(), updated);
});
