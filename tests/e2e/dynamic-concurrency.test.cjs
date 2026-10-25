'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');

async function until(check, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(25); }
  throw Error(`Timeout: ${description}`);
}
async function launch(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.flow); page.setDefaultTimeout(15000);
  return { app, page };
}
async function task(page, id) {
  const value = (await page.evaluate(() => window.flow.list())).data.find(item => item.id === id);
  assert.notEqual(value?.status, 'failed', JSON.stringify(value)); return value;
}
async function add(page, url, filename, connections, speedLimitKiB = 0) {
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
  await page.locator('#url').fill(url); await page.locator('#filename').fill(filename);
  await page.locator('#connections').selectOption(String(connections));
  await page.locator('#speed-limit').fill(String(speedLimitKiB));
  await page.locator('#add-form').evaluate(form => form.requestSubmit());
  return until(async () => (await page.evaluate(() => window.flow.list())).data.find(item => item.url === url), 'new direct task');
}
function committed(task) {
  return task.segments.filter(segment => segment.received > 0).map(segment => ({ start: segment.start, end: segment.start + segment.received - 1 }));
}
function noCommittedReplay(requests, spans) {
  for (const request of requests.filter(item => !item.probe)) {
    for (const span of spans) assert.ok(request.end < span.start || request.start > span.end,
      `Requested committed bytes again: ${JSON.stringify({ request, span })}`);
  }
}
async function change(page, id, connections) {
  await page.locator('#live-connections').selectOption(String(connections));
  await page.getByRole('button', { name: 'Áp dụng kết nối', exact: true }).click();
  return until(async () => { const value = await task(page, id); return value?.connections === connections && value.activeConnections === connections ? value : false; }, `live ${connections} connection(s)`);
}
function decode(filename) {
  const result = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
}
async function fixture(body) {
  const logs = []; const active = new Map(); const peak = new Map();
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://fixture').pathname; const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]); const end = match[2] ? Number(match[2]) : body.length - 1;
    if (start > end || end >= body.length) { res.writeHead(416).end(); return; }
    const probe = start === 0 && end === 0; const entry = { route, start, end, probe, bytesSent: 0, completed: false, at: Date.now() }; logs.push(entry);
    res.writeHead(206, { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}`, ETag: '"dynamic-real-video-v7"' });
    if (probe) { entry.bytesSent = 1; entry.completed = true; res.end(body.subarray(0, 1)); return; }
    active.set(route, (active.get(route) || 0) + 1); peak.set(route, Math.max(peak.get(route) || 0, active.get(route)));
    const interactive = route === '/interactive.mp4'; const slow = interactive || start < body.length / 4;
    const chunkBytes = slow ? 8192 : 65536; const interval = interactive ? 25 : slow ? 40 : 5;
    let offset = start; let timer;
    const send = () => {
      const next = Math.min(end + 1, offset + chunkBytes); res.write(body.subarray(offset, next)); entry.bytesSent += next - offset; offset = next;
      if (offset > end) { entry.completed = true; res.end(); } else timer = setTimeout(send, interval);
    };
    timer = setTimeout(send, interval);
    res.once('close', () => { clearTimeout(timer); active.set(route, active.get(route) - 1); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, logs, active, peak, origin: `http://127.0.0.1:${server.address().port}` };
}
async function fixedFour(url, length) {
  const output = Buffer.alloc(length); const started = Date.now();
  await Promise.all(Array.from({ length: 4 }, (_, index) => {
    const start = Math.floor(length * index / 4); const end = Math.floor(length * (index + 1) / 4) - 1;
    return new Promise((resolve, reject) => {
      const req = http.get(url, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' } }, res => {
        let offset = start;
        if (res.statusCode !== 206) { res.resume(); reject(Error(`Baseline HTTP ${res.statusCode}`)); return; }
        res.on('data', chunk => { chunk.copy(output, offset); offset += chunk.length; }); res.on('error', reject);
        res.on('end', () => { if (offset !== end + 1) reject(Error('Truncated baseline range')); else resolve(); });
      }); req.on('error', reject);
    });
  }));
  return { milliseconds: Date.now() - started, bytes: output.length, sha256: sha256(output) };
}

test('actual desktop resizes 1→4→1, resumes committed ranges after relaunch and redistributes a slow range', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-dynamic-v7-')); let desktop;
  const original = await fs.readFile(path.resolve('tests/fixtures/video/direct.mp4')); const body = Buffer.alloc(4 * 1024 * 1024); original.copy(body);
  // ISO-BMFF free padding retains the real MP4 while controlling transfer size.
  body.writeUInt32BE(body.length - original.length, original.length); body.write('free', original.length + 4, 'ascii');
  const expectedHash = sha256(body); const network = await fixture(body);
  t.after(async () => {
    if (desktop) await desktop.app.close(); network.server.closeAllConnections(); await new Promise(resolve => network.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  desktop = await launch(root);
  const added = await add(desktop.page, `${network.origin}/interactive.mp4`, 'dynamic-live-resume.mp4', 1);
  const initial = await until(async () => { const value = await task(desktop.page, added.id); return value?.activeConnections === 1 && value.downloadedBytes >= 65536 ? value : false; }, 'single connection progress');
  const beforeFour = network.logs.length; const spansOne = committed(initial); const four = await change(desktop.page, added.id, 4);
  assert.equal(four.status, 'downloading'); await until(() => network.active.get('/interactive.mp4') === 4, 'four actual HTTP connections');
  const snapshotFour = await task(desktop.page, added.id); const beforeOne = network.logs.length; const one = await change(desktop.page, added.id, 1);
  assert.equal(one.status, 'downloading'); await until(() => network.active.get('/interactive.mp4') <= 1, 'lower server connection cap');
  const capSamples = [];
  for (let sample = 0; sample < 10; sample++) {
    const value = await task(desktop.page, added.id); capSamples.push({ configured: value.connections, active: value.activeConnections, server: network.active.get('/interactive.mp4') });
    assert.equal(value.connections, 1); assert.ok(value.activeConnections <= 1); assert.ok(network.active.get('/interactive.mp4') <= 1); await sleep(30);
  }
  assert.ok((await task(desktop.page, added.id)).downloadedBytes > initial.downloadedBytes);
  await desktop.page.locator(`[data-task="${added.id}"]`).getByRole('button', { name: 'Tạm dừng', exact: true }).click();
  const paused = await until(async () => { const value = await task(desktop.page, added.id); return value?.status === 'paused' ? value : false; }, 'paused');
  assert.equal(paused.connections, 1); assert.equal(paused.activeConnections, 0);
  noCommittedReplay(network.logs.slice(beforeFour), spansOne); noCommittedReplay(network.logs.slice(beforeOne), committed(snapshotFour));
  const resumeLog = network.logs.length; const pausedSpans = committed(paused);
  await desktop.app.close(); desktop = null; desktop = await launch(root);
  const restored = await task(desktop.page, added.id);
  assert.equal(restored.status, 'paused'); assert.equal(restored.connections, 1); assert.equal(restored.activeConnections, 0); assert.equal(restored.downloadedBytes, paused.downloadedBytes);
  await desktop.page.locator(`[data-task="${added.id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  const done = await until(async () => { const value = await task(desktop.page, added.id); return value?.status === 'completed' ? value : false; }, 'resumed completed video');
  assert.equal(done.sha256, expectedHash); assert.equal(sha256(await fs.readFile(done.path)), expectedHash); decode(done.path);
  noCommittedReplay(network.logs.slice(resumeLog), pausedSpans); assert.ok(network.peak.get('/interactive.mp4') <= 4);
  const baseline = await fixedFour(`${network.origin}/baseline.mp4`, body.length); assert.equal(baseline.sha256, expectedHash); assert.equal(network.peak.get('/baseline.mp4'), 4);
  const started = Date.now(); const dynamic = await add(desktop.page, `${network.origin}/dynamic.mp4`, 'dynamic-benchmark.mp4', 4);
  const dynamicDone = await until(async () => { const value = await task(desktop.page, dynamic.id); return value?.status === 'completed' ? value : false; }, 'dynamic benchmark'); const dynamicMs = Date.now() - started;
  assert.equal(dynamicDone.sha256, expectedHash); assert.equal(sha256(await fs.readFile(dynamicDone.path)), expectedHash); decode(dynamicDone.path);
  const dynamicRequests = network.logs.filter(entry => entry.route === '/dynamic.mp4' && !entry.probe);
  assert.ok(dynamicRequests.some(entry => entry.start > 0 && entry.start < body.length / 4), 'Idle workers did not steal the slow first range');
  assert.ok(network.peak.get('/dynamic.mp4') <= 4); assert.ok(dynamicMs < baseline.milliseconds * 0.8, `No controlled speedup: dynamic=${dynamicMs} baseline=${baseline.milliseconds}`);
  const report = {
    at: new Date().toISOString(), packaged: !!process.env.FLOWDM_EXECUTABLE,
    fixture: { description: 'Real short MP4 plus ISO-BMFF free padding; full FFmpeg decode', originalBytes: original.length, bytes: body.length, sha256: expectedHash },
    live: { transitions: [1, 4, 1], initialBytes: initial.downloadedBytes, pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, restoredConnections: restored.connections, peakServerConnections: network.peak.get('/interactive.mp4'), capSamples, committedReplay: false, wholeFileDecoded: true },
    benchmark: { slowFirstQuarterChunkBytes: 8192, slowChunkDelayMs: 40, fastChunkBytes: 65536, fastChunkDelayMs: 5, baseline: { ...baseline, connections: 4, peakServerConnections: network.peak.get('/baseline.mp4') }, dynamic: { milliseconds: dynamicMs, connections: 4, peakServerConnections: network.peak.get('/dynamic.mp4'), bytes: dynamicDone.totalBytes, sha256: dynamicDone.sha256, wholeFileDecoded: true }, speedup: baseline.milliseconds / dynamicMs },
    requests: network.logs
  };
  const label = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'; await fs.mkdir('test-results', { recursive: true });
  await desktop.page.screenshot({ path: `test-results/dynamic-v7-${label}.png` }); await fs.writeFile(`test-results/dynamic-v7-${label}.json`, JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify({ live: report.live, benchmark: report.benchmark }));
});

test('public HTTP video supports live 1→4→1 and app relaunch with exact bytes', { skip: !process.env.FLOWDM_LIVE_HTTP, timeout: 300000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-live-http-v7-')); let desktop;
  t.after(async () => { if (desktop) await desktop.app.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  desktop = await launch(root);
  const added = await add(desktop.page, process.env.FLOWDM_LIVE_HTTP, 'public-http-live-v7.mp4', 1, 512);
  const first = await until(async () => { const value = await task(desktop.page, added.id); return value?.activeConnections === 1 && value.downloadedBytes >= 65536 ? value : false; }, 'public HTTP initial progress');
  assert.equal(first.validator?.type, 'etag'); assert.equal(first.ranges, true);
  const four = await change(desktop.page, added.id, 4); assert.ok(four.downloadedBytes >= first.downloadedBytes); await sleep(150);
  const one = await change(desktop.page, added.id, 1); assert.ok(one.downloadedBytes >= four.downloadedBytes);
  const pause = await desktop.page.evaluate(id => window.flow.action(id, 'pause'), added.id); assert.equal(pause.ok, true, pause.error);
  const paused = await task(desktop.page, added.id); assert.equal(paused.status, 'paused'); assert.equal(paused.activeConnections, 0);
  await desktop.app.close(); desktop = null; desktop = await launch(root);
  const restored = await task(desktop.page, added.id); assert.equal(restored.downloadedBytes, paused.downloadedBytes); assert.equal(restored.connections, 1);
  await desktop.page.locator(`[data-task="${added.id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  const done = await until(async () => { const value = await task(desktop.page, added.id); return value?.status === 'completed' ? value : false; }, 'public HTTP finish', 180000);
  decode(done.path); const bytes = await fs.readFile(done.path); assert.equal(bytes.length, done.totalBytes); assert.equal(sha256(bytes), done.sha256);
  // Fetch a second, independent continuous copy as a content reference. This is
  // verification only; it is not used to construct or repair the app output.
  const reference = await fetch(process.env.FLOWDM_LIVE_HTTP, { signal: AbortSignal.timeout(45000) }); assert.equal(reference.status, 200);
  const referenceBytes = Buffer.from(await reference.arrayBuffer()); assert.deepEqual(bytes, referenceBytes);
  const label = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source';
  await fs.mkdir('downloads/verification-v7', { recursive: true }); const output = path.resolve('downloads/verification-v7', `HTTP-live-${label}-${Date.now()}.mp4`); await fs.writeFile(output, bytes);
  const report = { at: new Date().toISOString(), packaged: !!process.env.FLOWDM_EXECUTABLE, version: (await desktop.page.evaluate(() => window.flow.info())).data.version, url: process.env.FLOWDM_LIVE_HTTP, transitions: [1, 4, 1], strongValidator: true, pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, restoredConnections: restored.connections, bytes: done.totalBytes, sha256: done.sha256, independentContinuousCopyMatches: true, wholeFileDecoded: true, output };
  await fs.mkdir('test-results', { recursive: true }); await desktop.page.screenshot({ path: `test-results/live-http-v7-${label}.png` }); await fs.writeFile(`test-results/live-http-v7-${label}.json`, JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
});
