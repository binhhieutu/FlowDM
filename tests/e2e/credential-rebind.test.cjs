'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium, _electron } = require('playwright');
const { createBrowserSetup } = require('../../src/browser/setup.cjs');
const { createRegistration } = require('../../src/browser/registration.cjs');
const { createCredentialFixture } = require('./helpers/credential-fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(40); }
  throw Error('Timeout: ' + description);
}
function fullyDecoded(filename) {
  const executable = process.env.FLOWDM_FFMPEG || (process.platform === 'win32' ? path.resolve('vendor/media-tools/ffmpeg.exe') : 'ffmpeg');
  const result = spawnSync(executable, ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); assert.equal(result.stderr, ''); return true;
}

test('real Chromium rebinds rotated HTTP/HLS cookies after app restart and resumes exact retained data', { timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-credential-chromium-'));
  const userDataDir = path.join(root, 'app'), stateDir = path.join(userDataDir, 'state'), output = path.join(root, 'files');
  const profile = path.join(root, 'profile'), extension = path.join(root, 'extension');
  const f = await createCredentialFixture(t);
  const registrations = createRegistration(), before = {};
  const brands = process.platform === 'win32' ? ['chrome', 'testing', 'chromium'] : ['chromium'];
  let desktop, context, popup, page, worker; const pageErrors = [], rows = [];
  const suffix = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source'; const evidence = 'test-results/credential-rebind-chromium-' + suffix;
  t.after(async () => {
    const failures = [];
    if (context) await context.close().catch(error => failures.push(error));
    const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: stateDir, userDataDir, executablePath: process.execPath });
    for (const brand of brands) if (before[brand]) {
      try { await setup.disconnect(brand); assert.deepEqual(await registrations.read(brand), before[brand], 'Registration not restored: ' + brand); }
      catch (error) { failures.push(error); }
    }
    if (desktop) await desktop.app.close().catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Cleanup failed; preserved private recovery state at ' + root);
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-credential-chromium-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  async function launchDesktop() {
    const executablePath = process.env.FLOWDM_EXECUTABLE;
    const app = await _electron.launch({ chromiumSandbox: true, ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.resolve('.')], env: { ...env, FLOWDM_DATA_DIR: stateDir, FLOWDM_DOWNLOAD_DIR: output } });
    const window = await app.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => pageErrors.push(error.message));
    await window.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor(); return { app, page: window };
  }
  const tasks = async () => (await desktop.page.evaluate(() => window.flow.list())).data;
  const task = async id => (await tasks()).find(value => value.id === id);
  async function popupForFixture() {
    await page.bringToFront(); await popup.reload();
    await until(async () => (await popup.getByTestId('site-origin').textContent()).includes(f.origin), 'popup current fixture origin');
  }
  async function grantConsent() {
    await popupForFixture(); await popup.getByTestId('credentials').check();
    await until(async () => popup.getByTestId('credentials').isChecked(), 'explicit origin consent');
  }
  async function pauseTask(id) {
    await desktop.page.locator('[data-task="' + id + '"]').getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    return until(async () => { const item = await task(id); return item?.status === 'paused' ? item : false; }, 'paused durable task');
  }
  async function resumeTask(id) {
    await desktop.page.locator('[data-task="' + id + '"]').getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    return until(async () => { const item = await task(id); if (item?.status === 'failed') throw Error('Resume failed: ' + item.error); return item?.status === 'completed' ? item : false; }, 'resumed completion');
  }
  async function assertNoPersistenceLeaks() {
    const journal = await fs.readFile(path.join(stateDir, 'downloads.json'), 'utf8');
    const browserStorage = JSON.stringify(await popup.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) })));
    f.assertNoSecrets(journal); f.assertNoSecrets(browserStorage);
    const trace = await worker.evaluate(() => globalThis.credentialNativeTrace || []);
    for (const entry of trace) for (const nonce of [entry.requestId, entry.envelope].filter(Boolean)) { assert.ok(!journal.includes(nonce), 'Nonce entered journal'); assert.ok(!browserStorage.includes(nonce), 'Nonce entered browser storage'); }
  }

  desktop = await launchDesktop();
  assert.equal(await desktop.page.evaluate(() => typeof window.flow.requestCredentials), 'function', 'Desktop credential-request interface is required');
  const version = (await desktop.page.evaluate(() => window.flow.info())).data.version;
  await fs.mkdir(extension, { recursive: true }); await fs.cp(path.resolve('extension'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions.push('cookies'); manifest.optional_permissions = manifest.optional_permissions.filter(value => value !== 'cookies'); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const isolated = path.resolve('.tmp/browser-isolated/FlowDMTestBrowser.exe');
  let executablePath = process.env.FLOWDM_BROWSER_EXECUTABLE;
  if (!executablePath && process.platform === 'win32') { await fs.access(isolated); executablePath = isolated; }
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', ...(executablePath ? { executablePath } : {}), headless: true, acceptDownloads: true, downloadsPath: path.join(root, 'browser-files'), args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(15000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    globalThis.credentialNativeTrace = []; const original = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    chrome.runtime.sendNativeMessage = (host, request, callback) => { globalThis.credentialNativeTrace.push({ op: request.op, requestId: request.payload?.requestId, envelope: request.request_id }); return original(host, request, callback); };
  });
  for (const brand of brands) {
    before[brand] = await registrations.read(brand);
    const result = await desktop.page.evaluate(input => window.flow.browserConnect(input), { browser: brand, extensionId }); assert.equal(result.ok, true, result.error);
  }
  if (process.platform !== 'win32') {
    const state = JSON.parse(await fs.readFile(path.join(userDataDir, 'browser-setup.json'), 'utf8')); const target = path.join(profile, 'NativeMessagingHosts');
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'local.flowdm.bridge.json'), state.browsers.chromium.current);
  }
  page = await context.newPage(); await page.goto(f.origin); popup = await context.newPage(); await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  await context.addCookies([f.grantCookie()]); await grantConsent(); await popup.getByTestId('connections').selectOption('1');
  for (const kind of ['direct', 'hls']) {
    const count = (await tasks()).length;
    if (kind === 'direct') await page.locator('#auth').click();
    else {
      await page.getByRole('button', { name: 'Observe HLS', exact: true }).click(); await popupForFixture();
      await popup.locator('.media').filter({ hasText: 'list.m3u8' }).getByTestId('download-media').click();
    }
    const added = await until(async () => (await tasks()).find(item => item.url === f.urls[kind]), 'browser-created ' + kind);
    assert.equal((await tasks()).length, count + 1); assert.equal(added.requiresHeaders, true); assert.equal(added.connections, 1);
    await until(async () => { const item = await task(added.id); assert.notEqual(item?.status, 'completed', 'Completed before pause'); assert.notEqual(item?.status, 'failed', item?.error); return kind === 'direct' ? item?.downloadedBytes >= 65536 : item?.media?.completedResources >= 1 || item?.media?.completedSegments >= 1; }, 'committed authenticated ' + kind);
    const paused = await pauseTask(added.id); assert.ok(paused.downloadedBytes > 0);
    await desktop.app.close(); desktop = null; f.rotateCookie(); await context.addCookies([f.grantCookie()]); desktop = await launchDesktop();
    const restored = await task(added.id); assert.equal(restored.status, 'paused'); assert.equal(restored.downloadedBytes, paused.downloadedBytes); assert.equal(restored.connections, 1);
    const refused = await desktop.page.evaluate(id => window.flow.action(id, 'resume'), added.id); assert.equal(refused.ok, false, 'Restart should lose RAM credentials');
    const index = f.mark(kind + '-rebind');
    await desktop.page.locator('[data-task="' + added.id + '"]').getByRole('button', { name: 'Kết nối lại từ trình duyệt', exact: true }).click();
    await popupForFixture(); assert.equal(await popup.getByTestId('find-credential-requests').isEnabled(), true);
    await page.bringToFront(); await popup.getByTestId('find-credential-requests').click();
    await popup.getByTestId('rebind-credentials').waitFor(); assert.equal(await popup.getByTestId('rebind-credentials').count(), 1);
    await page.bringToFront(); await popup.getByTestId('rebind-credentials').click();
    await until(async () => (await popup.getByTestId('credential-status').textContent()).startsWith('Đã kết nối lại.'), 'fresh credentials committed');
    const rebound = await task(added.id); assert.equal(rebound.status, 'paused'); assert.equal(rebound.downloadedBytes, restored.downloadedBytes);
    await assertNoPersistenceLeaks(); const done = await resumeTask(added.id); const content = await fs.readFile(done.path);
    assert.deepEqual(content, kind === 'direct' ? f.body : f.hlsBody); assert.equal(done.sha256, f.hashes[kind]); assert.equal(crypto.createHash('sha256').update(content).digest('hex'), done.sha256);
    if (kind === 'direct') f.assertNoCommittedReplay(paused, index); else f.assertHlsCommittedNotReplayed(paused.media.completedResources || paused.media.completedSegments, index);
    const resumedRequests = f.requests.slice(index).filter(entry => kind === 'direct' ? entry.path === '/auth.bin' : entry.path.startsWith('/hls/'));
    assert.ok(resumedRequests.length > 0); assert.ok(resumedRequests.every(entry => entry.cookieAccepted), 'Rebind used an expired cookie');
    rows.push({ kind, taskId: done.id, pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, connections: done.connections, bytes: content.length, sha256: done.sha256, sameTaskPreserved: true, completedDataNotRequestedAgain: true, rotatedCookieAccepted: true, wholeFileDecoded: fullyDecoded(done.path) });
    await assertNoPersistenceLeaks();
  }
  await fs.mkdir('test-results', { recursive: true }); await desktop.page.screenshot({ path: evidence + '.png' });
  await popup.screenshot({ path: evidence + '-popup.png' }); const finalCount = (await tasks()).length;
  await desktop.app.close(); desktop = null;
  const waiting = page.waitForEvent('download'); await page.locator('#fallback').click(); const fallback = await waiting;
  assert.equal(await fallback.failure(), null); assert.deepEqual(await fs.readFile(await fallback.path()), f.body);
  const journal = JSON.parse(await fs.readFile(path.join(stateDir, 'downloads.json'), 'utf8')); assert.equal(journal.tasks.length, finalCount);
  const trace = await worker.evaluate(() => globalThis.credentialNativeTrace);
  assert.equal(trace.filter(entry => entry.op === 'rebindCredentials').length, 2); assert.equal(trace.filter(entry => entry.op === 'commitCredentials').length, 2);
  assert.deepEqual(pageErrors, []);
  const report = { at: new Date().toISOString(), version, packaged: !!process.env.FLOWDM_EXECUTABLE, browser: context.browser().version(), nativeMessaging: true, explicitCookieConsent: true, testProfilePregrantsCookieApi: true, fixtures: { direct: 'real MP4 plus valid ISO-BMFF free padding, 2 MiB', hls: 'three actual MPEG-TS segments' }, rows, hostDownFallback: true, browserStorageAndJournalSecretFree: true, requests: f.requests };
  f.assertNoSecrets(JSON.stringify(report)); await fs.writeFile(evidence + '.json', JSON.stringify(report, null, 2)); t.diagnostic(JSON.stringify({ rows, hostDownFallback: true }));
});
