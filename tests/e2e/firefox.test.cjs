'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createBrowserSetup } = require('../../src/browser/setup.cjs');
const { createRegistration, registrationTarget } = require('../../src/browser/registration.cjs');
const { FIREFOX_EXTENSION_ID } = require('../../src/browser/firefox-manifest.cjs');
const { launchFirefox } = require('../helpers/firefox-driver.cjs');
const { createCredentialFixture } = require('./helpers/credential-fixture.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(50); }
  throw Error('Firefox E2E timeout: ' + label);
}
test('real Firefox captures authenticated HTTP/HLS, rebinds after app restart and restores native registration', { timeout: 240000, skip: !process.env.FLOWDM_GECKODRIVER }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-firefox-e2e-'));
  const stateDir = path.join(root, 'app', 'state'), userDataDir = path.dirname(stateDir), output = path.join(root, 'files');
  const fixture = await createCredentialFixture(t, { directBytes: 2 * 1024 ** 2, chunkDelayMs: 40, hlsDelayMs: 500 });
  const registration = createRegistration(); const before = await registration.read('firefox');
  const registration64 = createRegistration({ exec: (file, args, options) => execFile(file, args.map(arg => arg === '/reg:32' ? '/reg:64' : arg), options) });
  const before64 = process.platform === 'win32' ? await registration64.read('firefox') : null;
  let desktop, firefox; const report = { at: new Date().toISOString(), packaged: !!process.env.FLOWDM_EXECUTABLE, rows: [], firefoxBrowserHandoff: 'ack-before-cancel', fixturesPregrantCookieApi: true, scope: 'private Firefox profile, temporary unsigned addon, authenticated local actual video fixtures' };
  let stage = 'launch'; const suffix = process.env.FLOWDM_EXECUTABLE ? 'packaged' : 'source';
  const evidence = 'test-results/firefox-credential-v9-' + suffix;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  async function openDesktop() {
    const executablePath = process.env.FLOWDM_EXECUTABLE;
    const app = await _electron.launch({ chromiumSandbox: true, ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.resolve('.')], env: { ...env, FLOWDM_DATA_DIR: stateDir, FLOWDM_DOWNLOAD_DIR: output } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
    return { app, page };
  }
  const tasks = async () => (await desktop.page.evaluate(() => window.flow.list())).data;
  const current = async id => (await tasks()).find(task => task.id === id);
  t.after(async () => {
    const errors = []; report.stage = stage; if (!report.status) report.status = 'failed';
    if (report.status === 'failed' && firefox) {
      await firefox.switchTo((await firefox.handles())[0]).catch(() => {});
      report.failureState = await firefox.evaluate(async () => ({ state: await browser.runtime.sendMessage({ type: 'flowdm:state' }), trace: (await browser.runtime.getBackgroundPage()).flowTestTrace, downloads: (await browser.downloads.search({})).map(item => ({ id: item.id, url: item.url, state: item.state, danger: item.danger, paused: item.paused, canResume: item.canResume, bytesReceived: item.bytesReceived, incognito: item.incognito, error: item.error })) })).catch(error => ({ error: error.message }));
      if (desktop) report.taskStates = (await tasks()).map(task => ({ mediaType: task.mediaType, status: task.status, downloadedBytes: task.downloadedBytes, error: task.error }));
    }
    await fs.mkdir('test-results', { recursive: true });
    if (firefox) { await firefox.screenshot(evidence + '.png').catch(() => {}); await firefox.close().catch(error => errors.push(error)); }
    const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: stateDir, userDataDir, executablePath: process.execPath });
    try { await setup.disconnect('firefox'); assert.deepEqual(await registration.read('firefox'), before); if (before64) assert.deepEqual(await registration64.read('firefox'), before64); report.registrationRestored = true; report.registryViewsRestored = process.platform === 'win32' ? [32, 64] : []; } catch (error) { errors.push(error); }
    if (desktop) await desktop.app.close().catch(error => errors.push(error));
    const serialized = JSON.stringify(report, null, 2); fixture.assertNoSecrets(serialized); await fs.writeFile(evidence + '.json', serialized);
    try { await fs.copyFile(path.join(root, 'geckodriver.log'), evidence + '-driver.log'); } catch {}
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-firefox-e2e-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (errors.length) throw new AggregateError(errors, 'Firefox test cleanup failed');
  });
  desktop = await openDesktop(); report.version = (await desktop.page.evaluate(() => window.flow.info())).data.version;
  stage = 'Firefox desktop setup';
  await desktop.page.locator('#browser-button').click(); await desktop.page.locator('#browser-kind').selectOption('firefox');
  await until(async () => await desktop.page.locator('#browser-extension-id').inputValue() === FIREFOX_EXTENSION_ID, 'Firefox ID preset');
  await desktop.page.locator('#browser-connect').click();
  await until(async () => (await desktop.page.evaluate(() => window.flow.browserInfo())).data.browsers.some(item => item.browser === 'firefox' && item.connected), 'Firefox connected');
  await desktop.page.locator('#browser-close').click();
  const info = (await desktop.page.evaluate(() => window.flow.browserInfo())).data;
  const extension = info.extensionPaths.firefox; const manifestFile = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  // Only the disposable test copy pregrants the optional cookie API. Product
  // per-origin consent is still disabled initially and exercised through UI.
  // Firefox still requires request() permissions to remain declared optional,
  // even when the disposable profile has already granted that API at install.
  manifest.permissions.push('cookies');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  if (process.env.FLOWDM_FIREFOX_TRACE === '1') await fs.appendFile(path.join(extension, 'background.js'), '\n globalThis.flowTestTrace=[]; for(const method of ["pause","search","resume","cancel"]){const original=chrome.downloads[method].bind(chrome.downloads);chrome.downloads[method]=(...args)=>{const callback=args.pop();return original(...args,result=>{globalThis.flowTestTrace.push({method,error:chrome.runtime.lastError?.message,result:method==="search"?result?.map(item=>({id:item.id,state:item.state,paused:item.paused,canResume:item.canResume,bytesReceived:item.bytesReceived,danger:item.danger,error:item.error})):result});callback(result);});};}\n');
  const uuid = crypto.randomUUID(), popupUrl = `moz-extension://${uuid}/popup.html`;
  firefox = await launchFirefox({ directory: root, executable: process.env.FLOWDM_FIREFOX_EXECUTABLE || 'C:/Program Files/Mozilla Firefox/firefox.exe', geckodriver: process.env.FLOWDM_GECKODRIVER, downloadDirectory: path.join(root, 'browser-files'), extensionId: FIREFOX_EXTENSION_ID, uuid });
  report.firefoxVersion = firefox.version; assert.equal(await firefox.install(extension), FIREFOX_EXTENSION_ID);
  await firefox.navigate(popupUrl); const popupHandle = (await firefox.handles())[0];
  const fixtureTabId = await firefox.evaluate(async url => (await browser.tabs.create({ url, active: true })).id, fixture.origin + '/');
  await until(async () => (await firefox.evaluate(() => browser.tabs.query({}))).some(tab => tab.id === fixtureTabId && tab.url === fixture.origin + '/' && tab.status === 'complete'), 'fixture tab loaded');
  const fixtureHandle = (await firefox.handles()).find(handle => handle !== popupHandle);
  async function popup() {
    await firefox.switchTo(popupHandle); await firefox.evaluate(id => browser.tabs.update(id, { active: true }), fixtureTabId); await firefox.navigate(popupUrl);
    await until(async () => await firefox.evaluate(() => !document.querySelector('[data-testid=credentials]').disabled && document.querySelector('[data-testid=capture-status]').textContent !== 'Đang đọc trạng thái…'), 'popup for active website');
  }
  async function fixtureClick(selector) { await firefox.switchTo(fixtureHandle); await until(async () => await firefox.evaluate(value => !!document.querySelector(value), selector), 'fixture clickable ' + selector); await firefox.click(selector); }
  stage = 'rendered page links preview';
  report.version = (await desktop.page.evaluate(() => window.flow.info())).data.version;
  await firefox.switchTo(fixtureHandle);
  await firefox.evaluate(origin => { const a = document.createElement('a'); a.href = origin + '/page-links-only.bin'; a.textContent = 'Explicit link preview'; document.body.append(a); }, fixture.origin);
  await popup(); await firefox.click('[data-testid=collect-page-links]');
  await until(async () => await firefox.evaluate(() => document.querySelectorAll('[data-testid=page-links-list] input').length > 0), 'Firefox page links');
  assert.equal(await firefox.evaluate(() => document.querySelectorAll('[data-testid=page-links-list] input:checked').length), 0);
  await firefox.evaluate(() => { const filter = document.querySelector('[data-testid=page-links-filter]'); filter.value = 'page-links-only.bin'; filter.dispatchEvent(new Event('input')); });
  await firefox.click('[data-testid=page-links-list] input'); await firefox.click('[data-testid=preview-page-links]');
  await desktop.page.locator('#batch-dialog').waitFor({ state: 'visible' });
  assert.equal(await desktop.page.locator('#batch-text').inputValue(), fixture.origin + '/page-links-only.bin');
  assert.equal((await tasks()).length, 0); await desktop.page.locator('#batch-close').click();
  report.pageLinks = { uncheckedByDefault: true, selected: 1, desktopPreviewOnly: true, jobsCreated: 0 };
  stage = 'cookie without consent stays in Firefox';
  await firefox.evaluate(cookie => browser.cookies.set({ ...cookie, sameSite: cookie.sameSite.toLowerCase() }), fixture.grantCookie());
  await fixtureClick('#auth'); await popup();
  const unconsented = await until(async () => (await firefox.evaluate(() => browser.downloads.search({}))).find(item => item.url === fixture.urls.direct && item.state === 'complete'), 'no-consent browser download');
  assert.ok(unconsented.filename.startsWith(path.join(root, 'browser-files') + path.sep)); assert.deepEqual(await fs.readFile(unconsented.filename), fixture.body);
  assert.equal((await tasks()).length, 0);
  await firefox.click('[data-testid=credentials]');
  await until(async () => (await firefox.evaluate(() => browser.runtime.sendMessage({ type: 'flowdm:state' }))).settings.credentials[fixture.origin], 'explicit Firefox origin consent');
  await firefox.evaluate(() => browser.runtime.sendMessage({ type: 'flowdm:settings', connections: 1 }));
  for (const type of ['direct', 'hls']) {
    stage = type + ' captured';
    const previous = new Set((await tasks()).map(task => task.id));
    if (type === 'direct') await fixtureClick('#auth');
    else { await fixtureClick('#load-hls'); await popup(); await until(async () => await firefox.evaluate(() => [...document.querySelectorAll('.media')].some(row => row.textContent.includes('list.m3u8'))), 'HLS detected'); await firefox.click('.media[data-media-type="hls"] [data-testid=download-media]'); }
    const added = await until(async () => (await tasks()).find(task => !previous.has(task.id) && task.url === fixture.urls[type]), 'captured ' + type, 10000);
    if (type === 'direct') {
      await popup();
      const original = await until(async () => (await firefox.evaluate(() => browser.downloads.search({}))).find(item => item.url === fixture.urls.direct && item.id !== unconsented.id && item.state === 'interrupted'), 'original Firefox download canceled after native handoff');
      assert.equal(original.error, 'USER_CANCELED'); assert.equal(original.paused, false);
      report.automaticBrowserDownloadCanceled = true;
    }
    const live = await until(async () => { const task = await current(added.id); assert.notEqual(task.status, 'failed', task.error); return type === 'direct' ? task.downloadedBytes >= 65536 && task.status === 'downloading' ? task : false : (task.media?.completedResources || task.media?.completedSegments || 0) >= 1 && task.status === 'downloading' ? task : false; }, 'partial ' + type);
    await desktop.page.evaluate(id => window.flow.action(id, 'pause'), added.id); const paused = await current(added.id); assert.equal(paused.status, 'paused');
    const mark = fixture.mark('paused-' + type); await desktop.app.close(); desktop = null;
    fixture.rotateCookie(); await popup(); await firefox.evaluate(cookie => browser.cookies.set({ ...cookie, sameSite: cookie.sameSite.toLowerCase() }), fixture.grantCookie());
    desktop = await openDesktop(); const restored = await current(added.id); assert.equal(restored.status, 'paused'); assert.equal(restored.connections, 1); assert.ok(restored.downloadedBytes >= paused.downloadedBytes);
    const denied = await desktop.page.evaluate(id => window.flow.action(id, 'resume'), added.id); assert.equal(denied.ok, false);
    stage = type + ' credential request';
    const challenge = await desktop.page.evaluate(id => window.flow.requestCredentials(id), added.id); assert.equal(challenge.ok, true, challenge.error);
    await popup(); await firefox.click('[data-testid=find-credential-requests]');
    await until(async () => await firefox.evaluate(() => document.querySelectorAll('[data-testid=rebind-credentials]').length), 'rebind row');
    await firefox.click('[data-testid=rebind-credentials]');
    await until(async () => await firefox.evaluate(() => document.querySelector('[data-testid=credential-status]').textContent.includes('Đã')), 'credential rebind ACK');
    const resumed = await desktop.page.evaluate(id => window.flow.action(id, 'resume'), added.id); assert.equal(resumed.ok, true, resumed.error);
    const done = await until(async () => { const task = await current(added.id); if (task.status === 'failed') throw Error(task.error); return task.status === 'completed' ? task : false; }, 'resumed complete ' + type);
    assert.equal(done.sha256, fixture.hashes[type]); assert.deepEqual(await fs.readFile(done.path), type === 'direct' ? fixture.body : fixture.hlsBody);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', done.path, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(decoded.status, 0, decoded.stderr); assert.equal(decoded.stderr, '');
    if (type === 'direct') fixture.assertNoCommittedReplay(paused, mark); else fixture.assertHlsCommittedNotReplayed(paused.media.completedResources || paused.media.completedSegments, mark);
    fixture.assertNoSecrets(await fs.readFile(path.join(stateDir, 'downloads.json'), 'utf8'));
    report.rows.push({ type, transitions: ['capture', 'pause', 'close', 'relaunch', 'rebind', 'resume'], pausedBytes: paused.downloadedBytes, restoredBytes: restored.downloadedBytes, bytes: done.totalBytes, sha256: done.sha256, connections: done.connections, committedReplay: false, wholeFileDecoded: true });
    // Resume tests explicitly use N1. Keep the next capture's preference stable.
    await popup(); await firefox.evaluate(() => browser.runtime.sendMessage({ type: 'flowdm:settings', connections: 1 }));
  }
  stage = 'host down fallback'; await desktop.app.close(); desktop = null;
  await fixtureClick('#fallback'); await popup();
  const fallback = await until(async () => (await firefox.evaluate(() => browser.downloads.search({}))).find(item => item.url === fixture.urls.fallback && item.state === 'complete'), 'host-down fallback completed in Firefox');
  assert.ok(fallback.filename.startsWith(path.join(root, 'browser-files') + path.sep)); assert.deepEqual(await fs.readFile(fallback.filename), fixture.body);
  const journal = JSON.parse(await fs.readFile(path.join(stateDir, 'downloads.json'), 'utf8')); assert.equal(journal.tasks.length, 2);
  report.nativeMessaging = true; report.cookieConsent = true; report.hostDownFallback = true; report.status = 'passed'; stage = 'complete';
  t.diagnostic(JSON.stringify(report));
});
