'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createBrowserSetup } = require('../../src/browser/setup.cjs');
const { registrationTarget, createRegistration } = require('../../src/browser/registration.cjs');
const { createHostBundle } = require('../../src/bridge/install.cjs');
const GECKO_ID = 'flowdm@local.invalid';
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-firefox-setup-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-firefox-setup-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}
test('Firefox registration targets only per-user Mozilla locations', () => {
  assert.equal(registrationTarget('firefox', 'win32', '/home/test'), 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\local.flowdm.bridge');
  assert.equal(registrationTarget('firefox', 'linux', '/home/test'), path.join('/home/test', '.mozilla', 'native-messaging-hosts', 'local.flowdm.bridge.json'));
  assert.equal(registrationTarget('firefox', 'darwin', '/home/test'), path.join('/home/test', 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', 'local.flowdm.bridge.json'));
});
test('Firefox host grants one exact Gecko ID without Chromium origins', async t => {
  const root = await directory(t);
  const bundle = await createHostBundle({ output: path.join(root, 'host'), dataDir: root, extensionId: GECKO_ID, browser: 'firefox' });
  const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
  assert.deepEqual(manifest.allowed_extensions, [GECKO_ID]); assert.equal(manifest.allowed_origins, undefined);
  for (const extensionId of ['*', 'bad/id@local.invalid', 'bad\n@local.invalid', 'a'.repeat(32), 'name@example.com*']) {
    await assert.rejects(createHostBundle({ output: path.join(root, 'invalid'), dataDir: root, extensionId, browser: 'firefox' }));
  }
});
test('Firefox registry override touches only the preferred 32-bit view and restores the prior value', async () => {
  const calls = []; const values = new Map([['/reg:32', 'previous32.json'], ['/reg:64', 'owner64.json']]);
  const registration = createRegistration({ platform: 'win32', exec: async (_file, args) => {
    calls.push(args); const view = args.at(-1); const previous = values.get(view);
    if (args[0] === 'query') return { stdout: previous ? `    (Default)    REG_SZ    ${previous}\r\n` : 'HKEY_CURRENT_USER\\Software\\Mozilla\r\n' };
    if (args[0] === 'add') values.set(view, args[args.indexOf('/d') + 1]);
    if (args[0] === 'delete') values.delete(view);
    return { stdout: '' };
  } });
  const previous = await registration.read('firefox'); assert.deepEqual(previous, { exists: true, value: 'previous32.json' });
  await registration.set('firefox', 'owned.json'); assert.equal((await registration.read('firefox')).value, 'owned.json');
  await registration.set('firefox', previous.value); assert.equal(values.get('/reg:32'), 'previous32.json');
  await registration.remove('firefox'); assert.equal(values.get('/reg:64'), 'owner64.json');
  assert.ok(calls.every(args => args.includes('/reg:32')));
});
test('Firefox export is separate and restores its prior registration without replacing Chromium', async t => {
  const root = await directory(t); const before = '{"name":"previous-firefox"}\n';
  const registration = createRegistration({ platform: 'linux', homeDir: root });
  await registration.set('firefox', before);
  const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: path.join(root, 'state'), userDataDir: root, executablePath: process.execPath, platform: 'linux', registration });
  const chrome = await setup.prepareExtension(); const original = await fs.readFile(path.join(chrome, 'manifest.json'), 'utf8');
  const firefox = await setup.prepareExtension('firefox'); assert.notEqual(firefox, chrome);
  const manifest = JSON.parse(await fs.readFile(path.join(firefox, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 2); assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  assert.deepEqual(manifest.background.scripts, ['capture.js', 'media.js', 'page-links.js', 'background.js']);
  assert.equal(manifest.background.service_worker, undefined); assert.ok(manifest.browser_action.default_popup);
  assert.ok(manifest.permissions.includes('http://*/*')); assert.equal(manifest.host_permissions, undefined);
  assert.equal(await fs.readFile(path.join(chrome, 'manifest.json'), 'utf8'), original);
  await assert.rejects(setup.connect({ extensionId: 'a'.repeat(32), browser: 'firefox' }));
  const result = await setup.connect({ extensionId: GECKO_ID, browser: 'firefox' }); assert.equal(result.connected, true);
  const host = JSON.parse(await fs.readFile(result.manifestPath, 'utf8')); assert.deepEqual(host.allowed_extensions, [GECKO_ID]);
  const reloaded = createBrowserSetup({ appDir: path.resolve('.'), dataDir: path.join(root, 'state'), userDataDir: root, executablePath: process.execPath, platform: 'linux', registration });
  assert.equal((await reloaded.info()).browsers.find(item => item.browser === 'firefox').connected, true);
  await reloaded.disconnect('firefox'); assert.equal((await registration.read('firefox')).value, before);
  assert.equal(await fs.readFile(path.join(chrome, 'manifest.json'), 'utf8'), original);
});
test('Firefox existing external registration changes are never overwritten on disconnect', async t => {
  const root = await directory(t); const values = new Map();
  const registration = { read: async browser => values.get(browser) || { exists: false }, set: async (browser, value) => values.set(browser, { exists: true, value }), remove: async browser => values.delete(browser) };
  const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: root, userDataDir: root, executablePath: process.execPath, platform: 'linux', registration });
  await setup.connect({ extensionId: GECKO_ID, browser: 'firefox' }); values.set('firefox', { exists: true, value: 'changed-by-owner' });
  await assert.rejects(setup.disconnect('firefox'), /thay đổi/); assert.equal(values.get('firefox').value, 'changed-by-owner');
});
