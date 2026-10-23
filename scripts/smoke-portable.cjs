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
  const content = crypto.randomBytes(2 * 1024 * 1024); let instance;
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
    const browser = await chromium.connectOverCDP(endpoint); const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(15000); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
    instance = { child, exited, browser, page }; return instance;
  }
  async function close() {
    if (!instance) return;
    if (instance.page) await instance.page.close().catch(() => {});
    if (instance.browser) await instance.browser.close().catch(() => {});
    let timer;
    try { await Promise.race([instance.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Portable did not shut down')), 20000); })]); }
    finally { clearTimeout(timer); }
    instance = null;
  }
  try {
    let { page } = await launch();
    await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
    await page.getByLabel('Địa chỉ tải').fill(`http://127.0.0.1:${server.address().port}/portable.bin`);
    await page.getByRole('button', { name: 'Bắt đầu tải', exact: true }).click();
    let row = page.locator('[data-task]').filter({ hasText: 'portable.bin' });
    await row.getByText('Đang tải', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    await row.getByText('Tạm dừng', { exact: true }).waitFor();
    await close();
    ({ page } = await launch()); row = page.locator('[data-task]').filter({ hasText: 'portable.bin' });
    await row.getByText('Tạm dừng', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await row.getByText('Hoàn tất', { exact: true }).waitFor({ timeout: 30000 });
    assert.deepEqual(await fs.readFile(path.join(root, 'files', 'portable.bin')), content);
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/portable-smoke.png' });
    const report = { status: 'passed', artifact: path.basename(executable), bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), pauseRestartResume: true, at: new Date().toISOString() };
    await fs.writeFile('test-results/portable-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await close();
  } finally {
    if (instance) await close().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
