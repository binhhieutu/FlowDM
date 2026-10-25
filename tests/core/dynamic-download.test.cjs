'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(5); }
  throw Error('Timed out waiting for dynamic transfer');
}
async function fixture(t, { slow = false, size = 4 * 1024 ** 2, managerOptions = {}, dropOnce = false, noRange = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-dynamic-')); const body = Buffer.alloc(size); for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const requests = []; let active = 0, peak = 0, dropped = false;
  const server = http.createServer((req, res) => {
    const match = noRange ? null : /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || ''); const start = match ? +match[1] : 0, end = match ? +match[2] : body.length - 1;
    res.writeHead(match ? 206 : 200, { ETag: '"dynamic-fixture"', 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    if (end === 0) return res.end(body.subarray(0, 1));
    if (noRange && req.headers.range === 'bytes=0-0') return res.end(body);
    active++; peak = Math.max(peak, active); requests.push({ start, end, ifRange: req.headers['if-range'] });
    let offset = start; const interval = slow ? start < size / 4 ? 30 : 2 : 5;
    const timer = setInterval(() => { const next = Math.min(offset + 32768, end + 1); res.write(body.subarray(offset, next)); offset = next; if (dropOnce && !dropped) { dropped = true; res.destroy(); return; } if (slow && start === 0) { clearInterval(timer); return; } if (offset > end) { clearInterval(timer); res.end(); } }, interval);
    res.once('close', () => { active--; clearInterval(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files'), ...managerOptions }; let manager = await new DownloadManager(options).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { body, requests, root, options, url: `http://127.0.0.1:${server.address().port}/video.mp4`, get active() { return active; }, get peak() { return peak; }, get dropped() { return dropped; }, get manager() { return manager; }, async relaunch() { await manager.close(); manager = await new DownloadManager(options).init(); } };
}
function snapshot(f, id) { return f.manager.list().find(task => task.id === id); }
function assertPlan(task) {
  let next = 0, received = 0;
  for (const segment of task.segments) { assert.equal(segment.start, next); assert.ok(segment.received >= 0 && segment.received <= segment.end - segment.start + 1); next = segment.end + 1; received += segment.received; }
  assert.equal(next, task.totalBytes); assert.equal(received, task.downloadedBytes);
}
async function complete(f, id) {
  const task = await until(() => { const task = snapshot(f, id); return ['completed', 'failed'].includes(task.status) ? task : false; });
  assert.equal(task.status, 'completed', task.error); assertPlan(task); assert.deepEqual(await fs.readFile(task.path), f.body);
  assert.equal(task.sha256, crypto.createHash('sha256').update(f.body).digest('hex')); return task;
}

test('changes live HTTP connections 1 to 4 to 1, preserves committed ranges across pause and relaunch', async t => {
  const f = await fixture(t); const added = await f.manager.add({ url: f.url, connections: 1 });
  await until(() => snapshot(f, added.id).downloadedBytes >= 65536);
  assert.equal(typeof f.manager.setConnections, 'function');
  const before = snapshot(f, added.id); const mark = f.requests.length;
  const raised = await f.manager.setConnections(added.id, 4); assert.equal(raised.connections, 4); assert.ok(raised.downloadedBytes >= before.downloadedBytes); assertPlan(raised);
  await until(() => f.active >= 2); assert.ok(f.peak <= 4); assert.ok(f.requests.slice(mark).every(request => request.start >= before.downloadedBytes));
  const lowered = await f.manager.setConnections(added.id, 1); assert.equal(lowered.connections, 1);
  await until(() => f.active <= 1); await f.manager.pause(added.id); const paused = snapshot(f, added.id); assertPlan(paused);
  await f.relaunch(); assert.equal(snapshot(f, added.id).connections, 1); assert.equal(snapshot(f, added.id).downloadedBytes, paused.downloadedBytes);
  await f.manager.resume(added.id); const done = await complete(f, added.id); assert.equal(done.connections, 1); assert.ok(f.requests.every(request => request.ifRange === '"dynamic-fixture"'));
});

test('idle HTTP workers split the slow unfinished range and preserve exact file coverage', async t => {
  const f = await fixture(t, { slow: true }); const added = await f.manager.add({ url: f.url, connections: 4 });
  await complete(f, added.id); assert.ok(f.requests.length > 4, `Expected slow-tail redistribution, got ${f.requests.length} requests`); assert.ok(f.peak <= 4);
});

test('invalid live connection inputs and non-HTTP requests cannot mutate the download', async t => {
  const f = await fixture(t); const task = await f.manager.add({ url: f.url, startAt: Date.now() + 60000 });
  assert.equal(typeof f.manager.setConnections, 'function');
  for (const count of [0, 17, -1, 1.5, '4', null]) await assert.rejects(f.manager.setConnections(task.id, count));
  assert.equal(snapshot(f, task.id).connections, 4);
  const media = await f.manager.add({ url: f.url, mediaType: 'hls', startAt: Date.now() + 60000 });
  await assert.rejects(f.manager.setConnections(media.id, 8), /HTTP|direct/i);
  await f.manager.cancel(task.id); await assert.rejects(f.manager.setConnections(task.id, 8));
});

test('live resizing retains the aggregate speed budget rather than resetting it per worker', async t => {
  const f = await fixture(t, { size: 2 * 1024 ** 2 }); const started = Date.now();
  const task = await f.manager.add({ url: f.url, connections: 1, speedLimit: 1024 ** 2 });
  await until(() => snapshot(f, task.id).downloadedBytes >= 65536);
  assert.equal(typeof f.manager.setConnections, 'function');
  await f.manager.setConnections(task.id, 4); await until(() => snapshot(f, task.id).downloadedBytes >= 262144); await f.manager.setConnections(task.id, 1);
  await complete(f, task.id); assert.ok(Date.now() - started >= 1900, 'Connection changes reset/bypassed the aggregate speed cap');
});

test('pause during a pending ownership journal waits and never starts replacement requests', async t => {
  const f = await fixture(t, { slow: true }); const persist = f.manager._persist.bind(f.manager); let entered, release; let intercepted = false;
  const barrier = new Promise(resolve => { entered = resolve; });
  f.manager._persist = () => {
    const task = f.manager.list()[0];
    if (!intercepted && task?.downloadedBytes > 0 && task.segments.length !== 4) { intercepted = true; entered(); return new Promise(resolve => { release = async () => { await persist(); resolve(); }; }); }
    return persist();
  };
  const added = await f.manager.add({ url: f.url, connections: 4 }); await barrier;
  const requests = f.requests.length; const paused = f.manager.pause(added.id); await sleep(20); await release(); await paused;
  assert.equal(f.requests.length, requests); assert.equal(snapshot(f, added.id).status, 'paused'); assertPlan(snapshot(f, added.id));
  await f.relaunch(); await f.manager.resume(added.id); await complete(f, added.id);
});

test('a failed ownership journal restores the old plan and never starts uncommitted ranges', async t => {
  const f = await fixture(t, { slow: true }); const persist = f.manager._persist.bind(f.manager); let intercepted = false, requests;
  f.manager._persist = () => {
    const task = f.manager.list()[0];
    if (!intercepted && task?.downloadedBytes > 0 && task.segments.length !== 4) { intercepted = true; requests = f.requests.length; return Promise.reject(Error('ownership save denied')); }
    return persist();
  };
  const added = await f.manager.add({ url: f.url, connections: 4 });
  const failed = await until(() => { const task = snapshot(f, added.id); return task.status === 'failed' ? task : false; });
  assert.match(failed.error, /ownership save denied/); assert.equal(f.requests.length, requests); assert.equal(failed.segments.length, 4); assertPlan(failed);
  await f.relaunch(); await f.manager.resume(added.id); await complete(f, added.id);
});

test('connection changes interrupt retry backoff without failing or losing the file', async t => {
  const f = await fixture(t, { dropOnce: true }); const task = await f.manager.add({ url: f.url, connections: 1 });
  await until(() => f.dropped); await f.manager.setConnections(task.id, 4); await complete(f, task.id); assert.ok(f.peak <= 4);
});

test('a server without ranges keeps its one uninterrupted stream when the configured cap changes', async t => {
  const f = await fixture(t, { noRange: true }); const task = await f.manager.add({ url: f.url, connections: 1 });
  await until(() => snapshot(f, task.id).downloadedBytes > 0); await f.manager.setConnections(task.id, 16);
  assert.equal(snapshot(f, task.id).connections, 16); await complete(f, task.id); assert.equal(f.requests.length, 1); assert.equal(f.peak, 1);
});
