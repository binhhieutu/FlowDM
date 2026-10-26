'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
let createCredentialRebind;
try { ({ createCredentialRebind } = require('../../src/browser/credential-rebind.cjs')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
async function fixture(t, serviceOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-credential-challenge-')); let held = false;
  const server = http.createServer((req, res) => {
    if (held) return;
    if (req.headers.cookie !== 'fixture_session=new') return res.writeHead(401).end();
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': 1, 'Content-Range': 'bytes 0-0/1', ETag: '"same"' }).end('x');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { dataDir: path.join(root, 'state'), downloadDir: path.join(root, 'files') };
  let manager = await new DownloadManager(options).init(), service;
  t.after(async () => {
    await service?.close(); await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-credential-challenge-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const add = async () => { const task = await manager.add({ url: origin + '/file', headers: { Cookie: 'fixture_session=old' }, startAt: Date.now() + 60000 }); return manager.pause(task.id); };
  const task = await add(); await manager.close(); manager = await new DownloadManager(options).init();
  assert.equal(typeof createCredentialRebind, 'function', 'Desktop credential request service is missing');
  service = createCredentialRebind(manager, serviceOptions);
  return { root, origin, task, manager, service, add, hold() { held = true; } };
}
const bind = challenge => ({ taskId: challenge.taskId, origin: challenge.origin, requestId: challenge.requestId });
const credentials = challenge => ({ ...bind(challenge), headers: { Cookie: 'fixture_session=new' } });
test('only desktop initiation exposes bounded same-origin requests, clones DTOs and supersedes old nonce', async t => {
  const f = await fixture(t, { maxPending: 2 });
  assert.deepEqual(f.service.requests(f.origin), []);
  const first = f.service.request(f.task.id); const second = f.service.request(f.task.id);
  assert.notEqual(first.requestId, second.requestId); assert.equal(f.service.requests(f.origin).length, 1);
  assert.deepEqual(f.service.requests('https://example.com'), []);
  const copy = f.service.requests(f.origin)[0]; copy.url = 'https://example.com/';
  assert.equal(f.service.requests(f.origin)[0].url, f.task.url);
  await assert.rejects(f.service.prepare(credentials(first)), /expired|available|unknown/i);
  const another = await f.add(); f.service.request(another.id); const third = await f.add();
  assert.throws(() => f.service.request(third.id), /limit|pending|busy/i);
  const raw = await fs.readFile(path.join(f.root, 'state/downloads.json'), 'utf8');
  assert.ok(!raw.includes(second.requestId) && !raw.includes('fixture_session'));
});
test('prepare never authorizes resume, commit consumes exact binding and leaves the job paused', async t => {
  const f = await fixture(t); const challenge = f.service.request(f.task.id);
  assert.deepEqual(await f.service.prepare(credentials(challenge)), { id: f.task.id, prepared: true });
  await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
  assert.deepEqual(await f.service.commit(bind(challenge)), { id: f.task.id });
  assert.equal(f.manager.list()[0].status, 'paused'); assert.deepEqual(f.service.requests(f.origin), []);
  await assert.rejects(f.service.commit(bind(challenge)), /expired|available|unknown/i);
  assert.ok(!(await fs.readFile(path.join(f.root, 'state/downloads.json'), 'utf8')).includes('fixture_session'));
});
test('wrong task or origin, expired nonce and changed source cannot install credentials', async t => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock }); const challenge = f.service.request(f.task.id);
  await assert.rejects(f.service.prepare({ ...credentials(challenge), taskId: 'wrong' }));
  await assert.rejects(f.service.prepare({ ...credentials(challenge), origin: 'https://example.com' }));
  clock += 120001; await assert.rejects(f.service.prepare(credentials(challenge)), /expired|available|unknown/i);
  const next = f.service.request(f.task.id);
  await f.manager.refreshSource(f.task.id, { url: f.origin + '/other', headers: { Cookie: 'fixture_session=new' } });
  assert.deepEqual(f.service.requests(f.origin), []); await assert.rejects(f.service.prepare(credentials(next)));
});
test('cancel and application shutdown discard prepared headers and reject late commits', async t => {
  const f = await fixture(t); const first = f.service.request(f.task.id);
  await f.service.prepare(credentials(first)); assert.deepEqual(await f.service.cancel(bind(first)), { id: f.task.id });
  await assert.rejects(f.service.commit(bind(first))); await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
  const second = f.service.request(f.task.id); await f.service.prepare(credentials(second)); await f.service.close();
  await assert.rejects(f.service.commit(bind(second))); assert.throws(() => f.service.request(f.task.id));
  await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
});
test('aborted preflight and failed commit journal never create late credential binding', async t => {
  const f = await fixture(t); const first = f.service.request(f.task.id); const controller = new AbortController();
  controller.abort(); await assert.rejects(f.service.prepare(credentials(first), { signal: controller.signal }));
  assert.deepEqual(f.service.requests(f.origin), []);
  const second = f.service.request(f.task.id); await f.service.prepare(credentials(second));
  const persist = f.manager._persist.bind(f.manager); let failed = false;
  f.manager._persist = () => { if (!failed) { failed = true; return Promise.reject(Error('fixture journal denied')); } return persist(); };
  await assert.rejects(f.service.commit(bind(second)), /journal denied/);
  assert.equal(f.manager.list()[0].status, 'paused'); await assert.rejects(f.manager.resume(f.task.id), /headers|browser|reconnect/i);
});
