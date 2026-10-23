const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createBrowserSetup, prepareHostRuntime } = require('../../src/browser/setup.cjs');
const { registrationTarget, createRegistration } = require('../../src/browser/registration.cjs');
test('setup exports a stable extension, validates inputs and restores prior registration', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-setup-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const values = new Map([['chrome', { exists: true, value: 'previous.json' }]]);
  const registration = { read: async browser => values.get(browser) || { exists: false }, set: async (browser, value) => values.set(browser, { exists: true, value }), remove: async browser => values.delete(browser) };
  const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: path.join(root, 'state'), userDataDir: root, executablePath: process.execPath, platform: 'linux', registration });
  const exported = await setup.prepareExtension();
  assert.ok((await fs.stat(path.join(exported, 'manifest.json'))).isFile());
  assert.equal((await setup.info()).connected, false);
  await assert.rejects(setup.connect({ extensionId: '*', browser: 'chrome' }));
  await assert.rejects(setup.connect({ extensionId: 'a'.repeat(32), browser: 'unexpected' }));
  const result = await setup.connect({ extensionId: 'a'.repeat(32), browser: 'chrome' });
  assert.equal(result.connected, true); assert.match(values.get('chrome').value, /local.flowdm.bridge/);
  await setup.connect({ extensionId: 'b'.repeat(32), browser: 'chrome' });
  await setup.disconnect('chrome'); assert.deepEqual(values.get('chrome'), { exists: true, value: 'previous.json' });
  await setup.connect({ extensionId: 'a'.repeat(32), browser: 'edge' });
  values.set('edge', { exists: true, value: 'changed-by-owner' });
  await assert.rejects(setup.disconnect('edge'), /changed|thay đổi/i);
  assert.equal(values.get('edge').value, 'changed-by-owner');
});
test('registration targets are scoped to named per-user native hosts', async () => {
  assert.match(registrationTarget('chrome', 'win32', '/home/test'), /^HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\local\.flowdm\.bridge$/);
  assert.match(registrationTarget('edge', 'linux', '/home/test'), /microsoft-edge.*NativeMessagingHosts/);
  assert.match(registrationTarget('chrome', 'darwin', '/home/test'), /Library.*Google.*Chrome.*NativeMessagingHosts/);
  assert.throws(() => registrationTarget('invalid', 'win32', '/home/test'));
  const calls = [];
  const registration = createRegistration({ platform: 'win32', exec: async (_file, args) => { calls.push(args); if (args[0] === 'query') return { stdout: '    (Default)    REG_SZ    C:\\A B\\host.json\r\n' }; return { stdout: '' }; } });
  assert.deepEqual(await registration.read('chrome'), { exists: true, value: 'C:\\A B\\host.json' });
  await registration.set('chrome', 'C:\\A B\\new.json'); await registration.remove('chrome');
  assert.ok(calls.every(args => args.includes('/reg:64')));
  const empty = createRegistration({ platform: 'win32', exec: async (_file, args) => ({ stdout: args.includes('/ve') ? '    (Default)    REG_SZ    (value not set)\r\n' : 'HKEY_CURRENT_USER\\Software\\test\r\n' }) });
  assert.deepEqual(await empty.read('chrome'), { exists: false });
});
test('POSIX registration restores byte-exact contents and removes only its own file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-registration-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registration = createRegistration({ platform: 'linux', homeDir: root });
  assert.deepEqual(await registration.read('chromium'), { exists: false });
  await registration.set('chromium', '{"name":"local.flowdm.bridge"}\n');
  assert.equal((await registration.read('chromium')).value, '{"name":"local.flowdm.bridge"}\n');
  await registration.remove('chromium'); assert.deepEqual(await registration.read('chromium'), { exists: false });
});
test('host runtime is verified and Windows copy survives portable extraction cleanup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-runtime-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = await prepareHostRuntime({ executablePath: process.platform === 'win32' ? require('electron') : process.execPath, directory: root, platform: process.platform });
  if (process.platform === 'win32') { assert.equal(runtime.electron, true); assert.ok(runtime.nodePath.startsWith(root)); assert.ok((await fs.stat(path.join(path.dirname(runtime.nodePath), 'icudtl.dat'))).size > 0); }
  else assert.equal(runtime.nodePath, process.execPath);
});
test('write-ahead setup intent preserves previous ownership when registration mutates then throws', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-setup-crash-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let value = 'previous.json'; let fail = true;
  const registration = { read: async () => ({ exists: true, value }), set: async (_browser, next) => { value = next; if (fail) { fail = false; throw Error('simulated death after mutation'); } }, remove: async () => { value = null; } };
  const options = { appDir: path.resolve('.'), dataDir: path.join(root, 'state'), userDataDir: root, executablePath: process.execPath, platform: 'linux', registration };
  await assert.rejects(createBrowserSetup(options).connect({ browser: 'chrome', extensionId: 'a'.repeat(32) }), /simulated/);
  const restored = createBrowserSetup(options);
  assert.equal((await restored.info()).connected, true);
  await restored.disconnect('chrome'); assert.equal(value, 'previous.json');
});
test('recovers pending before/after/disconnect states and preserves unrelated external changes', async t => {
  for (const mode of ['before', 'after', 'disconnect', 'external']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-intent-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previous = { exists: true, value: 'previous' }; const owned = { exists: true, value: 'owned' };
    const item = { extensionId: 'a'.repeat(32), previous, current: 'owned' };
    const state = mode === 'disconnect' ? { browsers: { chrome: item }, pending: { browser: 'chrome', before: owned, after: previous, nextBrowsers: {} } } : { browsers: {}, pending: { browser: 'chrome', before: previous, after: owned, nextBrowsers: { chrome: item } } };
    await fs.writeFile(path.join(root, 'browser-setup.json'), JSON.stringify(state));
    const value = mode === 'external' ? { exists: true, value: 'external' } : mode === 'after' ? owned : previous;
    const registration = { read: async () => value, set: async () => { throw Error('must not write registry during metadata reconciliation'); }, remove: async () => { throw Error('must not remove registry'); } };
    const setup = createBrowserSetup({ appDir: path.resolve('.'), dataDir: root, userDataDir: root, executablePath: process.execPath, platform: 'linux', registration });
    if (mode === 'external') { await assert.rejects(setup.info(), /thay đổi/); assert.ok(JSON.parse(await fs.readFile(path.join(root, 'browser-setup.json'))).pending); }
    else { assert.equal((await setup.info()).connected, mode === 'after'); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'browser-setup.json'))).pending, undefined); }
  }
});
