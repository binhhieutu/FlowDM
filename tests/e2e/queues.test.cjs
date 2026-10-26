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
async function waitModel(page, predicate, arg, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Timed out waiting for authoritative IPC state');
}
async function removeTestRoot(root, prefix) {
  const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith(prefix));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

test('queue controls create, edit and persist a scheduled queue in real Electron', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-queues-')); let app;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const launch = () => _electron.launch({ chromiumSandbox: true, executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  t.after(async () => { if (app) await app.close(); await removeTestRoot(root, 'flowdm-queues-'); });
  app = await launch(); let page = await app.firstWindow();
  await page.locator('#queue-create').click({ timeout: 5000 });
  await page.locator('#queue-name').fill('Video buổi tối');
  await page.locator('#queue-concurrency').fill('2');
  await page.locator('#queue-speed').fill('512');
  await page.locator('#queue-schedule').check();
  await page.locator('#queue-timezone').fill('Asia/Ho_Chi_Minh');
  await page.locator('#queue-start').fill('22:00'); await page.locator('#queue-stop').fill('06:00');
  await page.locator('#queue-form').evaluate(form => form.requestSubmit());
  await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  const saved = (await page.evaluate(() => window.flow.listQueues())).data.find(queue => queue.name === 'Video buổi tối');
  assert.ok(saved); assert.equal(saved.concurrency, 2); assert.equal(saved.speedLimit, 512 * 1024);
  assert.equal(saved.schedule.start, '22:00'); assert.equal(saved.onComplete, 'none');
  await page.locator('#queue-filter').selectOption(saved.id); await page.locator('#queue-edit').click();
  await page.locator('#queue-name').fill('Video đã sửa'); await page.locator('#queue-form').evaluate(form => form.requestSubmit());
  await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  await page.locator('#queue-toggle').click();
  await app.close(); app = await launch(); page = await app.firstWindow();
  await page.waitForFunction(id => [...document.querySelector('#queue-filter').options].some(option => option.value === id), saved.id);
  const restored = (await page.evaluate(() => window.flow.listQueues())).data.find(queue => queue.id === saved.id);
  assert.equal(restored.name, 'Video đã sửa'); assert.deepEqual(restored.schedule, saved.schedule);
  await page.locator('#queue-filter').selectOption(saved.id); await page.locator('#queue-edit').click();
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/queues-v10-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.png` });
  await fs.writeFile(`test-results/queue-ui-v10-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.json`, JSON.stringify({ at: new Date().toISOString(), appVersion: await app.evaluate(({ app }) => app.getVersion()), packaged: !!process.env.FLOWDM_EXECUTABLE, restored }, null, 2));
});

test('real queue ordering, movement, HTTP/HLS integrity, rate budget and safe power countdown', { timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-queue-transfers-')); let app;
  const direct = Buffer.alloc(256 * 1024, 39); let active = 0; let peak = 0;
  const server = http.createServer(async (req, res) => {
    const name = path.posix.basename(new URL(req.url, 'http://fixture').pathname);
    let data;
    try { data = name.endsWith('.bin') ? direct : await fs.readFile(path.resolve('tests/fixtures/video', name)); }
    catch { res.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : data.length - 1;
    const manifest = name.endsWith('.m3u8');
    res.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Content-Type': manifest ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"queue-fixture"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}) });
    if (manifest || (start === 0 && end === 0)) { res.end(data.subarray(start, end + 1)); return; }
    active++; peak = Math.max(peak, active); let offset = start;
    const timer = setInterval(() => { const next = Math.min(offset + 8192, end + 1); res.write(data.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); res.end(); } }, 20);
    res.once('close', () => { active--; clearInterval(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await removeTestRoot(root, 'flowdm-queue-transfers-'); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const launch = () => _electron.launch({ chromiumSandbox: true, executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  app = await launch(); let page = await app.firstWindow();
  // Mock only the OS adapter boundary in this Electron process. No production test hook.
  const fakePower = () => app.evaluate(({ app }) => {
    const mainRequire = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const { SystemPowerAdapter } = mainRequire(app.getAppPath() + '/src/core/power-actions.cjs');
    globalThis.testActions = [];
    SystemPowerAdapter.prototype.perform = async function(action, context) { globalThis.testActions.push({ action, context, at: Date.now() }); };
  });
  await fakePower();
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function create(name, concurrency, speed = 0) {
    await page.locator('#queue-create').click(); await page.locator('#queue-name').fill(name); await page.locator('#queue-enabled').uncheck();
    await page.locator('#queue-concurrency').fill(String(concurrency)); await page.locator('#queue-speed').fill(String(speed));
    await page.locator('#queue-form').evaluate(form => form.requestSubmit()); await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
    return (await page.evaluate(() => window.flow.listQueues())).data.find(queue => queue.name === name);
  }
  const queue = await create('Tệp kiểm tra', 2, 128), other = await create('Video kiểm tra', 1);
  async function add(name, queueId, url = `${origin}/${name}`) {
    await page.locator('#add-button').click(); await page.locator('#url').fill(url); await page.locator('#filename').fill(name);
    await page.locator('#add-queue').selectOption(queueId); await page.locator('#connections').selectOption('1');
    await page.locator('#add-form').evaluate(form => form.requestSubmit()); await page.locator('#add-dialog').waitFor({ state: 'hidden' });
    return (await page.evaluate(() => window.flow.list())).data.find(task => task.filename === name);
  }
  const first = await add('one.bin', queue.id), second = await add('two.bin', queue.id), third = await add('three.bin', queue.id);
  await page.locator('#queue-filter').selectOption(queue.id);
  await page.locator(`[data-task="${third.id}"]`).getByRole('button', { name: 'Lên trong hàng đợi', exact: true }).click();
  await waitModel(page, async ({ q, id }) => (await window.flow.listQueues()).data.find(queue => queue.id === q).taskIds[1] === id, { q: queue.id, id: third.id });
  await page.locator(`[data-task="${third.id}"]`).getByRole('button', { name: 'Lên trong hàng đợi', exact: true }).click();
  await waitModel(page, async ({ q, id }) => (await window.flow.listQueues()).data.find(queue => queue.id === q).taskIds[0] === id, { q: queue.id, id: third.id });
  await page.locator(`[data-queue-move="${second.id}"]`).selectOption(other.id);
  await page.waitForFunction(id => !document.querySelector(`[data-task="${id}"]`), second.id);
  const order = (await page.evaluate(() => window.flow.listQueues())).data.find(item => item.id === queue.id).taskIds;
  assert.deepEqual(order, [third.id, first.id]);
  await app.close(); app = await launch(); page = await app.firstWindow(); await fakePower();
  await page.waitForFunction(() => !!window.queueUI);
  const persisted = (await page.evaluate(() => window.flow.listQueues())).data.find(item => item.id === queue.id); assert.deepEqual(persisted.taskIds, order); assert.equal((await page.evaluate(() => window.flow.list())).data.length, 3, 'Relaunch dropped persisted tasks');
  await page.locator('#queue-filter').selectOption(queue.id); peak = 0; const started = Date.now(); await page.locator('#queue-toggle').click();
  await waitModel(page, async ids => (await window.flow.list()).data.filter(task => ids.includes(task.id) && task.status === 'downloading' && task.downloadedBytes > 0).length === ids.length, [first.id, third.id]);
  await page.locator('#queue-toggle').click();
  await waitModel(page, async ids => (await window.flow.list()).data.filter(task => ids.includes(task.id) && task.status === 'paused').length === ids.length, [first.id, third.id]);
  await page.locator('#queue-toggle').click();
  await waitModel(page, async ids => (await window.flow.list()).data.filter(task => ids.includes(task.id) && task.status === 'completed').length === ids.length, [first.id, third.id], 30000);
  const elapsed = Date.now() - started; assert.ok(elapsed >= 3000, `Queue cap bypassed: ${elapsed}ms`); assert.equal(peak, 2);
  const completed = (await page.evaluate(() => window.flow.list())).data.filter(task => [first.id, third.id].includes(task.id));
  for (const task of completed) assert.equal(crypto.createHash('sha256').update(await fs.readFile(task.path)).digest('hex'), crypto.createHash('sha256').update(direct).digest('hex'));
  const hls = await add('queue-video.ts', other.id, `${origin}/list.m3u8`);
  await page.locator('#queue-filter').selectOption(other.id); await page.locator('#queue-toggle').click();
  await waitModel(page, async id => (await window.flow.list()).data.find(task => task.id === id)?.status === 'completed', hls.id, 30000);
  const output = (await page.evaluate(() => window.flow.list())).data.find(task => task.id === hls.id);
  const expected = Buffer.concat(await Promise.all(['segment00.ts', 'segment01.ts', 'segment02.ts'].map(name => fs.readFile(path.resolve('tests/fixtures/video', name)))));
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(output.path)).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'));
  const decode = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', output.path, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }); assert.equal(decode.status, 0, decode.stderr);
  const powerQueue = await create('Nguồn giả lập', 1); await page.locator('#queue-edit').click(); await page.locator('#queue-completion').selectOption('shutdown');
  await page.locator('#queue-form').evaluate(form => form.requestSubmit()); await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  await add('power-one.bin', powerQueue.id); await page.locator('#queue-filter').selectOption(powerQueue.id); await page.locator('#queue-toggle').click();
  await page.locator('#power-panel').waitFor({ state: 'visible', timeout: 15000 });
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/queue-power-v10-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.png` });
  const countdown = (await page.evaluate(() => window.flow.powerInfo())).data; assert.ok(countdown.remainingSeconds >= 59); const cancelledAt = Date.now();
  await page.locator('#power-cancel').click(); await page.locator('#power-panel').waitFor({ state: 'hidden' });
  // Wait beyond the real monotonic deadline; cancellation must suppress execution.
  await page.waitForTimeout(61000); assert.deepEqual(await app.evaluate(() => globalThis.testActions), []);
  const secondStarted = Date.now(); await add('power-two.bin', powerQueue.id);
  await page.locator('#power-panel').waitFor({ state: 'visible', timeout: 15000 });
  await waitModel(page, async () => (await window.flow.powerInfo()).data.status === 'completed', null, 70000);
  const calls = await app.evaluate(() => globalThis.testActions); assert.equal(calls.length, 1); assert.equal(calls[0].action, 'shutdown'); assert.ok(calls[0].at - secondStarted >= 60000); assert.ok(calls[0].at - cancelledAt > 120000);
  await fs.mkdir('test-results', { recursive: true }); await fs.writeFile(`test-results/queue-transfers-v10-${process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'}.json`, JSON.stringify({ at: new Date().toISOString(), appVersion: await app.evaluate(({ app }) => app.getVersion()), packaged: !!process.env.FLOWDM_EXECUTABLE, elapsed, peak, order, httpSha256: completed.map(task => task.sha256), hlsSha256: output.sha256, ffmpegDecodeExit: decode.status, firstCountdownSeconds: countdown.remainingSeconds, cancelledAt, secondStarted, calls }, null, 2));
});
