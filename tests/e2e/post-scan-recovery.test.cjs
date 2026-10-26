'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check(); if (value) return value;
    await sleep(30);
  }
  throw Error('Timeout: ' + description);
}

test('owned app crash during post-download scan preserves completed file and requires explicit verified rescan', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-postscan-crash-'));
  const state = path.join(root, 'state'), output = path.join(root, 'files');
  const marker = path.join(root, 'scanner-marker.json'), scanner = path.join(root, 'benign-scanner.cjs');
  const body = Buffer.alloc(65536, 79), expected = crypto.createHash('sha256').update(body).digest('hex');
  let app, page;
  const scannerEnded = async () => {
    let value;
    try { value = JSON.parse(await fs.readFile(marker, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    if (value.done) return true;
    try { process.kill(value.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  // This test process reads the completed file and exits. The first invocation
  // intentionally outlives the app briefly; it never deletes or changes a download.
  await fs.writeFile(scanner, `const fs=require('node:fs');const marker=process.argv[2];fs.statSync(process.argv[3]);if(!fs.existsSync(marker)){fs.writeFileSync(marker,JSON.stringify({started:true,done:false,pid:process.pid}));setTimeout(()=>{fs.writeFileSync(marker,JSON.stringify({started:true,done:true,pid:process.pid}));},1500);}`);
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : body.length - 1;
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: '"postscan-crash"', 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app?.close().catch(() => {});
    // The benign scanner is finite even after app termination; let it finish.
    await until(scannerEnded, 'finite benign scanner exit', 5000).catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-postscan-crash-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'FLOWDM_FFMPEG', 'FLOWDM_YTDLP', 'FLOWDM_ARIA2C'].includes(key.toUpperCase())));
  const launch = async () => {
    const executablePath = process.env.FLOWDM_EXECUTABLE;
    app = await _electron.launch({ chromiumSandbox: true, ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.resolve('.')], env: { ...env, FLOWDM_DATA_DIR: state, FLOWDM_DOWNLOAD_DIR: output } });
    page = await app.firstWindow(); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
  };
  await launch();
  const version = (await page.evaluate(() => window.flow.info())).data.version;
  const configured = await page.evaluate(async config => {
    const existing = await window.flow.preferences();
    return window.flow.configure({ settings: { ...existing.data.settings, scanner: config } });
  }, { enabled: true, executable: process.execPath, args: [scanner, marker, '{file}'], timeoutMs: 10000 });
  assert.equal(configured.ok, true, configured.error);
  const added = await page.evaluate(url => window.flow.add({ url, filename: 'scanned-crash.bin', connections: 1 }), `http://127.0.0.1:${server.address().port}/file`);
  assert.equal(added.ok, true, added.error); const id = added.data.id;
  const current = async () => (await page.evaluate(() => window.flow.list())).data.find(task => task.id === id);
  await until(async () => {
    const task = await current();
    if (task?.status === 'failed') throw Error(task.error);
    if (task?.status !== 'completed' || task.postScan?.status !== 'running') return false;
    try { return JSON.parse(await fs.readFile(marker, 'utf8')).started; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'completed file with an actually running benign scanner');
  const journal = path.join(state, 'downloads.json');
  const before = JSON.parse(await fs.readFile(journal, 'utf8')).tasks.find(task => task.id === id);
  assert.equal(before.status, 'completed'); assert.equal(before.postScan.status, 'running');
  assert.deepEqual(await fs.readFile(before.path), body); assert.equal(before.sha256, expected);
  const ownedProcess = app.process(), exited = once(ownedProcess, 'exit');
  assert.ok(ownedProcess.pid > 0); assert.equal(ownedProcess.kill('SIGKILL'), true); await exited;
  await app.close().catch(() => {}); app = null;
  await sleep(2000);
  await until(scannerEnded, 'benign scanner is no longer running', 5000);
  const scannerExitMode = JSON.parse(await fs.readFile(marker, 'utf8')).done ? 'finite self-exit' : 'terminated with owned Electron app';
  await launch();
  const restored = await current();
  assert.equal(restored.id, id); assert.equal(restored.status, 'completed'); assert.equal(restored.postScan.status, 'failed');
  assert.match(restored.postScan.error, /interrupted/i); assert.equal(restored.sha256, expected); assert.deepEqual(await fs.readFile(restored.path), body);
  await page.locator('[data-filter="failed"]').click();
  await page.locator('#view-title').getByText('Cần xử lý', { exact: true }).waitFor();
  await page.locator(`[data-task="${id}"]`).getByText('Quét lỗi — giữ nguyên tệp', { exact: true }).waitFor();
  const rescanned = await page.evaluate(id => window.flow.rescan(id), id);
  assert.equal(rescanned.ok, true, rescanned.error);
  const done = await until(async () => { const task = await current(); return task?.postScan?.status === 'passed' ? task : null; }, 'explicit verified rescan passes');
  assert.equal(done.id, id); assert.equal(done.status, 'completed'); assert.equal(done.sha256, expected); assert.deepEqual(await fs.readFile(done.path), body);
  await until(async () => await page.locator('#count-failed').textContent() === '0', 'scan failure count cleared');
  await page.locator('[data-filter="all"]').click();
  await page.locator(`[data-task="${id}"]`).getByText('Quét hoàn tất', { exact: true }).waitFor();
  const suffix = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source';
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/post-scan-recovery-v12-${suffix}.png` });
  await fs.writeFile(`test-results/post-scan-recovery-v12-${suffix}.json`, JSON.stringify({ at: new Date().toISOString(), version, packaged: !!process.env.FLOWDM_EXECUTABLE, id, bytes: done.totalBytes, sha256: done.sha256, persistedBeforeCrash: before.postScan.status, recoveredAfterCrash: restored.postScan.status, explicitRescan: done.postScan.status, completedFilePreserved: true, failedFilterVerified: true, finiteBenignScanner: true, scannerExitMode, termination: 'owned app main process only, SIGKILL/TerminateProcess; not power loss' }, null, 2));
});
