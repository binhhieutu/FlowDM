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
async function until(check, description, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(50); }
  throw Error(`Timeout: ${description}`);
}
async function launch(root, output) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: output } });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.flow);
  return { app, page };
}
async function tasks(page) { return (await page.evaluate(() => window.flow.list())).data; }
async function add(page, url, filename, connections = 1, limit = 0) {
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
  await page.locator('#url').fill(url); await page.locator('#filename').fill(filename);
  await page.locator('#connections').selectOption(String(connections)); await page.locator('#speed-limit').fill(String(limit));
  await page.locator('#add-form').evaluate(form => form.requestSubmit());
  return until(async () => (await tasks(page)).find(task => task.url === url), 'new media job');
}
async function readyToPause(page, id, count = 1) {
  return until(async () => {
    const task = (await tasks(page)).find(item => item.id === id);
    if (['failed', 'completed'].includes(task?.status)) throw Error(`Finished before pause: ${JSON.stringify(task)}`);
    return task?.downloadedBytes > 0 && (task.media?.completedResources || task.media?.completedSegments || 0) >= count ? task : false;
  }, 'durable media resource', 120000);
}
async function pause(page, id) {
  await page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Tạm dừng', exact: true }).click();
  return until(async () => { const task = (await tasks(page)).find(item => item.id === id); return task?.status === 'paused' ? task : false; }, 'paused');
}
async function finish(page, id, timeout = 120000) {
  const task = await until(async () => { const item = (await tasks(page)).find(value => value.id === id); return ['completed', 'failed'].includes(item?.status) ? item : false; }, 'completed media', timeout);
  assert.equal(task.status, 'completed', JSON.stringify(task)); return task;
}
function decode(filename, long = false) {
  const args = ['-v', 'error', '-xerror', '-i', filename, ...(long ? ['-map', '0:v:0', '-map', '0:a:0'] : []), '-f', 'null', '-'];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true, timeout: long ? 300000 : 30000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
}
test('HLS and DASH GUI pause, close/relaunch, reuse fragments and decode complete video', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-media-resume-')); let desktop;
  const requests = []; const completed = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname; const match = /^\/(video|dash)\/([A-Za-z0-9_.-]+)$/.exec(pathname);
    if (!match) return res.writeHead(404).end();
    try {
      const body = await fs.readFile(path.resolve('tests/fixtures', match[1], match[2]));
      const manifest = /\.(mpd|m3u8)$/.test(match[2]);
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': match[2].endsWith('.mpd') ? 'application/dash+xml' : match[2].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
      if (manifest) return res.end(body);
      requests.push(pathname); res.once('finish', () => completed.push(pathname));
      const timer = setTimeout(() => res.end(body), 600); res.once('close', () => clearTimeout(timer));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (desktop) await desktop.app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const rows = []; const origin = `http://127.0.0.1:${server.address().port}`;
  desktop = await launch(root, path.join(root, 'files'));
  for (const [mediaType, resource] of [['hls', '/video/list.m3u8'], ['dash', '/dash/manifest.mpd']]) {
    const before = requests.length;
    const added = await add(desktop.page, origin + resource, `${mediaType}-resume.mp4`);
    await readyToPause(desktop.page, added.id, mediaType === 'dash' ? 2 : 1);
    const paused = await pause(desktop.page, added.id); assert.ok(paused.downloadedBytes > 0);
    const completedFirst = completed.find(item => item.startsWith(mediaType === 'hls' ? '/video/' : '/dash/'));
    assert.ok(completedFirst); const firstRequests = requests.filter(item => item === completedFirst).length;
    await desktop.app.close(); desktop = null;
    desktop = await launch(root, path.join(root, 'files'));
    const restored = (await tasks(desktop.page)).find(item => item.id === added.id);
    assert.equal(restored.status, 'paused'); assert.ok(restored.downloadedBytes >= paused.downloadedBytes);
    await desktop.page.locator(`[data-task="${added.id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    const done = await finish(desktop.page, added.id);
    assert.ok(done.media.reusedResources > 0, JSON.stringify(done.media));
    assert.equal(requests.filter(item => item === completedFirst).length, firstRequests, 'Completed resource was downloaded twice');
    decode(done.path); assert.equal(crypto.createHash('sha256').update(await fs.readFile(done.path)).digest('hex'), done.sha256);
    await assert.rejects(fs.stat(path.join(root, 'state', `${done.id}.media`)), { code: 'ENOENT' });
    rows.push({ mediaType, pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, reusedResources: done.media.reusedResources, firstCompletedResource: completedFirst, firstResourceRequests: firstRequests, resourceRequests: requests.slice(before), bytes: done.totalBytes, sha256: done.sha256, wholeFileDecoded: true });
  }
  await fs.mkdir('test-results', { recursive: true }); await desktop.page.screenshot({ path: 'test-results/media-resume-v5.png' });
  await fs.writeFile(`test-results/media-resume-v5-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.json`, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  t.diagnostic(JSON.stringify(rows));
});

test('public YouTube GUI pause and app relaunch continue saved video and fully decode', { skip: !process.env.FLOWDM_LIVE_YOUTUBE, timeout: 900000 }, async t => {
  const root = path.resolve('.tmp', `youtube-resume-${Date.now()}`); const output = path.resolve('downloads/verification-v5'); let desktop;
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(output, { recursive: true });
  t.after(async () => { if (desktop) await desktop.app.close(); });
  desktop = await launch(root, output);
  const name = `YouTube-resume-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}-${path.basename(root)}.mp4`;
  const added = await add(desktop.page, process.env.FLOWDM_LIVE_YOUTUBE, name, 4, 4096);
  await readyToPause(desktop.page, added.id, 12); const paused = await pause(desktop.page, added.id);
  await fs.mkdir('test-results', { recursive: true }); await desktop.page.screenshot({ path: 'test-results/youtube-resume-v5-paused.png' });
  await desktop.app.close(); desktop = null; desktop = await launch(root, output);
  const restored = (await tasks(desktop.page)).find(item => item.id === added.id);
  assert.equal(restored.status, 'paused'); assert.ok(restored.downloadedBytes >= paused.downloadedBytes);
  await desktop.page.locator(`[data-task="${added.id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  const done = await finish(desktop.page, added.id, 700000);
  assert.ok(done.media.reusedResources >= 12); assert.ok(done.media.reusedBytes >= 8 * 1024 * 1024);
  decode(done.path, true);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', done.path], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(probe.status, 0, probe.stderr); const media = JSON.parse(probe.stdout);
  assert.deepEqual(media.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  assert.ok(Number(media.format.duration) > 600 && Number(media.format.duration) < 660, media.format.duration);
  const report = { at: new Date().toISOString(), version: (await desktop.page.evaluate(() => window.flow.info())).data.version, packaged: !!process.env.FLOWDM_EXECUTABLE, url: process.env.FLOWDM_LIVE_YOUTUBE, pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, reusedResources: done.media.reusedResources, reusedBytes: done.media.reusedBytes, bytes: done.totalBytes, sha256: done.sha256, path: done.path, duration: Number(media.format.duration), streams: media.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })), wholeFileDecoded: true };
  await fs.writeFile(`test-results/youtube-resume-v5-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.json`, JSON.stringify(report, null, 2));
  await desktop.page.screenshot({ path: 'test-results/youtube-resume-v5-completed.png' }); t.diagnostic(JSON.stringify(report));
});
