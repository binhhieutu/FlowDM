'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(60); } throw Error('Timeout: ' + description); }
async function removeRoot(root) { const resolved = path.resolve(root); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('flowdm-batch-v11-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
test('batch preview creates only selected queue jobs and bounded Site Grabber cancels without losing downloads', { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-batch-v11-')); const destination = path.join(root, 'chosen-files'); await fs.mkdir(destination);
  let app; let outsideHits = 0; let slowHits = 0; const requests = [];
  const body = Buffer.alloc(64 * 1024, 71); const hash = crypto.createHash('sha256').update(body).digest('hex');
  const outside = http.createServer((_req, res) => { outsideHits++; res.end('<a href="/private">outside</a>'); }); await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); requests.push(url.pathname);
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${outside.address().port}/outside` }).end(); return; }
    if (url.pathname === '/slow.html') { slowHits++; const timer = setTimeout(() => res.end('<a href="/never.html">never</a>'), 3000); res.once('close', () => clearTimeout(timer)); return; }
    if (url.pathname === '/index.html') { res.setHeader('Content-Type', 'text/html'); res.end('<a href="/one.bin#first">one</a><a href="/one.bin#duplicate">duplicate</a><a href="/%E1%BA%A3nh.bin">ảnh</a><a href="/child.html">child</a><a href="/redirect">redirect</a><a href="javascript:alert(1)">bad</a>'); return; }
    if (url.pathname === '/child.html') { res.setHeader('Content-Type', 'text/html'); res.end('<a href="/index.html">loop</a><a href="/two.bin">two</a>'); return; }
    if (url.pathname.endsWith('.bin')) { const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || ''); const start = range ? +range[1] : 0; const end = range?.[2] ? +range[2] : body.length - 1; res.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"batch-v11"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) }); res.end(body.subarray(start, end + 1)); return; }
    res.writeHead(404).end();
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (app) await app.close(); for (const item of [server, outside]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); } await removeRoot(root); });
  const origin = `http://127.0.0.1:${server.address().port}`; const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'default-files') } });
  const page = await app.firstWindow(); await page.locator('#batch-button').click({ timeout: 3000 });
  assert.equal((await page.evaluate(() => window.flow.list())).data.length, 0); assert.equal(requests.length, 0, 'opening must not fetch');
  const queue = (await page.evaluate(() => window.flow.createQueue({ name: 'Batch test', enabled: false, concurrency: 2 }))).data;
  await page.locator('#batch-text').fill([origin + '/one.bin#one', origin + '/one.bin#two', 'not a url', origin + '/%E1%BA%A3nh.bin', origin + '/unselected.bin'].join('\n'));
  await page.locator('#batch-preview').click(); await until(async () => await page.locator('#batch-results input[type=checkbox]').count() === 3, 'three canonical preview entries');
  assert.equal(await page.locator('#batch-results input:checked').count(), 0, 'preview unchecked'); assert.equal(requests.length, 0, 'preview must not fetch'); assert.match(await page.locator('#batch-message').textContent(), /1 trùng.*1 dòng lỗi/);
  await page.locator('#batch-filter').fill('unselected'); assert.equal(await page.locator('#batch-results input[type=checkbox]').count(), 1);
  await page.locator('#batch-filter').fill('.bin'); await page.locator('#batch-results input[type=checkbox]').nth(0).check(); await page.locator('#batch-results input[type=checkbox]').nth(1).check();
  await page.locator('#batch-queue').selectOption(queue.id);
  await app.evaluate(({ app }, directory) => { const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json'); require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, destination);
  await page.locator('#batch-choose-directory').click(); assert.equal(await page.locator('#batch-directory').inputValue(), destination);
  await page.locator('#batch-connections').selectOption('2');
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/batch-preview-v11-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.png` });
  await page.locator('#batch-submit').click();
  const submitted = await until(async () => { const jobs = (await page.evaluate(() => window.flow.list())).data; return jobs.length === 2 && jobs; }, 'selected jobs only');
  assert.ok(submitted.every(task => task.queueId === queue.id && task.connections === 2 && path.dirname(task.path) === destination)); assert.ok(submitted.some(task => task.filename === 'ảnh.bin')); assert.ok(submitted.every(task => task.status === 'queued')); assert.equal(requests.length, 0);
  await page.evaluate(id => window.flow.resumeQueue(id), queue.id); const done = await until(async () => { const jobs = (await page.evaluate(() => window.flow.list())).data; return jobs.every(task => task.status === 'completed') && jobs; }, 'download exact bytes');
  for (const task of done) { assert.equal(task.sha256, hash); assert.deepEqual(await fs.readFile(task.path), body); }
  await page.locator('.grab-section summary').click();
  await page.locator('#grab-seed').fill(origin + '/index.html'); await page.locator('#grab-depth').fill('2'); await page.locator('#grab-pages').fill('6'); await page.locator('#grab-start').click();
  await until(async () => /completed|Hoàn tất|hoàn tất/.test(await page.locator('#grab-status').textContent()), 'bounded crawl finish');
  const crawl = (await page.evaluate(() => window.flow.listGrabs())).data[0]; assert.equal(crawl.status, 'completed'); assert.ok(crawl.pages <= 6); assert.ok(crawl.links.length <= 1000); assert.ok(crawl.links.some(link => link.url.endsWith('/two.bin')));
  assert.equal(outsideHits, 0); assert.ok(requests.filter(route => route === '/index.html').length <= 1); assert.ok(await page.locator('#batch-results input[type=checkbox]').count() <= 6);
  assert.equal((await page.evaluate(() => window.flow.list())).data.length, 2, 'discovery creates no tasks');
  await page.locator('#grab-seed').fill(origin + '/slow.html'); await page.locator('#grab-start').click(); await until(() => slowHits > 0, 'crawl started'); await page.locator('#grab-cancel').click();
  await until(async () => /cancelled|Đã dừng|đã dừng/.test(await page.locator('#grab-status').textContent()), 'crawl canceled'); const count = requests.length; await sleep(350); assert.equal(requests.length, count); assert.equal((await page.evaluate(() => window.flow.list())).data.length, 2);
  await page.locator('#grab-start').click(); await until(() => slowHits > 1, 'second crawl started');
  await app.evaluate(({ BrowserWindow }, text) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text }), origin + '/from-browser.bin');
  await until(async () => /Đã dừng/.test(await page.locator('#grab-status').textContent()), 'browser staging cancels previous discovery');
  assert.equal(await page.locator('#batch-text').inputValue(), origin + '/from-browser.bin'); assert.equal((await page.evaluate(() => window.flow.list())).data.length, 2, 'browser preview creates no job');
  const suffix = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'; await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/batch-v11-${suffix}.png` });
  await fs.writeFile(`test-results/batch-v11-${suffix}.json`, JSON.stringify({ at: new Date().toISOString(), appVersion: await app.evaluate(({ app }) => app.getVersion()), packaged: !!process.env.FLOWDM_EXECUTABLE, created: done.map(task => ({ id: task.id, filename: task.filename, queueId: task.queueId, connections: task.connections, sha256: task.sha256, bytes: task.totalBytes })), expectedHash: hash, selectedOnly: true, initialCheckboxesUnchecked: true, queueAndDestinationVerified: true, duplicateCount: 1, invalidLineCount: 1, crawl: { pages: crawl.pages, links: crawl.links.length, errors: crawl.errors }, outsideHits, requests, cancellationPreservedJobs: true }, null, 2));
});

async function raceDesktop(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-batch-v11-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  t.after(async () => { await app.close(); await removeRoot(root); });
  return { app, page: await app.firstWindow() };
}
test('late preview response cannot replace newer staged text or a closed and reopened view', { timeout: 30000 }, async t => {
  const { app, page } = await raceDesktop(t); await page.locator('#batch-button').click();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('flow:previewBatch');
    ipcMain.handle('flow:previewBatch', () => new Promise(resolve => setTimeout(() => resolve({ ok: true, data: { urls: ['https://example.invalid/old.bin'], errors: [], duplicates: 0 } }), 200)));
  });
  await page.locator('#batch-text').fill('https://example.invalid/old.bin'); await page.locator('#batch-preview').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text: 'https://example.invalid/new.bin' }));
  await sleep(350); assert.equal(await page.locator('#batch-text').inputValue(), 'https://example.invalid/new.bin'); assert.equal(await page.locator('#batch-results input').count(), 0);
  await page.locator('#batch-preview').click(); await page.locator('#batch-close').click(); await page.locator('#batch-button').click(); await sleep(350);
  assert.equal(await page.locator('#batch-results input').count(), 0); assert.equal((await page.evaluate(() => window.flow.list())).data.length, 0);
});
test('late crawler start acknowledgment is cancelled after a newer browser preview', { timeout: 30000 }, async t => {
  const { app, page } = await raceDesktop(t); await page.locator('#batch-button').click(); await page.locator('.grab-section summary').click();
  await app.evaluate(({ ipcMain }) => {
    globalThis.batchRaceCancelled = [];
    ipcMain.removeHandler('flow:startGrab'); ipcMain.removeHandler('flow:cancelGrab');
    ipcMain.handle('flow:startGrab', () => new Promise(resolve => setTimeout(() => resolve({ ok: true, data: { id: 'late-test-grab' } }), 200)));
    ipcMain.handle('flow:cancelGrab', (_event, input) => {
      globalThis.batchRaceCancelled.push(input.id);
      return { ok: true, data: { id: input.id, status: 'cancelled', pages: 0, links: [], errors: [] } };
    });
  });
  await page.locator('#grab-seed').fill('https://example.invalid/old'); await page.locator('#grab-start').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text: 'https://example.invalid/new.bin' }));
  await until(() => app.evaluate(() => globalThis.batchRaceCancelled.includes('late-test-grab')), 'late start cancellation', 3000);
  assert.equal(await page.locator('#batch-text').inputValue(), 'https://example.invalid/new.bin'); assert.equal(await page.locator('#batch-results input').count(), 0);
  assert.equal(await page.locator('#grab-start').isEnabled(), true); assert.equal((await page.evaluate(() => window.flow.list())).data.length, 0);
});

test('stale directory picker results and errors cannot change a newer staged batch', { timeout: 30000 }, async t => {
  for (const outcome of ['success', 'error']) await t.test(outcome, async sub => {
    const { app, page } = await raceDesktop(sub); await page.locator('#batch-button').click();
    const original = await until(async () => await page.locator('#batch-directory').inputValue(), 'initial directory');
    await app.evaluate(({ ipcMain }, outcome) => {
      ipcMain.removeHandler('flow:chooseDirectory');
      ipcMain.handle('flow:chooseDirectory', () => new Promise(resolve => setTimeout(() => resolve(outcome === 'success' ? { ok: true, data: 'C:\\stale-picker' } : { ok: false, error: 'Stale picker failed' }), 200)));
    }, outcome);
    await page.locator('#batch-choose-directory').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text: 'https://example.invalid/new.bin' }));
    await sleep(350);
    assert.equal(await page.locator('#batch-directory').inputValue(), original, 'stale picker must not replace newer batch destination');
    assert.equal(await page.locator('#batch-error').isHidden(), true, 'stale picker errors must not appear in newer batch');
  });
});

test('stale queue refresh cannot replace newer staged batch queue options or selection', { timeout: 30000 }, async t => {
  const { app, page } = await raceDesktop(t); await page.locator('#batch-button').click();
  await until(async () => await page.locator('#batch-directory').inputValue(), 'initial view loaded');
  await app.evaluate(({ ipcMain }) => {
    globalThis.batchQueueCalls = 0;
    ipcMain.removeHandler('flow:listQueues');
    ipcMain.handle('flow:listQueues', () => {
      const first = ++globalThis.batchQueueCalls === 1;
      const data = [{ id: 'default', name: 'Default' }, { id: first ? 'old-queue' : 'new-queue', name: first ? 'Old queue' : 'New queue' }];
      return new Promise(resolve => setTimeout(() => resolve({ ok: true, data }), first ? 300 : 0));
    });
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text: 'https://example.invalid/old.bin' }));
  await until(() => app.evaluate(() => globalThis.batchQueueCalls === 1), 'first queue refresh');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('flow:batchPreview', { text: 'https://example.invalid/new.bin' }));
  await until(async () => await page.locator('#batch-queue option[value="new-queue"]').count() === 1, 'new queue options');
  await page.locator('#batch-queue').selectOption('new-queue'); await sleep(400);
  assert.equal(await page.locator('#batch-queue').inputValue(), 'new-queue'); assert.equal(await page.locator('#batch-queue option[value="old-queue"]').count(), 0);
});
