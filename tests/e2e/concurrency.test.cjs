const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

test('desktop connection selector causes real parallel HLS/DASH requests and identical playable outputs', { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-concurrency-')); let app;
  let active = 0; let peak = 0; let requests = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const name = path.posix.basename(url.pathname);
    const kind = url.pathname.startsWith('/video/') ? 'video' : url.pathname.startsWith('/dash/') ? 'dash' : null;
    if (!kind || url.pathname !== `/${kind}/${name}`) { res.writeHead(404).end(); return; }
    try {
      const data = await fs.readFile(path.resolve('tests/fixtures', kind, name));
      const manifest = /\.(m3u8|mpd)$/.test(name);
      res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'video/mp4' });
      if (manifest) { res.end(data); return; }
      active++; requests++; peak = Math.max(peak, active);
      const timer = setTimeout(() => res.end(data), 400);
      res.once('close', () => { active--; clearTimeout(timer); });
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.flow);
  const origin = `http://127.0.0.1:${server.address().port}`; const rows = [];
  for (const [mediaType, resource] of [['hls', '/video/list.m3u8'], ['dash', '/dash/manifest.mpd']]) {
    let reference;
    for (const connections of [1, 4]) {
      assert.equal(active, 0); peak = 0; requests = 0;
      await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
      await page.locator('#url').fill(origin + resource); await page.locator('#connections').selectOption(String(connections));
      await page.locator('#filename').fill(`${mediaType}-N${connections}.mp4`);
      const started = Date.now(); await page.locator('#add-form').evaluate(form => form.requestSubmit());
      let task;
      for (let attempt = 0; attempt < 300; attempt++) {
        task = (await page.evaluate(() => window.flow.list())).data.find(item => item.url === origin + resource && item.connections === connections);
        if (task && ['completed', 'failed'].includes(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const milliseconds = Date.now() - started;
      assert.equal(task?.status, 'completed', JSON.stringify(task)); assert.equal(task.connections, connections);
      assert.ok(peak <= connections, `${peak} > ${connections}`); if (connections === 1) assert.equal(peak, 1); else assert.ok(peak > 1, 'Requests did not overlap');
      const actual = await fs.readFile(task.path); if (reference) assert.deepEqual(actual, reference); else reference = actual;
      const decode = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', task.path, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      assert.equal(decode.status, 0, decode.stderr); assert.equal(decode.stderr, '');
      rows.push({ mediaType, connections, peakRequests: peak, resourceRequests: requests, milliseconds, bytes: actual.length, sha256: task.sha256 });
    }
  }
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/concurrency-v4.png' });
  await fs.writeFile('test-results/concurrency-v4.json', JSON.stringify({ at: new Date().toISOString(), packaged: !!process.env.FLOWDM_EXECUTABLE, fixedResourceLatencyMs: 400, rows }, null, 2));
  t.diagnostic(JSON.stringify(rows));
});
