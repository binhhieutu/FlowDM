const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium, _electron } = require('playwright');
const { createBrowserSetup } = require('../../src/browser/setup.cjs');
const { createRegistration } = require('../../src/browser/registration.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 25000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await check(); if (last) return last; await sleep(100); }
  throw new Error(`Timeout: ${description}`);
}
test('real Chromium extension auto capture, video/HLS, cookie consent and host-down fallback', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-browser-e2e-'));
  const stateDir = path.join(root, 'app', 'state'); const userDataDir = path.dirname(stateDir);
  const profile = path.join(root, 'chromium'); const output = path.join(root, 'files');
  const extension = path.join(root, 'extension'); const fixture = path.resolve(__dirname, '../fixtures/video');
  const dashFixture = path.resolve(__dirname, '../fixtures/dash');
  const body = crypto.randomBytes(2 * 1024 * 1024); let desktop; let context; let popup;
  const registrations = createRegistration(); const before = {};
  const browsers = process.platform === 'win32' ? ['chrome', 'testing', 'chromium'] : ['chromium'];
  const events = []; const tasks = async () => (await desktop.page.evaluate(() => window.flow.list())).data;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>FlowDM browser fixture</title><h1>Browser integration fixture</h1><a id="file" href="/auto.bin" download>Download file</a><a id="fallback" href="/fallback.bin" download>Fallback file</a><a id="auth" href="/auth.bin" download>Authenticated file</a><div id="media"></div>'); return; }
    if (url.pathname.endsWith('.bin')) {
      if (url.pathname === '/auth.bin') events.push({ authRequest: true, hasCookie: Boolean(req.headers.cookie), range: req.headers.range || null });
      if (url.pathname === '/auth.bin' && !req.headers.cookie?.includes('fixture_session=allowed')) { res.writeHead(401).end(); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = range ? +range[1] : 0; const end = range && range[2] ? Math.min(+range[2], body.length - 1) : body.length - 1;
      const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ETag: '"browser-v2"', 'Content-Disposition': `attachment; filename="${url.pathname.slice(1)}"` };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      res.writeHead(range ? 206 : 200, headers); let at = start;
      const timer = setInterval(() => { if (at > end) { clearInterval(timer); res.end(); return; } const next = Math.min(at + 16384, end + 1); res.write(body.subarray(at, next)); at = next; }, 10);
      res.on('close', () => clearInterval(timer)); return;
    }
    const name = path.basename(url.pathname);
    if (url.pathname === `/dash/${name}` && /^(manifest\.mpd|(?:init|chunk)-stream\d+(?:-\d+)?\.m4s)$/.test(name)) {
      try { const data = await fs.readFile(path.join(dashFixture, name)); res.writeHead(200, { 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4', 'Content-Length': data.length }).end(data); } catch { res.writeHead(404).end(); }
      return;
    }
    if (url.pathname !== `/video/${name}` || !/^(?:direct\.mp4|list\.m3u8|fmp4\.m3u8|init\.mp4|segment\d+\.ts|fragment\d+\.m4s)$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const buffer = await fs.readFile(path.join(fixture, name));
      res.writeHead(200, { 'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', 'Content-Length': buffer.length }); res.end(buffer);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const cleanupErrors = [];
    if (context) await context.close().catch(() => {});
    const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: stateDir, userDataDir, executablePath: process.execPath });
    for (const browser of browsers) {
      try { await setup.disconnect(browser); if (before[browser]) assert.deepEqual(await registrations.read(browser), before[browser], `restore ${browser}`); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (desktop) await desktop.app.close().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser registration restoration failed');
  });
  await fs.mkdir(extension, { recursive: true }); await fs.cp(path.resolve('extension'), extension, { recursive: true });
  // Pregrant only the optional cookie API in this disposable test profile. The
  // product's per-origin consent remains off and is explicitly exercised below.
  const manifestPath = path.join(extension, 'manifest.json'); const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions.push('cookies'); manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== 'cookies');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  async function openDesktop() {
    const executablePath = process.env.FLOWDM_EXECUTABLE;
    const app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.resolve('.')], env: { ...env, FLOWDM_DATA_DIR: stateDir, FLOWDM_DOWNLOAD_DIR: output } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
    return { app, page };
  }
  desktop = await openDesktop();
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', ...(process.env.FLOWDM_BROWSER_EXECUTABLE ? { executablePath: process.env.FLOWDM_BROWSER_EXECUTABLE } : {}), headless: true, acceptDownloads: true, downloadsPath: path.join(root, 'browser-files'), args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).hostname;
  t.diagnostic(`Loaded real extension ${extensionId}`);
  for (const browser of browsers) {
    before[browser] = await registrations.read(browser);
    const result = await desktop.page.evaluate(input => window.flow.browserConnect(input), { browser, extensionId });
    assert.equal(result.ok, true, result.error);
  }
  if (process.platform !== 'win32') {
    const state = JSON.parse(await fs.readFile(path.join(userDataDir, 'browser-setup.json'), 'utf8'));
    const target = path.join(profile, 'NativeMessagingHosts'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'local.flowdm.bridge.json'), state.browsers.chromium.current);
  }
  popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupExceptions = [];
  const redact = text => String(text || '').replace(/https?:\/\/[^\s"<>]+/gi, '[URL]');
  popup.on('pageerror', error => popupExceptions.push(redact(error.message)));
  const probe = await popup.evaluate(() => new Promise(resolve => chrome.runtime.sendNativeMessage('local.flowdm.bridge', { schema: 1, request_id: 'probe', op: 'unsupported', payload: { url: 'https://example.com/' } }, response => resolve({ response, error: chrome.runtime.lastError?.message }))));
  assert.equal(probe.response?.error, 'INVALID_REQUEST', JSON.stringify(probe));
  t.diagnostic('Native messaging launches the generated host successfully');
  const page = await context.newPage(); await page.goto(origin);
  await worker.evaluate(() => {
    globalThis.flowTestCreated = []; globalThis.flowTestTrace = [];
    globalThis.flowTestNative = [];
    const sendNative = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    chrome.runtime.sendNativeMessage = (host, request, callback) => sendNative(host, request, response => {
      globalThis.flowTestNative.push({ op: request.op, mediaType: request.payload?.mediaType, ok: response?.ok, error: response?.error, runtimeError: chrome.runtime.lastError?.message });
      callback(response);
    });
    globalThis.flowTestHeaders = []; const remember = capture.remember;
    capture.remember = details => { if (details.url.endsWith('/auth.bin')) globalThis.flowTestHeaders.push({ url: details.url, method: details.method, names: (details.requestHeaders || []).map(header => header.name) }); return remember(details); };
    chrome.downloads.onCreated.addListener(item => globalThis.flowTestCreated.push({ id: item.id, url: item.url, state: item.state, danger: item.danger, filename: item.filename }));
    for (const method of ['pause', 'search', 'resume', 'cancel']) {
      const original = chrome.downloads[method].bind(chrome.downloads);
      chrome.downloads[method] = (...args) => { const callback = args.pop(); return original(...args, result => { globalThis.flowTestTrace.push({ method, error: chrome.runtime.lastError?.message, result }); callback(result); }); };
    }
  });
  await page.locator('#file').click();
  let auto;
  try { auto = await until(async () => (await tasks()).find(item => item.url === `${origin}/auto.bin` && item.status === 'completed'), 'auto capture completed'); }
  catch (error) { const state = await worker.evaluate(() => ({ settings: capture.settings, status })); const created = await worker.evaluate(() => globalThis.flowTestCreated); const trace = await worker.evaluate(() => globalThis.flowTestTrace); throw new Error(`${error.message}: ${JSON.stringify({ state, created, trace, tasks: await tasks() })}`); }
  assert.deepEqual(await fs.readFile(auto.path), body);
  const browserItems = await popup.evaluate(() => chrome.downloads.search({}));
  assert.equal(browserItems.find(item => item.url.endsWith('/auto.bin')).state, 'interrupted');
  t.diagnostic('Auto capture completed exact bytes and original browser download was canceled after ACK');
  await popup.getByTestId('auto-capture').uncheck();
  const count = (await tasks()).length;
  const disabledDownload = page.waitForEvent('download'); await page.locator('#fallback').click(); const disabled = await disabledDownload;
  assert.equal(await disabled.failure(), null); assert.deepEqual(await fs.readFile(await disabled.path()), body); assert.equal((await tasks()).length, count);
  await popup.getByTestId('auto-capture').check();
  // Dynamically inserted direct video gets one trusted-click download button.
  await page.evaluate(() => { const video = document.createElement('video'); video.controls = true; video.src = '/video/direct.mp4'; document.querySelector('#media').append(video); });
  const overlay = page.getByTestId('flowdm-media-overlay').first(); await overlay.waitFor();
  await page.evaluate(() => document.querySelector('[data-testid=flowdm-media-overlay]').click()); await sleep(150); assert.equal((await tasks()).length, count);
  await overlay.click();
  const direct = await until(async () => (await tasks()).find(item => item.url.endsWith('/video/direct.mp4') && item.status === 'completed'), 'direct video download');
  assert.deepEqual(await fs.readFile(direct.path), await fs.readFile(path.join(fixture, 'direct.mp4')));
  // Simulate a player's manifest network requests; actual extension observer
  // records these, then a real extension-page message selects the observed URL.
  await page.evaluate(async () => { await fetch('/video/list.m3u8'); await fetch('/video/fmp4.m3u8'); await fetch('/dash/manifest.mpd'); });
  const tab = await popup.evaluate(async target => (await chrome.tabs.query({})).find(tab => tab.url === target), `${origin}/`);
  assert.ok(tab?.id);
  const state = await until(async () => { const result = await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'flowdm:state', tabId }), tab.id); return result.items?.filter(item => item.mediaType === 'hls').length === 2 ? result : null; }, 'HLS observer');
  assert.equal(state.items.filter(item => item.url.endsWith('/direct.mp4')).length, 1);
  assert.equal(state.items.filter(item => item.mediaType === 'dash').length, 1);
  // Render the real popup for the active fixture page, then use its controls.
  await page.bringToFront(); await popup.reload();
  await popup.getByTestId('download-media').first().waitFor();
  await popup.getByTestId('connections').selectOption('8');
  await popup.screenshot({ path: 'test-results/browser-popup-v2.png' });
  const hlsTasks = [];
  for (const name of ['list.m3u8', 'fmp4.m3u8']) {
    await popup.locator('.media').filter({ hasText: name }).getByTestId('download-media').click();
    hlsTasks.push(await until(async () => (await tasks()).find(item => item.url.endsWith(name) && item.status === 'completed'), `HLS ${name}`));
  }
  const expectedTs = Buffer.concat(await Promise.all(['segment00.ts', 'segment01.ts', 'segment02.ts'].map(name => fs.readFile(path.join(fixture, name)))));
  const expectedMp4 = Buffer.concat(await Promise.all(['init.mp4', 'fragment00.m4s', 'fragment01.m4s', 'fragment02.m4s'].map(name => fs.readFile(path.join(fixture, name)))));
  assert.deepEqual(await fs.readFile(hlsTasks[0].path), expectedTs); assert.deepEqual(await fs.readFile(hlsTasks[1].path), expectedMp4);
  assert.ok(hlsTasks.every(item => item.connections === 8));
  await popup.locator('.media').filter({ hasText: 'manifest.mpd' }).getByTestId('download-media').click();
  let dash;
  try { dash = await until(async () => (await tasks()).find(item => item.mediaType === 'dash' && ['completed', 'failed'].includes(item.status)), 'DASH download'); }
  catch (error) {
    const diagnostic = {
      at: new Date().toISOString(), packaged: !!process.env.FLOWDM_EXECUTABLE,
      tasks: (await tasks()).map(item => ({ id: item.id, status: item.status, mediaType: item.mediaType, error: redact(item.error), downloadedBytes: item.downloadedBytes })),
      popup: { status: redact(await popup.getByTestId('capture-status').textContent()), buttons: await popup.locator('.media').evaluateAll(rows => rows.map(row => ({ mediaType: row.dataset.mediaType, disabled: row.querySelector('button')?.disabled, buttonText: row.querySelector('button')?.textContent }))) },
      popupExceptions,
      native: (await worker.evaluate(() => globalThis.flowTestNative)).map(item => ({ ...item, error: redact(item.error), runtimeError: redact(item.runtimeError) })),
    };
    await fs.mkdir('.tmp', { recursive: true });
    await fs.writeFile('.tmp/v10-browser-legacy-diagnostic.json', JSON.stringify(diagnostic, null, 2));
    throw error;
  }
  assert.equal(dash.status, 'completed', JSON.stringify(dash));
  assert.equal(dash.connections, 8);
  const dashProbe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', dash.path], { encoding: 'utf8', windowsHide: true });
  assert.equal(dashProbe.status, 0, dashProbe.stderr); assert.deepEqual(JSON.parse(dashProbe.stdout).streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  for (const item of [direct, ...hlsTasks, dash]) {
    const decoded = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', item.path, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message); assert.equal(decoded.stderr, '');
  }
  events.push('direct-video-and-hls-ts-fmp4-decoded');
  if (process.env.FLOWDM_LIVE_YOUTUBE) {
    const youtubePage = await context.newPage();
    await youtubePage.goto(process.env.FLOWDM_LIVE_YOUTUBE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await youtubePage.bringToFront(); await popup.reload();
    await popup.getByTestId('connections').selectOption('4');
    const youtubeRow = popup.locator('.media').filter({ hasText: 'YOUTUBE' });
    await youtubeRow.getByTestId('download-media').waitFor();
    await popup.screenshot({ path: 'test-results/youtube-browser-popup-v3.png' });
    await youtubeRow.getByTestId('download-media').click();
    const youtubeTask = await until(async () => (await tasks()).find(item => item.mediaType === 'youtube' && ['completed', 'failed'].includes(item.status)), 'YouTube browser handoff', 120000);
    assert.equal(youtubeTask.status, 'completed', JSON.stringify(youtubeTask));
    assert.equal(youtubeTask.connections, 4);
    const youtubeProbe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', youtubeTask.path], { encoding: 'utf8', windowsHide: true });
    assert.equal(youtubeProbe.status, 0, youtubeProbe.stderr); assert.deepEqual(JSON.parse(youtubeProbe.stdout).streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
    events.push('real-youtube-page-popup-to-native-completed');
    await youtubePage.close(); await page.bringToFront(); await popup.reload();
  }
  // Authentication stays with browser until consent; optional cookie API alone
  // does not authorize handing credentials to native code.
  await context.addCookies([{ name: 'fixture_session', value: 'allowed', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const authCount = (await tasks()).length;
  const authDownload = page.waitForEvent('download'); await page.locator('#auth').click(); const authBrowser = await authDownload;
  assert.equal(await authBrowser.failure(), null, JSON.stringify({ events, headers: await worker.evaluate(() => globalThis.flowTestHeaders), state: await worker.evaluate(() => ({ settings: capture.settings, status })), tasks: await tasks() })); assert.equal((await tasks()).length, authCount);
  await popup.getByTestId('credentials').check();
  await until(async () => (await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'flowdm:state', tabId }), tab.id)).settings.credentials[origin], 'popup credential consent');
  await page.locator('#auth').click();
  const auth = await until(async () => (await tasks()).find(item => item.url.endsWith('/auth.bin') && item.status === 'completed'), 'authenticated capture'); assert.deepEqual(await fs.readFile(auth.path), body);
  const journal = await fs.readFile(path.join(stateDir, 'downloads.json'), 'utf8'); assert.ok(!journal.includes('fixture_session')); assert.ok(!journal.includes('allowed'));
  await context.clearCookies(); await desktop.app.close(); desktop = null;
  const fallbackDownload = page.waitForEvent('download'); await page.locator('#fallback').click(); const fallback = await fallbackDownload;
  assert.equal(await fallback.failure(), null); assert.deepEqual(await fs.readFile(await fallback.path()), body);
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/browser-video-v2.png' });
  const report = { at: new Date().toISOString(), platform: process.platform, extensionId, browser: context.browser().version(), nativeMessaging: true, automaticCapture: true, disabledFallback: true, hostDownFallback: true, cookieConsent: true, syntheticClickBlocked: true, hlsTsFmp4ByteExact: true, decoder: 'ffmpeg', fixturesPregrantCookieApi: true, events };
  await fs.writeFile('test-results/browser-v2.json', JSON.stringify(report, null, 2));
});
