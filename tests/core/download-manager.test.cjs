const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');

const bytes = Buffer.from('FlowDM deterministic integration payload.\n'.repeat(16000));
async function fixture(t, handler, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-'));
  const server = http.createServer(handler || serve);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files'), ...options });
  await manager.init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { manager, root, url: `http://127.0.0.1:${server.address().port}/file.bin` };
}
function serve(req, res) {
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  res.setHeader('ETag', '"fixture-v1"');
  if (match) {
    const start = +match[1], end = match[2] ? +match[2] : bytes.length - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
  } else { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
}
async function status(manager, id, expected, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const task = manager.list().find(item => item.id === id);
    if (expected.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw Error(`Timed out: ${JSON.stringify(manager.list())}`);
}

test('downloads parallel ranges with exact content, hash and detached snapshots', async t => {
  const { manager, url } = await fixture(t);
  const task = await manager.add({ url, connections: 4 });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.segments.length, 4);
  assert.deepEqual(await fs.readFile(done.path), bytes);
  assert.equal(done.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  done.segments[0].received = -1;
  assert.notEqual(manager.list()[0].segments[0].received, -1);
});
test('falls back for ignored ranges and unknown length chunked responses', async t => {
  const { manager, url } = await fixture(t, (req, res) => { res.writeHead(200); res.write(bytes.subarray(0, 400)); res.end(bytes.subarray(400)); });
  const task = await manager.add({ url });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.segments.length, 1);
  assert.deepEqual(await fs.readFile(done.path), bytes);
});
test('rejects unsafe inputs and avoids overwriting files in selected directory', async t => {
  const { manager, root, url } = await fixture(t);
  for (const input of [{ url: 'file:///secret' }, { url: 'http://user:pass@example.com' }, { url, filename: '../bad' }, { url, connections: 99 }, { url, headers: { Cookie: 'bad\r\n' } }, { url, speedLimit: -1 }]) await assert.rejects(manager.add(input));
  const directory = path.join(root, 'chosen'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'saved.bin'), 'keep');
  const task = await manager.add({ url, filename: 'saved.bin', directory });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(await fs.readFile(path.join(directory, 'saved.bin'), 'utf8'), 'keep');
  assert.equal(done.path, path.join(directory, 'saved (1).bin'));
});
test('detects malformed Content-Range and enforces configured size ceiling', async t => {
  const { manager, url } = await fixture(t, (req, res) => { res.writeHead(206, { 'Content-Range': 'bytes 1-9/10' }); res.end('123456789'); });
  const task = await manager.add({ url });
  assert.equal((await status(manager, task.id, ['failed'])).status, 'failed');
  const capped = await fixture(t, serve, { maxBytes: 10 });
  const large = await capped.manager.add({ url: capped.url });
  assert.match((await status(capped.manager, large.id, ['failed'])).error, /size|limit/i);
});
test('journals without secret headers and restores scheduled tasks safely', async t => {
  const { manager, root, url } = await fixture(t);
  const task = await manager.add({ url, headers: { Authorization: 'Bearer secret-test', Cookie: 'secret-cookie', Referer: 'https://safe.example/' }, startAt: Date.now() + 60000 });
  assert.equal(task.status, 'queued');
  await manager.close();
  const journal = await fs.readFile(path.join(root, 'data', 'downloads.json'), 'utf8');
  assert.ok(!journal.includes('secret-test') && !journal.includes('secret-cookie'));
  const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
  await restored.init();
  assert.equal(restored.list()[0].id, task.id);
  await restored.pause(task.id); await restored.pause(task.id);
  assert.equal(restored.list()[0].status, 'paused');
  await restored.cancel(task.id); await restored.cancel(task.id);
  assert.equal(restored.list()[0].status, 'canceled');
  assert.equal(await restored.remove(task.id), true);
  assert.equal(await restored.remove(task.id), false);
  await restored.close();
});

module.exports = { fixture, serve, bytes, status };

test('resumes sparse parallel progress when later ranges have not received any bytes', async t => {
  const { manager, url } = await fixture(t, (req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = +match[1], end = +match[2];
    res.writeHead(206, { ETag: '"sparse"', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    if (end === 0) return res.end(bytes.subarray(0, 1));
    let at = start;
    if (start === 0) { res.write(bytes.subarray(0, 4096)); at = 4096; }
    const timer = setTimeout(() => res.end(bytes.subarray(at, end + 1)), 250);
    res.once('close', () => clearTimeout(timer));
  });
  const task = await manager.add({ url, connections: 4 });
  while (!manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 5));
  const paused = await manager.pause(task.id);
  assert.ok(paused.segments.slice(1).every(segment => segment.received === 0));
  await manager.resume(task.id);
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error); assert.deepEqual(await fs.readFile(done.path), bytes);
});

test('pauses active transfer, resumes ranges and survives manager restart', async t => {
  const { manager, root, url } = await fixture(t);
  const task = await manager.add({ url, speedLimit: bytes.length * 2, connections: 1 });
  await status(manager, task.id, ['downloading']);
  while (!manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id);
  const partial = manager.list()[0].downloadedBytes;
  assert.ok(partial > 0 && partial < bytes.length);
  await manager.close();
  const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
  await restored.init();
  assert.equal(restored.list()[0].status, 'paused');
  await restored.resume(task.id);
  const done = await status(restored, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(await fs.readFile(done.path), bytes);
  await restored.pause(task.id); await restored.resume(task.id);
  assert.equal(restored.list()[0].status, 'completed');
  await restored.remove(task.id);
  assert.deepEqual(await fs.readFile(done.path), bytes);
  await restored.close();
});

test('refuses changed resume validator and allows retry after server recovers', async t => {
  let etag = '"fixture-v1"';
  const { manager, url } = await fixture(t, (req, res) => {
    res.setHeader('ETag', etag);
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = match ? +match[1] : 0, end = match && match[2] ? +match[2] : bytes.length - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
  });
  const task = await manager.add({ url, connections: 1, speedLimit: bytes.length });
  while (!manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id); etag = '"fixture-v2"';
  await manager.resume(task.id);
  assert.match((await status(manager, task.id, ['failed'])).error, /changed/i);
  etag = '"fixture-v1"'; await manager.resume(task.id);
  assert.equal((await status(manager, task.id, ['completed', 'failed'])).status, 'completed');
});

test('preserves partial without validator and rate limits a separately requested fresh transfer', async t => {
  const { manager, url } = await fixture(t, (req, res) => { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); });
  const task = await manager.add({ url, connections: 1, speedLimit: bytes.length * 2 });
  while (!manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id);
  const saved = manager.list()[0].downloadedBytes;
  await manager.resume(task.id);
  const refused = await status(manager, task.id, ['failed']);
  assert.match(refused.error, /validator|resume/i); assert.equal(refused.downloadedBytes, saved);
  const started = Date.now(); const fresh = await manager.add({ url, connections: 1, speedLimit: bytes.length * 2 });
  const done = await status(manager, fresh.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(Date.now() - started >= 400);
  assert.deepEqual(await fs.readFile(done.path), bytes);
});

test('bounds active download queue and starts scheduled jobs only when due', async t => {
  const { manager, url } = await fixture(t, serve, { maxConcurrent: 1, maxPerHost: 1 });
  let highest = 0;
  manager.on('change', tasks => { highest = Math.max(highest, tasks.filter(task => task.status === 'downloading').length); });
  const scheduled = await manager.add({ url, startAt: Date.now() + 350 });
  const second = await manager.add({ url, speedLimit: bytes.length * 3 });
  assert.equal(manager.list()[0].status, 'queued');
  await status(manager, second.id, ['completed']); await status(manager, scheduled.id, ['completed']);
  assert.equal(highest, 1);
});

test('cancel interrupts limiter waits; close is idempotent; invalid controls fail', async t => {
  const { manager, url } = await fixture(t);
  const task = await manager.add({ url, speedLimit: 1 });
  await status(manager, task.id, ['downloading']);
  await manager.resume(task.id);
  await manager.cancel(task.id);
  assert.equal(manager.list()[0].status, 'canceled');
  await manager.pause(task.id); await manager.resume(task.id);
  await assert.rejects(manager.pause('missing'));
  await manager.close(); await manager.close();
  await assert.rejects(manager.add({ url }));
});

test('retries transient probe errors but stops permanent HTTP failure', async t => {
  let attempts = 0;
  const { manager, url } = await fixture(t, (req, res) => {
    if (++attempts < 3) { res.writeHead(503); res.end(); } else serve(req, res);
  });
  const task = await manager.add({ url });
  assert.equal((await status(manager, task.id, ['completed', 'failed'])).status, 'completed');
  assert.ok(attempts >= 3);
  const bad = await fixture(t, (_req, res) => { res.writeHead(404); res.end(); });
  const missing = await bad.manager.add({ url: bad.url });
  assert.match((await status(bad.manager, missing.id, ['failed'])).error, /HTTP 404/);
});

test('strips credentials across redirects and bounds redirect loops', async t => {
  const seen = [];
  const target = await fixture(t, (req, res) => { seen.push(req.headers); serve(req, res); });
  const source = await fixture(t, (_req, res) => { res.writeHead(302, { Location: target.url }); res.end(); });
  const task = await source.manager.add({ url: source.url, headers: { Authorization: 'secret', Cookie: 'private', Referer: 'https://private.example' } });
  const done = await status(source.manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.finalUrl, target.url);
  assert.ok(seen.every(headers => !headers.authorization && !headers.cookie && !headers.referer));
  const loop = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); });
  const infinite = await loop.manager.add({ url: loop.url });
  assert.match((await status(loop.manager, infinite.id, ['failed'])).error, /Redirect limit/);
});

test('rejects truncated, oversized, encoded and changed range responses', async t => {
  const handlers = [
    (req, res) => { if (req.headers.range === 'bytes=0-0') return serve(req, res); res.writeHead(206, { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: '"fixture-v1"' }); res.end('short'); },
    (req, res) => { if (req.headers.range === 'bytes=0-0') return serve(req, res); res.writeHead(200); res.end(bytes); },
    (_req, res) => { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end('garbage'); },
    (req, res) => { if (req.headers.range === 'bytes=0-0') return serve(req, res); res.writeHead(206, { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: '"changed"' }); res.end(bytes); },
    (_req, res) => { res.writeHead(200); res.end(bytes); }
  ];
  for (let index = 0; index < handlers.length; index++) {
    const item = await fixture(t, handlers[index], { maxBytes: index === 4 ? 100 : bytes.length * 2 });
    const task = await item.manager.add({ url: item.url, connections: 1 });
    const failed = await status(item.manager, task.id, ['completed', 'failed']);
    assert.equal(failed.status, 'failed', `case ${index}: ${failed.error}`);
    await assert.rejects(fs.access(failed.path));
  }
});

test('restored header-dependent downloads require user to supply headers again', async t => {
  const { manager, root, url } = await fixture(t);
  const task = await manager.add({ url, headers: { Authorization: 'secret' }, startAt: Date.now() + 60000 });
  await manager.pause(task.id); await manager.close();
  const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
  await restored.init();
  await assert.rejects(restored.resume(task.id), /headers are not persisted/);
  await restored.close();
});

test('shutdown checkpoints running download and init is idempotent', async t => {
  const { manager, root, url } = await fixture(t);
  assert.equal(await manager.init(), manager);
  const task = await manager.add({ url, speedLimit: 1 });
  await status(manager, task.id, ['downloading']);
  await manager.close();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'data', 'downloads.json'), 'utf8'));
  assert.equal(saved.tasks[0].status, 'paused');
});

test('refuses a server abandoning Range after probe without restarting the download', async t => {
  const { manager, url } = await fixture(t, (req, res) => {
    if (req.headers.range === 'bytes=0-0') return serve(req, res);
    res.writeHead(200, { ETag: '"fixture-v1"', 'Content-Length': bytes.length }); res.end(bytes);
  });
  const task = await manager.add({ url });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'failed'); assert.match(done.error, /RANGE_IGNORED/);
  assert.equal(done.downloadedBytes, 0);
  await assert.rejects(fs.stat(done.path), { code: 'ENOENT' });
});

test('supports empty files and refuses missing or shortened checkpoints without restarting', async t => {
  const empty = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 0 }); res.end(); });
  const zero = await empty.manager.add({ url: empty.url });
  const done = await status(empty.manager, zero.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal((await fs.stat(done.path)).size, 0);
  for (const missing of [true, false]) {
    const item = await fixture(t);
    const task = await item.manager.add({ url: item.url, speedLimit: bytes.length, connections: 1 });
    while (!item.manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 10));
    await item.manager.pause(task.id);
    const partial = path.join(item.root, 'data', `${task.id}.part`);
    if (missing) await fs.unlink(partial); else await fs.truncate(partial, 0);
    await item.manager.resume(task.id);
    const failed = await status(item.manager, task.id, ['completed', 'failed']);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /checkpoint/i); assert.ok(failed.downloadedBytes > 0);
    if (missing) await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
    else assert.equal((await fs.stat(partial)).size, 0);
  }
});

test('does not split range responses without a strong validator', async t => {
  const { manager, url } = await fixture(t, (req, res) => {
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!match) { res.writeHead(200, { 'Content-Length': bytes.length }); return res.end(bytes); }
    const start = +match[1], end = +match[2];
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }); res.end(bytes.subarray(start, end + 1));
  });
  const task = await manager.add({ url });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error); assert.equal(done.segments.length, 1);
});

test('staging publication is exclusive, complete and cleans temporary entries on failure', async t => {
  const { publish, openPartial } = require('../../src/core/storage.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const partial = path.join(root, 'source.part'), destination = path.join(root, 'final.bin');
  await fs.writeFile(partial, bytes); await fs.writeFile(destination, 'keep');
  await assert.rejects(publish(partial, destination), { code: 'EEXIST' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(root)).sort(), ['final.bin', 'source.part']);
  await assert.rejects(openPartial(root, true), /Unsafe partial/);
  await fs.unlink(destination); await publish(partial, destination);
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.deepEqual(await fs.readdir(root), ['final.bin']);
});

test('policy rejects reserved headers and filenames; journal corruption fails visibly', async t => {
  const { manager, root, url } = await fixture(t);
  for (const filename of ['CON.txt', 'bad.', '', 'NUL', 'bad/name']) await assert.rejects(manager.add({ url, filename }));
  for (const headers of [null, [], { Range: 'bytes=0-0' }, { Test: 7 }]) await assert.rejects(manager.add({ url, headers }));
  await assert.rejects(manager.add({ url, directory: 'relative' }));
  await assert.rejects(manager.add({ url, startAt: 'not-a-date' }));
  const scheduled = await manager.add({ url, startAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(scheduled.status, 'queued');
  await manager.close();
  const file = path.join(root, 'data', 'downloads.json');
  for (const contents of ['{broken', JSON.stringify({ version: 9, tasks: [] }), JSON.stringify({ version: 1, tasks: [{ id: 'bad' }] })]) {
    await fs.writeFile(file, contents);
    const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
    await assert.rejects(restored.init()); await restored.close();
  }
});

test('retries an interrupted validated segment from its committed byte offset', async t => {
  let dropped = false;
  const starts = [];
  const { manager, url } = await fixture(t, (req, res) => {
    if (req.headers.range === 'bytes=0-0') return serve(req, res);
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    const start = +match[1], end = +match[2]; starts.push(start);
    res.writeHead(206, { ETag: '"fixture-v1"', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
    if (!dropped) {
      dropped = true; res.write(bytes.subarray(start, start + 32000));
      setTimeout(() => res.destroy(), 40);
    } else res.end(bytes.subarray(start, end + 1));
  });
  const task = await manager.add({ url, connections: 1 });
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(starts.length >= 2 && starts[1] > 0);
  assert.deepEqual(await fs.readFile(done.path), bytes);
});

test('per-host queue cap applies independently from global download cap', async t => {
  const { manager, url } = await fixture(t, serve, { maxConcurrent: 3, maxPerHost: 1 });
  const jobs = await Promise.all([0, 1, 2].map(() => manager.add({ url, speedLimit: bytes.length * 4 })));
  assert.equal(manager.list().filter(task => task.status === 'downloading').length, 1);
  await Promise.all(jobs.map(task => status(manager, task.id, ['completed'])));
});

test('disk-full publication failure leaves no partial final name and preserves source', async t => {
  const { publish, atomicJournal } = require('../../src/core/storage.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.part'), destination = path.join(root, 'output.bin');
  await fs.writeFile(source, bytes);
  const copy = fs.copyFile;
  try {
    fs.copyFile = async (_source, staging) => { await fs.writeFile(staging, 'partial'); throw Object.assign(Error('Disk full'), { code: 'ENOSPC' }); };
    await assert.rejects(publish(source, destination), { code: 'ENOSPC' });
  } finally { fs.copyFile = copy; }
  assert.deepEqual(await fs.readdir(root), ['source.part']);
  assert.deepEqual(await fs.readFile(source), bytes);
  const journal = path.join(root, 'downloads.json');
  await atomicJournal(journal, [{ valid: true }]);
  const rename = fs.rename;
  try {
    fs.rename = async () => { throw Object.assign(Error('Rename denied'), { code: 'EACCES' }); };
    await assert.rejects(atomicJournal(journal, [{ valid: false }]), { code: 'EACCES' });
  } finally { fs.rename = rename; }
  assert.deepEqual(JSON.parse(await fs.readFile(journal, 'utf8')).tasks, [{ valid: true }]);
  assert.deepEqual((await fs.readdir(root)).sort(), ['downloads.json', 'source.part']);
});

test('Last-Modified same-second changes refuse continuation and retain original bytes', async t => {
  let current = Buffer.alloc(bytes.length, 'A');
  const { manager, url } = await fixture(t, (req, res) => {
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = match ? +match[1] : 0, end = match ? +match[2] : current.length - 1;
    const headers = { 'Last-Modified': 'Fri, 23 Oct 2026 12:00:00 GMT', 'Content-Length': end - start + 1 };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${current.length}`;
    res.writeHead(match ? 206 : 200, headers); res.end(current.subarray(start, end + 1));
  });
  const task = await manager.add({ url, speedLimit: bytes.length * 2 });
  while (!manager.list()[0].downloadedBytes) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id); current = Buffer.alloc(bytes.length, 'B');
  await manager.resume(task.id);
  const done = await status(manager, task.id, ['completed', 'failed']);
  assert.equal(done.status, 'failed'); assert.match(done.error, /ETag|validator/i);
  const retained = await fs.readFile(path.join(manager.dataDir, `${task.id}.part`));
  assert.ok(retained.length > 0 && retained.every(byte => byte === 65), 'Original A bytes must be retained, not replaced by B');
  assert.equal(done.ranges, false);
});

test('recognizes fully published crash checkpoints without network using persisted digest', async t => {
  for (const savedState of ['downloading', 'paused']) {
    const { manager, root, url } = await fixture(t);
    const task = await manager.add({ url, startAt: Date.now() + 60000 }); await manager.close();
    const journal = path.join(root, 'data', 'downloads.json');
    const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
    Object.assign(saved.tasks[0], { url: 'http://127.0.0.1:1/offline', status: savedState, totalBytes: bytes.length, downloadedBytes: bytes.length, segments: [{ index: 0, start: 0, end: bytes.length - 1, received: bytes.length }], sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    await fs.writeFile(journal, JSON.stringify(saved)); await fs.writeFile(task.path, bytes);
    const obsoletePartial = path.join(root, 'data', `${task.id}.part`);
    await fs.writeFile(obsoletePartial, 'obsolete checkpoint');
    const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
    try {
      await restored.init();
      assert.equal(restored.list()[0].status, 'completed');
      assert.equal((await restored.resume(task.id)).status, 'completed');
      assert.deepEqual(await fs.readFile(task.path), bytes);
      await assert.rejects(fs.stat(obsoletePartial), { code: 'ENOENT' });
    } finally { await restored.close(); }
  }
});

test('does not recover an unrelated final file or malformed stored digest as complete', async t => {
  for (const hash of ['a'.repeat(64), 'malformed']) {
    const { manager, root, url } = await fixture(t);
    const task = await manager.add({ url, startAt: Date.now() + 60000 }); await manager.close();
    const journal = path.join(root, 'data', 'downloads.json');
    const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
    Object.assign(saved.tasks[0], { status: 'paused', totalBytes: 4, downloadedBytes: 4, segments: [{ index: 0, start: 0, end: 3, received: 4 }], sha256: hash });
    await fs.writeFile(journal, JSON.stringify(saved)); await fs.writeFile(task.path, 'keep');
    const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
    try { await restored.init(); assert.equal(restored.list()[0].status, 'paused'); assert.equal(await fs.readFile(task.path, 'utf8'), 'keep'); }
    finally { await restored.close(); }
  }
});

test('preflights unsupported destination filesystems before any network body transfer', async t => {
  let requests = 0;
  const { manager, root, url } = await fixture(t, (req, res) => { requests++; serve(req, res); });
  const link = fs.link;
  try {
    fs.link = async () => { throw Object.assign(Error('Operation not supported'), { code: 'EOPNOTSUPP' }); };
    const task = await manager.add({ url });
    const failed = await status(manager, task.id, ['failed']);
    assert.match(failed.error, /UNSUPPORTED_DESTINATION_FILESYSTEM/);
    assert.equal(requests, 0);
    assert.deepEqual(await fs.readdir(path.join(root, 'files')), []);
  } finally { fs.link = link; }
});

test('resume recovers a published final appearing after init without contacting offline source', async t => {
  const { manager, root, url } = await fixture(t);
  const task = await manager.add({ url, startAt: Date.now() + 60000 }); await manager.close();
  const journal = path.join(root, 'data', 'downloads.json');
  const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
  Object.assign(saved.tasks[0], { url: 'http://127.0.0.1:1/offline', status: 'paused', totalBytes: bytes.length, downloadedBytes: bytes.length, segments: [{ index: 0, start: 0, end: bytes.length - 1, received: bytes.length }], sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  await fs.writeFile(journal, JSON.stringify(saved));
  const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
  try {
    await restored.init(); assert.equal(restored.list()[0].status, 'paused');
    await fs.writeFile(task.path, bytes);
    assert.equal((await restored.resume(task.id)).status, 'completed');
  } finally { await restored.close(); }
});

test('published recovery rejects size mismatches and non-file destinations', async t => {
  const { recoverPublished } = require('../../src/core/storage.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'file'); await fs.writeFile(filename, bytes);
  const task = { path: filename, totalBytes: bytes.length, downloadedBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  assert.equal(await recoverPublished(task), true);
  assert.equal(await recoverPublished({ ...task, downloadedBytes: bytes.length - 1 }), false);
  assert.equal(await recoverPublished({ ...task, downloadedBytes: bytes.length - 1, totalBytes: bytes.length - 1 }), false);
  assert.equal(await recoverPublished({ ...task, path: root }), false);
  assert.equal(await recoverPublished({ ...task, totalBytes: null }), true);
});

test('migrates version 1 direct queued and paused tasks unchanged into version 7 journal', async t => {
  const { manager, root, url } = await fixture(t);
  await manager.add({ url, startAt: Date.now() + 60000 });
  const paused = await manager.add({ url, filename: 'paused.bin', startAt: Date.now() + 60000 });
  await manager.pause(paused.id); await manager.close();
  const journal = path.join(root, 'data', 'downloads.json');
  const legacy = JSON.parse(await fs.readFile(journal, 'utf8'));
  legacy.version = 1;
  for (const task of legacy.tasks) delete task.mediaType;
  await fs.writeFile(journal, JSON.stringify(legacy));
  const restored = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files') });
  try {
    await restored.init();
    const migrated = JSON.parse(await fs.readFile(journal, 'utf8'));
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.tasks, legacy.tasks);
  } finally { await restored.close(); }
});

test('new downloads wait for initial durable journal and rejected adds cannot start later', async t => {
  let requests = 0;
  const { manager, root, url } = await fixture(t, (req, res) => { requests++; serve(req, res); });
  const persist = manager._persist.bind(manager);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  let intercepted = false;
  manager._persist = () => {
    if (intercepted) return persist();
    intercepted = true; enter();
    return new Promise((resolve, reject) => { release = { resolve, reject }; });
  };
  const adding = manager.add({ url, headers: { Cookie: 'session-only' } });
  await entered;
  manager._pump(); await new Promise(resolve => setTimeout(resolve, 30));
  const prematureRequests = requests, prematureRunning = manager.running.size;
  manager._persist = persist;
  release.reject(Object.assign(Error('Journal disk full'), { code: 'ENOSPC' }));
  await assert.rejects(adding, { code: 'ENOSPC' });
  assert.equal(prematureRequests, 0, 'pending initial journal must block network activity');
  assert.equal(prematureRunning, 0);
  manager._pump(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(manager.list(), []); assert.equal(manager.secrets.size, 0); assert.equal(requests, 0);
  assert.equal(manager.pendingAdds.size, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data', 'downloads.json'), 'utf8')).tasks, []);
  const successful = await manager.add({ url });
  assert.equal((await status(manager, successful.id, ['completed', 'failed'])).status, 'completed');
});
