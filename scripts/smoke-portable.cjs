// NSIS portable launchers do not forward Playwright's -r loader. Use the real
// packaged GUI over a loopback-only Chromium debugging session for this smoke.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
  const executable = path.resolve(process.argv[2] || `dist/FlowDM ${require('../package.json').version}.exe`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-portable-'));
  const content = crypto.randomBytes(2 * 1024 * 1024); let instance; let smokeError; let stage = 'startup';
  const mark = value => { stage = value; console.log(`portable-stage: ${stage}`); };
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? +match[1] : 0; const end = match && match[2] ? +match[2] : content.length - 1;
    const headers = { 'Content-Length': end - start + 1, ETag: '"portable-v1"' };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
    res.writeHead(match ? 206 : 200, headers); let position = start;
    const timer = setInterval(() => { if (position > end) { clearInterval(timer); res.end(); return; } const next = Math.min(position + 8192, end + 1); res.write(content.subarray(position, next)); position = next; }, 12);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function launch() {
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
    const child = spawn(executable, [`--remote-debugging-port=${port}`], { env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') }, stdio: 'ignore', windowsHide: true });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    instance = { child, exited };
    const endpoint = `http://127.0.0.1:${port}`; const deadline = Date.now() + 30000;
    while (true) {
      try { const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch {}
      if (Date.now() > deadline) throw new Error('Portable GUI did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const browser = await chromium.connectOverCDP(endpoint);
    instance = { child, exited, browser };
    const session = await browser.newBrowserCDPSession();
    try { const { processInfo } = await session.send('SystemInfo.getProcessInfo'); instance.appPid = Number(processInfo.find(process => process.type === 'browser')?.id) || null; }
    finally { await session.detach(); }
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 30000 });
    instance.page = page;
    page.setDefaultTimeout(30000); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
    return instance;
  }
  async function close() {
    if (!instance) return;
    // Electron does not reliably implement CDP Target.closeTarget. Request the
    // window close in its renderer, then wait for the real portable launcher.
    const current = instance;
    current.page ||= current.browser?.contexts().flatMap(context => context.pages())[0];
    if (current.page) await current.page.evaluate(() => window.close()).catch(() => {});
    let timer;
    try {
      const actualExit = async () => {
        if (!current.appPid) return;
        const deadline = Date.now() + 20000;
        for (;;) {
          try { process.kill(current.appPid, 0); } catch { return; }
          if (Date.now() > deadline) throw Error('Portable application process did not shut down');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      await Promise.race([Promise.all([current.exited, actualExit()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Portable did not shut down')), 25000); })]);
    } finally {
      clearTimeout(timer);
      if (current.browser) await current.browser.close().catch(() => {});
      instance = null;
    }
  }
  try {
    mark('launch first GUI'); let { page } = await launch();
    await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
    await page.getByLabel('Địa chỉ tải').fill(`http://127.0.0.1:${server.address().port}/portable.bin`);
    await page.getByRole('button', { name: 'Bắt đầu tải', exact: true }).click();
    let row = page.locator('[data-task]').filter({ hasText: 'portable.bin' });
    await row.getByText('Đang tải', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    await row.getByText('Tạm dừng', { exact: true }).waitFor();
    mark('close paused HTTP'); await close();
    mark('relaunch paused HTTP'); ({ page } = await launch()); row = page.locator('[data-task]').filter({ hasText: 'portable.bin' });
    await row.getByText('Tạm dừng', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await row.getByText('Hoàn tất', { exact: true }).waitFor({ timeout: 30000 });
    assert.deepEqual(await fs.readFile(path.join(root, 'files', 'portable.bin')), content);
    const info = await page.evaluate(() => window.flow.info()); assert.equal(info.data.mediaTools.ready, true, JSON.stringify(info));
    mark('HTTP resumed and verified'); let youtube = null;
    if (process.env.FLOWDM_LIVE_YOUTUBE) {
      mark('add YouTube'); const verifyResume = process.env.FLOWDM_TEST_MEDIA_RESUME === '1';
      const added = await page.evaluate(({ url, verifyResume }) => window.flow.add({ url, filename: 'portable-youtube.mp4', ...(verifyResume ? { speedLimit: 4 * 1024 * 1024 } : {}) }), { url: process.env.FLOWDM_LIVE_YOUTUBE, verifyResume });
      assert.equal(added.ok, true, JSON.stringify(added));
      let resume = null;
      if (verifyResume) {
        mark('wait saved YouTube fragments'); const pauseDeadline = Date.now() + 120000; let current;
        while (Date.now() < pauseDeadline) {
          current = (await page.evaluate(() => window.flow.list())).data.find(item => item.id === added.data.id);
          if (['failed', 'completed'].includes(current?.status)) throw Error(`Portable media finished before pause: ${current.error || current.status}`);
          if (current?.downloadedBytes >= 8 * 1024 * 1024 && current.media?.completedResources >= 12) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(current?.downloadedBytes >= 8 * 1024 * 1024 && current.media?.completedResources >= 12);
        const paused = await page.evaluate(id => window.flow.action(id, 'pause'), added.data.id);
        assert.equal(paused.ok, true, JSON.stringify(paused)); assert.equal(paused.data.status, 'paused');
        mark('close paused YouTube'); await close(); mark('relaunch paused YouTube'); ({ page } = await launch());
        const restored = (await page.evaluate(() => window.flow.list())).data.find(item => item.id === added.data.id);
        assert.equal(restored.status, 'paused'); assert.ok(restored.downloadedBytes >= paused.data.downloadedBytes);
        const continued = await page.evaluate(id => window.flow.action(id, 'resume'), added.data.id); assert.equal(continued.ok, true, JSON.stringify(continued));
        resume = { pauseRestartResume: true, pausedBytes: paused.data.downloadedBytes, restoredBytes: restored.downloadedBytes };
      }
      mark('finish resumed YouTube'); assert.equal(added.ok, true, JSON.stringify(added)); const end = Date.now() + 180000; let task;
      while (Date.now() < end) {
        task = (await page.evaluate(() => window.flow.list())).data.find(item => item.id === added.data.id);
        if (['completed', 'failed'].includes(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.equal(task.status, 'completed', JSON.stringify(task));
      const actualHash = crypto.createHash('sha256').update(await fs.readFile(task.path)).digest('hex'); assert.equal(actualHash, task.sha256);
      if (process.env.FLOWDM_EXPECTED_YOUTUBE_SHA256) assert.equal(actualHash, process.env.FLOWDM_EXPECTED_YOUTUBE_SHA256);
      if (resume) { assert.ok(task.media.reusedResources > 0); assert.ok(task.media.reusedBytes > 0); Object.assign(resume, { reusedResources: task.media.reusedResources, reusedBytes: task.media.reusedBytes }); }
      youtube = { bytes: task.totalBytes, sha256: actualHash, matchesFullyDecodedSample: !!process.env.FLOWDM_EXPECTED_YOUTUBE_SHA256, ...(resume ? { resume } : {}) };
    }
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/portable-smoke.png' });
    const report = { status: 'passed', artifact: path.basename(executable), bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), pauseRestartResume: true, mediaToolsVerified: info.data.mediaTools.ready, youtube, at: new Date().toISOString() };
    await fs.writeFile('test-results/portable-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    mark('close verified portable'); await close();
  } catch (error) {
    smokeError = error; console.error(`Portable smoke failed at ${stage}:`, error); throw error;
  } finally {
    if (instance) await close().catch(error => console.error('Portable close during cleanup:', error.message));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => { if (!smokeError) throw error; console.error('Portable cleanup after failure:', error.message); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
