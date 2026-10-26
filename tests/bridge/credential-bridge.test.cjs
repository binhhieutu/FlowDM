'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { createBridge } = require('../../src/bridge/server.cjs');
const { dispatch } = require('../../src/bridge/client.cjs');
const { validRequest, encodeFrame } = require('../../src/bridge/protocol.cjs');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const { createCredentialRebind } = require('../../src/browser/credential-rebind.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const binding = { taskId: 'task-1', origin: 'https://example.com', requestId: 'challenge-1' };
const request = (op, payload, id = op) => ({ schema: 1, request_id: id, op, payload });
test('native rebind operations validate exact origin, task binding and allowlisted bounded headers', () => {
  for (const op of ['commitCredentials', 'cancelCredentials']) assert.equal(validRequest(request(op, binding)), true);
  assert.equal(validRequest(request('credentialRequests', { origin: binding.origin })), true);
  assert.equal(validRequest(request('rebindCredentials', { ...binding, headers: { Cookie: 'fixture=ok' } })), true);
  for (const extra of [{ origin: 'https://example.com/path' }, { origin: 'file:///local' }, { taskId: '' }, { requestId: 'x'.repeat(129) }, { url: 'https://other.example/' }]) assert.equal(validRequest(request('commitCredentials', { ...binding, ...extra })), false);
  for (const headers of [{}, { Host: 'bad', Cookie: 'fixture' }, { Cookie: 'x\r\nbad' }, { Cookie: 'a', cookie: 'b' }, { Cookie: 'x'.repeat(65536) }]) assert.equal(validRequest(request('rebindCredentials', { ...binding, headers })), false);
});
async function fixture(t, { latency = 0, timeoutMs = 300 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-rebind-bridge-')); let started;
  const entered = new Promise(resolve => { started = resolve; });
  const httpServer = http.createServer((req, res) => {
    started(); const timer = setTimeout(() => res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': 1, 'Content-Range': 'bytes 0-0/1', ETag: '"same"' }).end('x'), latency);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const options = { dataDir: path.join(root, 'state'), downloadDir: path.join(root, 'files') };
  let manager = await new DownloadManager(options).init();
  const task = await manager.add({ url: origin + '/file', headers: { Cookie: 'fixture=old' }, startAt: Date.now() + 60000 }); await manager.pause(task.id); await manager.close();
  manager = await new DownloadManager(options).init(); const service = createCredentialRebind(manager); const challenge = service.request(task.id);
  const server = await createBridge({ dataDir: options.dataDir, onAdd: value => manager.add(value), credentialTimeoutMs: timeoutMs,
    onCredentialRequests: value => ({ requests: service.requests(value.origin) }), onRebindCredentials: (value, context) => service.prepare(value, context),
    onCommitCredentials: (value, context) => service.commit(value, context), onCancelCredentials: value => service.cancel(value) });
  t.after(async () => {
    await server.close(); await service.close(); await manager.close(); httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-rebind-bridge-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const bound = { taskId: task.id, origin, requestId: challenge.requestId };
  return { root, manager, service, server, entered, task, bound, credentials: { ...bound, headers: { Cookie: 'fixture=new' } } };
}
test('private bridge prepares and commits same task, redacts replies and keys replay cache by operation', async t => {
  const f = await fixture(t);
  const listed = await dispatch(f.server.config, request('credentialRequests', { origin: f.bound.origin })); assert.equal(listed.ok, true);
  assert.equal(listed.payload.requests[0].taskId, f.task.id);
  const prepared = await dispatch(f.server.config, request('rebindCredentials', f.credentials));
  assert.deepEqual(prepared, { request_id: 'rebindCredentials', ok: true, payload: { id: f.task.id, prepared: true } });
  await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
  const committed = await dispatch(f.server.config, request('commitCredentials', f.bound, 'shared-op-id'));
  assert.deepEqual(committed, { request_id: 'shared-op-id', ok: true, payload: { id: f.task.id } });
  assert.equal((await dispatch(f.server.config, request('cancelCredentials', f.bound, 'shared-op-id'))).error, 'REQUEST_ID_CONFLICT');
  assert.equal((await dispatch(f.server.config, request('commitCredentials', f.bound, 'fresh-replay'))).ok, false);
  assert.ok(!JSON.stringify([prepared, committed]).includes('fixture=new'));
});
test('bridge deadline aborts preflight and never binds headers after returning timeout', async t => {
  const f = await fixture(t, { latency: 150, timeoutMs: 30 });
  const reply = await dispatch(f.server.config, request('rebindCredentials', f.credentials)); assert.equal(reply.ok, false);
  await sleep(180); await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
  assert.deepEqual(f.service.requests(f.bound.origin), []);
});
test('native client disconnect aborts outstanding preparation and clears the desktop nonce', async t => {
  const f = await fixture(t, { latency: 200, timeoutMs: 1000 });
  const socket = net.createConnection(f.server.config.endpoint);
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve); });
  socket.write(encodeFrame({ secret: f.server.config.secret, request: request('rebindCredentials', f.credentials) }));
  await Promise.race([f.entered, sleep(500)]); socket.destroy(); await sleep(250);
  await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
  assert.deepEqual(f.service.requests(f.bound.origin), []);
});
