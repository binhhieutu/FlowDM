'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 600; i++) { const value = check(); if (value) return value; await sleep(10); }
  throw Error('Timed out waiting for transfer');
}
async function fixture(t, { noValidator = false, hls = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-refresh-'));
  const body = Buffer.from('0123456789abcdef'.repeat(32768)); const requests = []; let expired = false; let transferStatus;
  const manifest = await fs.readFile(path.resolve('tests/fixtures/video/list.m3u8'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (expired && url.searchParams.get('token') === 'old') return res.writeHead(410).end();
    if (hls) {
      const name = path.basename(url.pathname);
      if (name.endsWith('.m3u8')) {
        const text = url.searchParams.has('changed') ? manifest.toString().replace('#EXTINF:', '#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:') : manifest;
        return res.writeHead(200).end(text);
      }
      const resource = await fs.readFile(path.resolve('tests/fixtures/video', name)); requests.push({ name });
      const timer = setTimeout(() => res.writeHead(200, { 'Content-Length': resource.length }).end(resource), 120);
      res.once('close', () => clearTimeout(timer)); return;
    }
    if (!noValidator) res.setHeader('ETag', url.searchParams.has('changed') ? '"other"' : '"same"');
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? +match[1] : 0, end = match ? +match[2] : body.length - 1;
    requests.push({ token: url.searchParams.get('token'), start, end, probe: end === 0 });
    if (transferStatus && end !== 0) return res.writeHead(transferStatus, { 'Content-Length': 0 }).end();
    res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    let at = start;
    const timer = setInterval(() => { const next = Math.min(at + 4096, end + 1); res.write(body.subarray(at, next)); at = next; if (at > end) { clearInterval(timer); res.end(); } }, end === 0 ? 1 : 6);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') };
  let manager = await new DownloadManager(options).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const url = `http://127.0.0.1:${server.address().port}/${hls ? 'list.m3u8' : 'video.mp4'}?token=`;
  return { root, body, requests, url, get manager() { return manager; }, expire() { expired = true; }, setTransferStatus(value) { transferStatus = value; }, async relaunch() { await manager.close(); manager = await new DownloadManager(options).init(); } };
}
async function paused(f) {
  const added = await f.manager.add({ url: f.url + 'old', connections: 1 });
  await until(() => f.manager.list().find(task => task.id === added.id && task.downloadedBytes > 0));
  await f.manager.pause(added.id); return f.manager.list().find(task => task.id === added.id);
}

test('refreshes expired direct URL, retains ID and bytes across relaunch, requests only remaining ranges', async t => {
  const f = await fixture(t); const before = await paused(f); f.expire(); await f.relaunch();
  assert.equal(typeof f.manager.refreshSource, 'function');
  const refreshed = await f.manager.refreshSource(before.id, { url: f.url + 'new' });
  assert.equal(refreshed.id, before.id); assert.equal(refreshed.path, before.path); assert.equal(refreshed.status, 'paused');
  assert.equal(refreshed.downloadedBytes, before.downloadedBytes); assert.deepEqual(refreshed.segments, before.segments);
  await f.relaunch(); await f.manager.resume(before.id);
  const done = await until(() => f.manager.list().find(task => task.id === before.id && ['completed', 'failed'].includes(task.status)));
  assert.equal(done.status, 'completed', done.error); assert.deepEqual(await fs.readFile(done.path), f.body);
  assert.equal(f.requests.find(req => req.token === 'new' && !req.probe).start, before.downloadedBytes);
});

test('rejects changed identity or invalid refresh input without changing source/cache', async t => {
  const f = await fixture(t); const before = await paused(f); const partial = path.join(f.root, 'data', `${before.id}.part`);
  const saved = await fs.readFile(partial);
  assert.equal(typeof f.manager.refreshSource, 'function');
  for (const input of [{ url: f.url + 'new&changed=1' }, { url: 'file:///etc/passwd' }, { url: f.url + 'new', filename: 'other.mp4' }, { url: f.url + 'new', headers: { range: 'bytes=0-9' } }]) {
    await assert.rejects(f.manager.refreshSource(before.id, input));
    assert.deepEqual(f.manager.list().find(task => task.id === before.id), before); assert.deepEqual(await fs.readFile(partial), saved);
  }
});

test('refuses missing validator on resume and refresh while preserving HTTP partial', async t => {
  const f = await fixture(t, { noValidator: true }); const before = await paused(f);
  const partial = path.join(f.root, 'data', `${before.id}.part`); const saved = await fs.readFile(partial);
  await f.manager.resume(before.id);
  const failed = await until(() => f.manager.list().find(task => task.id === before.id && ['failed', 'completed'].includes(task.status)));
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /resume|validator|continu/i); assert.deepEqual(await fs.readFile(partial), saved);
  await assert.rejects(f.manager.refreshSource(before.id, { url: f.url + 'new' }));
});

test('HLS refresh accepts exact manifest/resource identity and keeps complete resource cache', async t => {
  const f = await fixture(t, { hls: true }); const before = await paused(f); f.expire();
  const directory = path.join(f.root, 'data', `${before.id}.media`); const state = await fs.readFile(path.join(directory, 'checkpoint.json'));
  assert.equal(typeof f.manager.refreshSource, 'function');
  await assert.rejects(f.manager.refreshSource(before.id, { url: f.url + 'new&changed=1' }), /identity|changed/i);
  assert.deepEqual(await fs.readFile(path.join(directory, 'checkpoint.json')), state);
  const task = await f.manager.refreshSource(before.id, { url: f.url + 'new' }); assert.equal(task.id, before.id);
  await f.relaunch(); await f.manager.resume(before.id);
  const done = await until(() => f.manager.list().find(item => item.id === before.id && ['completed', 'failed'].includes(item.status)));
  assert.equal(done.status, 'completed', done.error); assert.ok(done.media.reusedResources >= 1);
  assert.equal(f.requests.filter(req => req.name === 'segment00.ts').length, 1);
});

test('refresh refuses running tasks and sensitive headers across origins', async t => {
  const f = await fixture(t); const task = await f.manager.add({ url: f.url + 'old', connections: 1 });
  assert.equal(typeof f.manager.refreshSource, 'function');
  await assert.rejects(f.manager.refreshSource(task.id, { url: f.url + 'new' }), /pause|stop|dừng/i);
  await f.manager.pause(task.id);
  await assert.rejects(f.manager.refreshSource(task.id, { url: f.url.replace('127.0.0.1', 'localhost') + 'new', headers: { Cookie: 'private-cookie' } }), /origin|nguồn/i);
  assert.ok(!(await fs.readFile(path.join(f.root, 'data', 'downloads.json'), 'utf8')).includes('private-cookie'));
});

test('a failed journal update rolls back refreshed source and keeps existing partial', async t => {
  const f = await fixture(t); const before = await paused(f);
  const partial = path.join(f.root, 'data', `${before.id}.part`); const saved = await fs.readFile(partial);
  const persist = f.manager._persist.bind(f.manager); let failed = false;
  f.manager._persist = () => { if (!failed) { failed = true; return Promise.reject(Error('Simulated storage refusal')); } return persist(); };
  await assert.rejects(f.manager.refreshSource(before.id, { url: f.url + 'new' }), /storage refusal/);
  assert.deepEqual(f.manager.list().find(task => task.id === before.id), before);
  assert.deepEqual(await fs.readFile(partial), saved); await f.relaunch();
  assert.equal(f.manager.list()[0].url, before.url);
});

test('Range 200 or 416 after a resumed probe does not truncate the committed prefix', async t => {
  for (const statusCode of [200, 416]) {
    const f = await fixture(t); const before = await paused(f); const partial = path.join(f.root, 'data', `${before.id}.part`); const saved = await fs.readFile(partial);
    f.setTransferStatus(statusCode);
    await f.manager.resume(before.id);
    const failed = await until(() => f.manager.list().find(task => task.id === before.id && task.status === 'failed'));
    assert.equal(failed.downloadedBytes, before.downloadedBytes); assert.deepEqual(await fs.readFile(partial), saved);
  }
});

test('resume refuses a partial with extra trailing bytes beyond the declared resource size', async t => {
  const f = await fixture(t); const before = await paused(f); const partial = path.join(f.root, 'data', `${before.id}.part`);
  await fs.truncate(partial, f.body.length + 1); const saved = await fs.readFile(partial);
  await f.manager.resume(before.id);
  const task = await until(() => f.manager.list().find(task => task.id === before.id && ['completed', 'failed'].includes(task.status)));
  assert.equal(task.status, 'failed'); assert.match(task.error, /checkpoint|size|truncat/i);
  assert.deepEqual(await fs.readFile(partial), saved);
});
