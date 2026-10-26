'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCapture } = require('../../extension/capture.js');
const { backgroundFixture } = require('../bridge/extension-fixture.cjs');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const origin = 'https://a.test';
const challenge = () => ({ requestId: 'desktop-nonce', taskId: 'task-1', origin, url: origin + '/private/file.bin', filename: 'file.bin', expiresAt: Date.now() + 120000 });
function fixture(options = {}) {
  const messages = []; let count = 0; let respond;
  const chrome = {
    permissions: { async contains() { return true; } },
    cookies: { async getAll() { return [{ name: 'session', value: 'fresh-private-cookie' }]; } },
    runtime: {
      lastError: null,
      sendNativeMessage(host, request, done) {
        messages.push(request);
        if (respond) return respond(request, done);
        done({ ok: true, request_id: request.request_id, payload: request.op === 'credentialRequests' ? { requests: [challenge()] } : { id: 'task-1', ...(request.op === 'rebindCredentials' ? { prepared: true } : {}) } });
      }
    }
  };
  const capture = createCapture(chrome, { userAgent: () => 'Fixture browser', uuid: () => 'envelope-' + ++count, credentialTimeoutMs: 25, ...options });
  capture.grant(origin);
  return { capture, chrome, messages, set respond(value) { respond = value; } };
}

test('consented rebind lists bounded challenges and prepares then commits fresh exact-origin headers without resuming', async () => {
  const f = fixture(); const request = challenge();
  f.capture.remember({ url: request.url, method: 'GET', requestHeaders: [{ name: 'Authorization', value: 'Bearer current-observed-token' }, { name: 'Cookie', value: 'stale=discard' }, { name: 'Referer', value: origin + '/page' }] });
  const listed = await f.capture.listCredentialRequests(origin);
  assert.equal(listed.ok, true); assert.equal(listed.requests[0].url, request.url);
  assert.equal((await f.capture.rebindCredentials(listed.requests[0])).ok, true);
  assert.deepEqual(f.messages.map(message => message.op), ['credentialRequests', 'rebindCredentials', 'commitCredentials']);
  const prepared = f.messages[1].payload;
  assert.equal(prepared.requestId, 'desktop-nonce'); assert.equal(prepared.taskId, 'task-1'); assert.equal(prepared.origin, origin);
  assert.equal(prepared.headers.Cookie, 'session=fresh-private-cookie');
  assert.equal(prepared.headers.Authorization, 'Bearer current-observed-token');
  assert.equal(prepared.headers['User-Agent'], 'Fixture browser');
  assert.equal(prepared.headers.Referer, origin + '/page');
  assert.deepEqual(f.messages[2].payload, { taskId: 'task-1', origin, requestId: 'desktop-nonce' });
  assert.equal(new Set(f.messages.map(message => message.request_id)).size, 3);
  assert.equal(JSON.stringify(f.capture.settings).includes('private-cookie'), false);
  assert.equal(JSON.stringify(f.capture.settings).includes('desktop-nonce'), false);
});

test('missing consent, cross-origin challenge and absent current authentication never send credentials', async () => {
  const f = fixture(); f.capture.revoke(origin);
  assert.equal((await f.capture.listCredentialRequests(origin)).ok, false);
  assert.equal((await f.capture.rebindCredentials(challenge())).ok, false); assert.equal(f.messages.length, 0);
  f.capture.grant(origin);
  assert.equal((await f.capture.rebindCredentials({ ...challenge(), url: 'https://other.test/file' })).ok, false);
  f.chrome.cookies.getAll = async () => [];
  f.capture.remember({ url: challenge().url, method: 'GET', requestHeaders: [{ name: 'Cookie', value: 'expired=discard' }] });
  assert.equal((await f.capture.rebindCredentials(challenge())).ok, false); assert.equal(f.messages.length, 0);
});

test('revoking then regranting during cookie lookup aborts the old rebind before any credential send', async () => {
  const f = fixture(); let release; let started;
  const began = new Promise(resolve => { started = resolve; });
  f.chrome.cookies.getAll = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.capture.rebindCredentials(challenge()); await began;
  f.capture.revoke(origin); f.capture.grant(origin); release([{ name: 'session', value: 'must-not-send' }]);
  assert.equal((await pending).ok, false); assert.equal(f.messages.length, 0);
});

for (const change of ['consent', 'permission', 'navigation']) test(change + ' changing while desktop prepares cancels without commit', async () => {
  const f = fixture(); let release; let started; let current = true;
  const began = new Promise(resolve => { started = resolve; });
  f.respond = (request, done) => {
    if (request.op === 'rebindCredentials') { release = () => done({ ok: true, request_id: request.request_id, payload: { id: 'task-1', prepared: true } }); started(); }
    else done({ ok: true, request_id: request.request_id, payload: { id: 'task-1' } });
  };
  const pending = f.capture.rebindCredentials(challenge(), { isCurrent: async () => current }); await began;
  if (change === 'consent') { f.capture.revoke(origin); f.capture.grant(origin); }
  if (change === 'permission') { f.capture.permissionsRemoved(); f.capture.grant(origin); }
  if (change === 'navigation') current = false;
  release(); assert.equal((await pending).ok, false);
  assert.deepEqual(f.messages.map(message => message.op), ['rebindCredentials', 'cancelCredentials']);
  assert.equal(f.messages[1].payload.headers, undefined);
});

test('wrong prepare acknowledgement and native timeout cancel instead of committing', async () => {
  for (const bad of ['wrong-id', 'wrong-envelope', 'missing-prepared', 'timeout']) {
    const f = fixture({ credentialTimeoutMs: 10 });
    f.respond = (request, done) => {
      if (request.op === 'cancelCredentials') return done({ ok: true, request_id: request.request_id, payload: { id: 'task-1' } });
      if (bad === 'timeout') return;
      done({ ok: true, request_id: bad === 'wrong-envelope' ? 'other-envelope' : request.request_id, payload: { id: bad === 'wrong-id' ? 'other-task' : 'task-1', ...(bad !== 'missing-prepared' ? { prepared: true } : {}) } });
    };
    assert.equal((await f.capture.rebindCredentials(challenge())).ok, false, bad);
    assert.deepEqual(f.messages.map(message => message.op), ['rebindCredentials', 'cancelCredentials'], bad);
  }
});

test('malformed desktop lists and context changes during list retrieval never expose usable challenges', async () => {
  for (const requests of [[{ ...challenge(), url: 'https://other.test/private' }], Array.from({ length: 9 }, challenge), [{ ...challenge(), expiresAt: Date.now() - 1 }]]) {
    const f = fixture(); f.respond = (request, done) => done({ ok: true, request_id: request.request_id, payload: { requests } });
    assert.equal((await f.capture.listCredentialRequests(origin)).ok, false);
  }
  const f = fixture(); f.respond = (request, done) => { f.capture.revoke(origin); done({ ok: true, request_id: request.request_id, payload: { requests: [challenge()] } }); };
  assert.equal((await f.capture.listCredentialRequests(origin)).ok, false);
});

test('failed prepare returns promptly even when its best-effort cancel receives no acknowledgement', async () => {
  const f = fixture({ credentialTimeoutMs: 3000 });
  f.respond = (request, done) => { if (request.op === 'rebindCredentials') done({ ok: false, request_id: request.request_id }); };
  const started = Date.now(); assert.equal((await f.capture.rebindCredentials(challenge())).ok, false);
  assert.ok(Date.now() - started < 2000, 'Best-effort cancel extended a failed operation by the full prepare timeout');
  assert.deepEqual(f.messages.map(message => message.op), ['rebindCredentials', 'cancelCredentials']);
});

function background() {
  const f = backgroundFixture(); let url = origin + '/page';
  f.chrome.tabs.query = async () => [{ id: 3, url, incognito: false }];
  f.chrome.tabs.get = async id => ({ id, url, incognito: false });
  f.chrome.cookies = { async getAll() { return [{ name: 'session', value: 'new-session' }]; } };
  f.chrome.runtime.sendNativeMessage = (host, request, done) => {
    f.messages.push({ host, request });
    done({ ok: true, request_id: request.request_id, payload: request.op === 'credentialRequests' ? { requests: [challenge()] } : { id: 'task-1', ...(request.op === 'rebindCredentials' ? { prepared: true } : {}) } });
  };
  return { ...f, navigate(value) { url = value; } };
}
test('only trusted current-tab popup may list and submit a cached desktop challenge once', async () => {
  const f = background(); await f.message({ type: 'flowdm:settings', origin, credentials: true });
  const list = { type: 'flowdm:credentialRequests', tabId: 3, origin };
  assert.equal((await f.message(list, { id: 'test-extension', url: origin + '/page', tab: { id: 3 } })).ok, false);
  const listed = await f.message(list); assert.equal(listed.ok, true); assert.equal(listed.requests.length, 1);
  const submit = { type: 'flowdm:rebindCredentials', tabId: 3, origin, taskId: 'task-1', requestId: 'desktop-nonce' };
  assert.equal((await f.message({ ...submit, requestId: 'not-listed' })).ok, false);
  assert.equal((await f.message({ ...submit, url: 'https://other.test/' })).ok, false);
  assert.equal((await f.message(submit)).ok, true);
  assert.equal((await f.message(submit)).ok, false);
  assert.deepEqual(f.messages.map(value => value.request.op), ['credentialRequests', 'rebindCredentials', 'commitCredentials']);
  assert.equal(JSON.stringify(f.local).includes('new-session'), false);
  assert.equal(JSON.stringify(f.local).includes('desktop-nonce'), false);
});

test('tab navigation and incognito invalidate cached challenges without a native prepare', async () => {
  const f = background(); await f.message({ type: 'flowdm:settings', origin, credentials: true });
  await f.message({ type: 'flowdm:credentialRequests', tabId: 3, origin });
  f.navigate('https://other.test/page');
  assert.equal((await f.message({ type: 'flowdm:rebindCredentials', tabId: 3, origin, taskId: 'task-1', requestId: 'desktop-nonce' })).ok, false);
  f.chrome.tabs.query = async () => [{ id: 3, url: origin + '/page', incognito: true }];
  assert.equal((await f.message({ type: 'flowdm:credentialRequests', tabId: 3, origin })).ok, false);
  assert.deepEqual(f.messages.map(value => value.request.op), ['credentialRequests']);
});

async function popup(consented = true) {
  const elements = new Map(); const messages = [];
  const node = () => ({ dataset: {}, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  const document = { createElement: node, querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); } };
  const state = { settings: { autoCapture: true, connections: 4, credentials: consented ? { [origin]: true } : {} }, status: '', items: [{ url: 'https://cdn.test/media.mp4', mediaType: 'direct' }] };
  const chrome = { tabs: { async query() { return [{ id: 3, url: origin + '/page' }]; } }, permissions: { async request() { return true; } }, runtime: { async sendMessage(message) {
    messages.push(message);
    if (message.type === 'flowdm:state') return state;
    if (message.type === 'flowdm:credentialRequests') return { ok: true, requests: [challenge()] };
    return { ok: true };
  } } };
  await vm.runInNewContext(fs.readFileSync(path.resolve('extension/popup.js'), 'utf8'), { chrome, document, URL });
  return { find: name => document.querySelector('[data-testid="' + name + '"]'), messages, state };
}

test('popup explicitly finds pending desktop requests and submits only the selected binding', async () => {
  const f = await popup(); assert.equal(f.messages.some(message => message.type === 'flowdm:credentialRequests'), false);
  assert.equal(f.find('find-credential-requests').disabled, false);
  await f.find('find-credential-requests').onclick();
  const row = f.find('credential-requests').children[0]; assert.equal(row.children[0].textContent, 'file.bin');
  await row.children[1].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1))), { type: 'flowdm:rebindCredentials', tabId: 3, origin, taskId: 'task-1', requestId: 'desktop-nonce' });
  assert.match(f.find('credential-status').textContent, /Tiếp tục/);
  assert.equal(f.messages.some(message => message.type === 'resume'), false);
});

test('popup rebind control requires consent for the active page origin, not another detected media origin', async () => {
  const f = await popup(false); assert.equal(f.find('find-credential-requests').disabled, true);
  await f.find('find-credential-requests').onclick();
  assert.equal(f.messages.some(message => message.type === 'flowdm:credentialRequests'), false);
  const granted = await popup(); await granted.find('credential-origin').onchange({ target: { value: 'https://cdn.test' } });
  assert.equal(granted.find('find-credential-requests').disabled, true);
});

test('Firefox background combines Promise browser APIs with callback native messaging and preloaded scripts', async () => {
  const listeners = {}; const messages = []; const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const action = { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} };
  const chrome = {
    runtime: { id: 'flowdm@local.invalid', onInstalled: event('installed'), onMessage: event('message'), getURL: () => 'moz-extension://private-uuid/', sendNativeMessage(host, request, done) {
      messages.push(request); done({ ok: true, request_id: request.request_id, payload: request.op === 'credentialRequests' ? { requests: [challenge()] } : { id: 'task-1', ...(request.op === 'rebindCredentials' ? { prepared: true } : {}) } });
    } },
    downloads: { onCreated: event('created') }, browserAction: action,
    storage: { local: { get() {} }, session: { get() {} } },
    permissions: { contains() {}, onRemoved: event('permissionRemoved') }, cookies: { getAll() {} },
    contextMenus: { onClicked: event('clicked'), create() {} },
    webRequest: { onBeforeSendHeaders: event('request'), onHeadersReceived: event('headers') },
    tabs: { onUpdated: event('updated'), onRemoved: event('removed') }
  };
  const browser = { ...chrome,
    runtime: { ...chrome.runtime, sendNativeMessage() { throw Error('Native messaging in this adapter must use its callback API'); } },
    storage: { local: { async get() { return { autoCapture: true, credentials: { [origin]: true }, connections: 4 }; }, async set() {} }, session: { async get() { return {}; }, async set() {} } },
    permissions: { async contains() { return true; }, onRemoved: event('permissionRemoved') },
    cookies: { async getAll() { return [{ name: 'session', value: 'firefox-session' }]; } },
    tabs: { ...chrome.tabs, async query() { return [{ id: 3, url: origin + '/page' }]; } }
  };
  const context = vm.createContext({ chrome, browser, URL, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout });
  for (const name of ['capture.js', 'media.js', 'background.js']) vm.runInContext(fs.readFileSync(path.resolve('extension', name), 'utf8'), context);
  const message = input => new Promise(resolve => listeners.message(input, { id: 'flowdm@local.invalid', url: 'moz-extension://private-uuid/popup.html' }, resolve));
  assert.equal((await message({ type: 'flowdm:credentialRequests', tabId: 3, origin })).ok, true);
  assert.equal((await message({ type: 'flowdm:rebindCredentials', tabId: 3, origin, taskId: 'task-1', requestId: 'desktop-nonce' })).ok, true);
  assert.equal(messages[1].payload.headers.Cookie, 'session=firefox-session');
  assert.deepEqual(messages.map(value => value.op), ['credentialRequests', 'rebindCredentials', 'commitCredentials']);
});

function firefoxCapture({ reply = 'ok', cancelWorks = true } = {}) {
  const calls = []; const messages = []; let callback;
  const item = { id: 12, url: origin + '/file.bin', filename: 'C:\\Downloads\\file.bin', state: 'in_progress', danger: 'safe', paused: false, incognito: false, bytesReceived: 0 };
  const chrome = {
    runtime: { lastError: null, sendNativeMessage(host, request, done) {
      calls.push('native:' + request.op); messages.push(request);
      callback = () => done(reply === 'ok' ? { ok: true, request_id: request.request_id, payload: { id: 'durable-task' } } : { ok: false, request_id: request.request_id });
      if (reply !== 'held' && reply !== 'timeout') callback();
    } },
    downloads: {
      pause(id, done) { calls.push('pause'); Object.assign(item, { state: 'interrupted', paused: false, canResume: false, error: 'USER_CANCELED' }); done({ name: 'DownloadError', message: 'Download canceled.' }); },
      resume(id, done) { calls.push('resume'); done(); },
      search(query, done) { calls.push('search'); done([{ ...item }]); },
      cancel(id, done) { calls.push('cancel'); if (cancelWorks) Object.assign(item, { state: 'interrupted', paused: false, canResume: false, error: 'USER_CANCELED' }); done(); }
    },
    permissions: { async contains() { return true; } }, cookies: { async getAll() { return [{ name: 'session', value: 'current' }]; } }
  };
  const capture = createCapture(chrome, { automaticMode: 'ack-before-cancel', timeoutMs: 15, userAgent: () => '' }); capture.grant(origin);
  return { capture, item, calls, messages, chrome, reply: () => callback() };
}

test('Firefox automatic transfer keeps the browser running until durable ACK and verifies cancellation', async () => {
  const f = firefoxCapture();
  assert.deepEqual(await Promise.all([f.capture.automatic({ ...f.item }), f.capture.automatic({ ...f.item })]), [true, false]);
  assert.deepEqual(f.calls, ['search', 'native:add', 'search', 'cancel', 'search']);
  assert.equal(f.messages[0].payload.filename, 'file.bin');
  assert.equal(f.messages[0].payload.headers.Cookie, 'session=current');
  assert.equal(f.messages.length, 1);
});

for (const reply of ['error', 'timeout']) test('Firefox ' + reply + ' leaves the original download entirely untouched', async () => {
  const f = firefoxCapture({ reply }); assert.equal(await f.capture.automatic({ ...f.item }), false);
  assert.equal(f.item.state, 'in_progress'); assert.equal(f.item.bytesReceived, 0);
  assert.equal(f.calls.some(call => ['pause', 'resume', 'cancel'].includes(call)), false);
  if (reply === 'timeout') { f.reply(); assert.equal(f.calls.includes('cancel'), false); }
});

test('Firefox unsafe and already-paused downloads remain in the browser', async () => {
  for (const update of [{ danger: undefined }, { danger: 'dangerous' }, { paused: true }, { incognito: true }, { state: 'complete' }]) {
    const f = firefoxCapture(); Object.assign(f.item, update);
    assert.equal(await f.capture.automatic({ ...f.item }), false);
    assert.equal(f.calls.some(call => call.startsWith('native:') || ['pause', 'resume', 'cancel'].includes(call)), false);
  }
});

for (const change of ['complete', 'unsafe', 'paused', 'source', 'autoCapture', 'permission']) test('Firefox does not cancel after ACK when ' + change + ' changes', async () => {
  const f = firefoxCapture({ reply: 'held' });
  // Supply the held matching ACK after observing the actual native operation.
  f.chrome.runtime.sendNativeMessage = (host, request, done) => {
    f.calls.push('native:' + request.op); f.messages.push(request);
    if (change === 'complete') f.item.state = 'complete';
    if (change === 'unsafe') f.item.danger = 'uncommon';
    if (change === 'paused') f.item.paused = true;
    if (change === 'source') f.item.url = 'https://other.test/file.bin';
    if (change === 'autoCapture') f.capture.settings.autoCapture = false;
    if (change === 'permission') { f.capture.permissionsRemoved(); f.capture.grant(origin); }
    done({ ok: true, request_id: request.request_id, payload: { id: 'durable-task' } });
  };
  assert.equal(await f.capture.automatic({ ...f.item }), false);
  assert.equal(f.calls.some(call => ['pause', 'resume', 'cancel'].includes(call)), false);
});

test('Firefox checks the browser state instead of trusting a no-op cancel callback', async () => {
  const f = firefoxCapture({ cancelWorks: false }); assert.equal(await f.capture.automatic({ ...f.item }), false);
  assert.equal(f.item.state, 'in_progress'); assert.equal(f.calls.includes('cancel'), true);
  assert.equal(f.calls.at(-1), 'search');
});
