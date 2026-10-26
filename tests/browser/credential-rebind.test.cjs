'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 1000; i++) { const value = await check(); if (value) return value; await sleep(10); }
  throw Error('Credential fixture timed out');
}
async function fixture(t, hls = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-rebind-'));
  const body = Buffer.from('credential-resume-fixture'.repeat(32768));
  const video = path.resolve('tests/fixtures/video'); const requests = [];
  let cookie = 'fixture_session=old', changed = false, html = false, redirect = null, held = false;
  const otherRequests = [];
  const other = http.createServer((req, res) => { otherRequests.push({ credentials: !!req.headers.cookie || !!req.headers.authorization }); res.writeHead(200, { 'Content-Length': 1 }).end('x'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const server = http.createServer(async (req, res) => {
    if (held) return;
    if (redirect) return res.writeHead(302, { Location: redirect }).end();
    if (req.headers.cookie !== cookie) return res.writeHead(401).end();
    if (html) return res.writeHead(200, { 'Content-Type': html, 'Content-Length': 5 }).end('login');
    if (hls) {
      const name = path.basename(new URL(req.url, 'http://fixture').pathname);
      const bytes = await fs.readFile(path.join(video, name));
      if (name.endsWith('.m3u8')) return res.writeHead(200).end(changed ? bytes.toString().replace('#EXTINF:', '#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:') : bytes);
      const item = { resource: name, completed: false }; requests.push(item);
      res.once('finish', () => { item.completed = true; });
      const timer = setTimeout(() => res.writeHead(200).end(bytes), 100); res.once('close', () => clearTimeout(timer)); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? +match[1] : 0, end = match ? +match[2] : body.length - 1;
    requests.push({ start, end });
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: changed ? '"changed"' : '"retained"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    let at = start;
    const timer = setInterval(() => { const next = Math.min(at + 8192, end + 1); res.write(body.subarray(at, next)); at = next; if (at > end) { clearInterval(timer); res.end(); } }, 5);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { dataDir: path.join(root, 'state'), downloadDir: path.join(root, 'files') };
  let manager = await new DownloadManager(options).init();
  t.after(async () => {
    await manager.close(); for (const net of [server, other]) { net.closeAllConnections(); await new Promise(resolve => net.close(resolve)); }
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-rebind-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, origin, body, requests, otherRequests, url: origin + (hls ? '/list.m3u8' : '/file.bin'),
    get manager() { return manager; }, rotate() { cookie = 'fixture_session=new'; }, headers() { return { Cookie: cookie }; }, change() { changed = true; }, html(type = 'text/html') { html = type; }, hold() { held = true; },
    redirect() { redirect = `http://127.0.0.1:${other.address().port}/other`; },
    async relaunch() { await manager.close(); manager = await new DownloadManager(options).init(); }
  };
}
async function paused(f, hls = false) {
  const added = await f.manager.add({ url: f.url, headers: f.headers(), connections: 1 });
  await until(() => { const task = f.manager.list()[0]; return hls ? task.media?.completedSegments >= 1 : task.downloadedBytes >= 32768; });
  await f.manager.pause(added.id); return f.manager.list()[0];
}
test('lost browser credentials rebind and resize live HTTP connections without replaying retained byte ranges', async t => {
  const f = await fixture(t); const before = await paused(f); await f.relaunch(); f.rotate();
  await assert.rejects(f.manager.resume(before.id), /headers|browser|reconnect/i);
  assert.equal(typeof f.manager.rebindHeaders, 'function');
  const rebound = await f.manager.rebindHeaders(before.id, f.headers());
  assert.equal(rebound.id, before.id); assert.equal(rebound.status, 'paused'); assert.equal(rebound.downloadedBytes, before.downloadedBytes);
  assert.deepEqual(rebound.segments, before.segments); assert.equal(rebound.connections, 1);
  const raw = await fs.readFile(path.join(f.root, 'state/downloads.json'), 'utf8');
  assert.ok(!raw.includes('fixture_session') && !raw.includes('authorization'));
  const mark = f.requests.length; await f.manager.resume(before.id);
  assert.equal((await f.manager.setConnections(before.id, 4)).connections, 4);
  await until(() => f.manager.list()[0].downloadedBytes >= before.downloadedBytes + 32768);
  assert.equal((await f.manager.setConnections(before.id, 1)).connections, 1);
  const done = await until(() => { const task = f.manager.list()[0]; assert.notEqual(task.status, 'failed', task.error); return task.status === 'completed' ? task : false; });
  assert.deepEqual(await fs.readFile(done.path), f.body); assert.equal(done.sha256, crypto.createHash('sha256').update(f.body).digest('hex'));
  assert.ok(f.requests.slice(mark).filter(item => item.end > 0).every(item => item.start >= before.downloadedBytes));
});
test('prepared credentials remain unusable until commit and cannot commit after task source/state changes', async t => {
  const f = await fixture(t); const before = await paused(f); await f.relaunch(); f.rotate();
  assert.equal(typeof f.manager.prepareHeaderRebind, 'function');
  const prepared = await f.manager.prepareHeaderRebind(before.id, f.headers());
  await assert.rejects(f.manager.resume(before.id), /headers|browser|reconnect/i);
  await f.manager.cancel(before.id); await assert.rejects(prepared.commit(), /changed|stopped|paused/i);
  assert.equal(f.manager.list()[0].status, 'canceled');
});
test('rebind rejects login HTML, changed identity, unsupported headers and cross-origin redirects while preserving bytes', async t => {
  for (const mode of ['html', 'change', 'redirect']) {
    const f = await fixture(t); const before = await paused(f); await f.relaunch(); f.rotate(); f[mode]();
    assert.equal(typeof f.manager.rebindHeaders, 'function');
    await assert.rejects(f.manager.rebindHeaders(before.id, f.headers()), /HTML|login|identity|ETag|origin|changed|retained/i);
    assert.equal(f.manager.list()[0].downloadedBytes, before.downloadedBytes);
    await assert.rejects(f.manager.resume(before.id), /headers|browser|reconnect/i);
    assert.ok(f.otherRequests.every(item => !item.credentials));
    await assert.rejects(f.manager.rebindHeaders(before.id, { Host: 'evil', Cookie: 'fixture_session=new' }));
  }
});
test('abort never installs staged credentials or discards HTTP bytes', async t => {
  const f = await fixture(t); const before = await paused(f); await f.relaunch(); f.rotate();
  assert.equal(typeof f.manager.prepareHeaderRebind, 'function');
  const controller = new AbortController(); f.hold();
  const slow = f.manager.prepareHeaderRebind(before.id, f.headers(), { signal: controller.signal });
  controller.abort(); await assert.rejects(slow);
  assert.equal(f.manager.list()[0].downloadedBytes, before.downloadedBytes);
  await assert.rejects(f.manager.resume(before.id), /headers|browser|reconnect/i);
});
test('zero-byte browser jobs refuse login HTML and invalid or adapter-blocked header envelopes', async t => {
  const f = await fixture(t);
  const task = await f.manager.add({ url: f.url, headers: f.headers(), startAt: Date.now() + 60000 });
  await f.manager.pause(task.id); await f.relaunch(); f.rotate(); f.html('TEXT/HTML ; charset=utf-8');
  assert.equal(typeof f.manager.rebindHeaders, 'function');
  await assert.rejects(f.manager.rebindHeaders(task.id, f.headers()), /HTML|login/i);
  for (const headers of [{}, { 'User-Agent': 'fixture' }, { Cookie: 'one', cookie: 'two' }, { Cookie: 'fixture', 'X-Unknown': 'x' }, { Cookie: 'x'.repeat(65537) }]) await assert.rejects(f.manager.rebindHeaders(task.id, headers));
  const external = await f.manager.add({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', startAt: Date.now() + 60000 });
  await f.manager.pause(external.id); await assert.rejects(f.manager.rebindHeaders(external.id, f.headers()), /blocked-by-adapter/i);
});
test('HLS browser rebind resumes retained resources after restart without fetching completed fragments again', async t => {
  const f = await fixture(t, true); const before = await paused(f, true);
  const durable = f.requests.filter(item => item.completed).map(item => ({ name: item.resource, count: f.requests.filter(value => value.resource === item.resource).length }));
  assert.ok(durable.length); await f.relaunch(); f.rotate();
  assert.equal(typeof f.manager.rebindHeaders, 'function'); await f.manager.rebindHeaders(before.id, f.headers());
  await f.manager.resume(before.id);
  const done = await until(() => { const task = f.manager.list()[0]; assert.notEqual(task.status, 'failed', task.error); return task.status === 'completed' ? task : false; });
  for (const item of durable) assert.equal(f.requests.filter(value => value.resource === item.name).length, item.count);
  const manifest = await fs.readFile(path.resolve('tests/fixtures/video/list.m3u8'), 'utf8');
  const expected = Buffer.concat(await Promise.all(manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(name => fs.readFile(path.resolve('tests/fixtures/video', name)))));
  assert.deepEqual(await fs.readFile(done.path), expected);
});
