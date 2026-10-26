'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(30); }
  throw Error('Timed out waiting for source refresh desktop flow');
}
async function launch(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const executablePath = process.env.FLOWDM_EXECUTABLE || require('electron');
  const app = await _electron.launch({ chromiumSandbox: true, executablePath, args: process.env.FLOWDM_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.flow); return { app, page };
}
async function snapshot(page, id) { return page.evaluate(async id => (await window.flow.list()).data.find(task => task.id === id), id); }
async function finish(page, id) {
  const task = await until(async () => { const task = await snapshot(page, id); return ['completed', 'failed'].includes(task.status) ? task : false; });
  assert.equal(task.status, 'completed', task.error); return task;
}
function decode(filename) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'], { encoding: 'utf8', timeout: 300000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
}

test('real video GUI refreshes expired HTTP HLS DASH links and resumes after relaunch without repeating committed data', { timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-refresh-gui-')); const requests = []; const expired = new Set(); let desktop;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const match = /^\/(direct|video|dash)\/([\w.-]+)$/.exec(url.pathname);
    if (!match) return res.writeHead(404).end();
    if (expired.has(match[1]) && url.searchParams.get('token') === 'old') return res.writeHead(410).end();
    try {
      let body = await fs.readFile(path.resolve('tests/fixtures', match[1] === 'direct' ? 'video' : match[1], match[2]));
      if (url.searchParams.has('changed')) {
        if (match[2].endsWith('.m3u8')) body = Buffer.from(body.toString().replace('#EXTINF:', '#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:'));
        if (match[2].endsWith('.mpd')) body = Buffer.from(body.toString().replace('PT3.0S', 'PT4.0S') + '\n');
      }
      const manifest = /\.(m3u8|mpd)$/.test(match[2]);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const start = range ? +range[1] : 0, end = range ? +range[2] : body.length - 1;
      const probe = !!range && start === 0 && end === 0;
      requests.push({ kind: match[1], resource: match[2], token: url.searchParams.get('token'), start, end, probe });
      const headers = { 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}), ...(match[1] === 'direct' ? { ETag: url.searchParams.has('changed') ? '"changed"' : '"real-video-v1"' } : {}) };
      res.writeHead(range ? 206 : 200, headers);
      if (manifest || probe) return res.end(body.subarray(start, end + 1));
      let at = start;
      const timer = setInterval(() => { const next = Math.min(at + (match[1] === 'direct' ? 256 : body.length), end + 1); res.write(body.subarray(at, next)); at = next; if (at > end) { clearInterval(timer); res.end(); } }, match[1] === 'direct' ? 20 : 600);
      res.once('close', () => clearInterval(timer));
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (desktop) await desktop.app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  desktop = await launch(root); const rows = []; const errors = []; desktop.page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [kind, file] of [['direct', 'direct.mp4'], ['video', 'list.m3u8'], ['dash', 'manifest.mpd']]) {
    const oldUrl = `${origin}/${kind}/${file}?token=old`, newUrl = `${origin}/${kind}/${file}?token=new`;
    const added = await desktop.page.evaluate(async ({ url, kind }) => window.flow.add({ url, filename: `${kind}-refresh.mp4`, connections: 1 }), { url: oldUrl, kind });
    assert.equal(added.ok, true, added.error); const id = added.data.id;
    await until(async () => { const task = await snapshot(desktop.page, id); if (task.status === 'failed') throw Error(task.error); return task.downloadedBytes > 2048 && (kind === 'direct' || (task.media?.completedSegments || 0) >= (kind === 'dash' ? 2 : 1)); });
    await desktop.page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    const paused = await until(async () => { const task = await snapshot(desktop.page, id); return task.status === 'paused' ? task : false; });
    expired.add(kind); await desktop.app.close(); desktop = null; desktop = await launch(root);
    assert.equal((await snapshot(desktop.page, id)).downloadedBytes, paused.downloadedBytes);
    await desktop.page.locator(`[data-task="${id}"]`).click();
    await desktop.page.getByRole('button', { name: 'Cập nhật liên kết', exact: true }).click();
    await desktop.page.locator('#refresh-url').fill(`${newUrl}&changed=1`);
    await desktop.page.locator('#refresh-form').evaluate(form => form.requestSubmit());
    await desktop.page.locator('#refresh-error').waitFor({ state: 'visible' });
    assert.equal((await snapshot(desktop.page, id)).url, oldUrl);
    assert.equal((await snapshot(desktop.page, id)).downloadedBytes, paused.downloadedBytes);
    await desktop.page.locator('#refresh-url').fill(newUrl);
    await desktop.page.locator('#refresh-form').evaluate(form => form.requestSubmit());
    await desktop.page.locator('#refresh-dialog').waitFor({ state: 'hidden', timeout: 45000 });
    assert.equal((await snapshot(desktop.page, id)).status, 'paused');
    const marker = requests.length;
    await desktop.app.close(); desktop = null; desktop = await launch(root);
    const restored = await snapshot(desktop.page, id); assert.equal(restored.id, id); assert.equal(restored.url, newUrl); assert.equal(restored.downloadedBytes, paused.downloadedBytes);
    await desktop.page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    const done = await finish(desktop.page, id); decode(done.path);
    const hash = crypto.createHash('sha256').update(await fs.readFile(done.path)).digest('hex'); assert.equal(hash, done.sha256);
    if (kind === 'direct') {
      const expected = await fs.readFile('tests/fixtures/video/direct.mp4'); assert.deepEqual(await fs.readFile(done.path), expected);
      assert.equal(requests.slice(marker).find(req => req.kind === kind && !req.probe).start, paused.downloadedBytes);
    } else {
      assert.ok(done.media.reusedResources >= (kind === 'dash' ? 2 : 1));
      const resource = kind === 'video' ? 'segment00.ts' : 'init-stream0.m4s';
      assert.equal(requests.filter(req => req.kind === kind && req.resource === resource).length, 1);
    }
    rows.push({ kind, id, pausedBytes: paused.downloadedBytes, bytes: done.totalBytes, sha256: hash, reusedResources: done.media?.reusedResources || 0, changedSourceRefused: true, relaunchAfterRefresh: true, wholeFileDecoded: true, requests: requests.filter(req => req.kind === kind) });
  }
  await fs.mkdir('test-results', { recursive: true });
  const variant = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source';
  await desktop.page.screenshot({ path: `test-results/source-refresh-v6-${variant}.png` });
  const invalid = await desktop.page.evaluate(() => window.flow.refreshSource('missing', 'file:///secret')); assert.equal(invalid.ok, false);
  assert.deepEqual(errors, []);
  await fs.writeFile(`test-results/source-refresh-v6-${variant}.json`, JSON.stringify({ at: new Date().toISOString(), variant, rows }, null, 2));
  t.diagnostic(JSON.stringify(rows.map(({ requests, ...row }) => row)));
});

test('public YouTube refresh validates the same video and resumes retained fragments after app relaunch', { skip: !process.env.FLOWDM_LIVE_YOUTUBE, timeout: 900000 }, async t => {
  await fs.mkdir('.tmp', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.tmp', 'flowdm-refresh-live-')); let desktop;
  t.after(async () => { if (desktop) await desktop.app.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  desktop = await launch(root);
  const response = await desktop.page.evaluate(url => window.flow.add({ url, filename: 'YouTube-refresh-v6.mp4', connections: 4, speedLimit: 4 * 1024 * 1024 }), process.env.FLOWDM_LIVE_YOUTUBE);
  assert.equal(response.ok, true, response.error); const id = response.data.id;
  await until(async () => { const task = await snapshot(desktop.page, id); if (['failed', 'completed'].includes(task.status)) throw Error(`Unexpected early finish: ${task.error || task.status}`); return (task.media?.completedResources || 0) >= 12; }, 180000);
  await desktop.page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Tạm dừng', exact: true }).click();
  await until(async () => (await snapshot(desktop.page, id)).status === 'paused');
  await desktop.app.close(); desktop = null; desktop = await launch(root);
  const before = await snapshot(desktop.page, id); const refreshedUrl = new URL(before.url); refreshedUrl.searchParams.set('flowdm_refresh', 'verified');
  await desktop.page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Cập nhật liên kết', exact: true }).click();
  await desktop.page.locator('#refresh-url').fill(refreshedUrl.href); await desktop.page.locator('#refresh-form').evaluate(form => form.requestSubmit());
  await until(async () => {
    if (await desktop.page.locator('#refresh-error').isVisible()) throw Error(await desktop.page.locator('#refresh-error').textContent());
    return !(await desktop.page.locator('#refresh-dialog').isVisible());
  }, 90000);
  const updated = await snapshot(desktop.page, id); assert.equal(updated.id, id); assert.equal(updated.downloadedBytes, before.downloadedBytes);
  await desktop.app.close(); desktop = null; desktop = await launch(root);
  const restored = await snapshot(desktop.page, id); assert.equal(restored.url, refreshedUrl.href); assert.equal(restored.downloadedBytes, before.downloadedBytes);
  await desktop.page.locator(`[data-task="${id}"]`).getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  const done = await until(async () => { const task = await snapshot(desktop.page, id); return ['completed', 'failed'].includes(task.status) ? task : false; }, 700000);
  assert.equal(done.status, 'completed', done.error); assert.ok(done.media.reusedResources >= 12); assert.ok(done.media.reusedBytes > 0);
  decode(done.path); const hash = crypto.createHash('sha256').update(await fs.readFile(done.path)).digest('hex'); assert.equal(hash, done.sha256);
  await fs.mkdir('downloads/verification-v6', { recursive: true }); const output = path.resolve('downloads/verification-v6', `YouTube-refresh-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}-${Date.now()}.mp4`); await fs.copyFile(done.path, output);
  await fs.mkdir('test-results', { recursive: true }); const variant = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source';
  const report = { at: new Date().toISOString(), variant, version: (await desktop.page.evaluate(() => window.flow.info())).data.version, id, pausedBytes: before.downloadedBytes, restoredBytes: restored.downloadedBytes, reusedResources: done.media.reusedResources, reusedBytes: done.media.reusedBytes, bytes: done.totalBytes, sha256: hash, refreshAccepted: true, relaunchAfterRefresh: true, wholeFileDecoded: true, output };
  await desktop.page.screenshot({ path: `test-results/youtube-refresh-v6-${variant}.png` });
  await fs.writeFile(`test-results/youtube-refresh-v6-${variant}.json`, JSON.stringify(report, null, 2)); t.diagnostic(JSON.stringify(report));
});
