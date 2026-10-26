const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createRegistration, registrationTarget } = require('../../src/browser/registration.cjs');
const { createHostBundle } = require('../../src/bridge/install.cjs');
const { encodeFrame, FrameDecoder } = require('../../src/bridge/protocol.cjs');

for (const platform of ['linux', 'darwin']) test(`${platform} registration preserves exact previous manifest in a private Unicode home`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-platform-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "Người dùng ' thử nghiệm");
  const registration = createRegistration({ platform, homeDir });
  for (const browser of ['chrome', 'edge', 'chromium', 'testing', 'firefox']) {
    const target = registrationTarget(browser, platform, homeDir);
    assert.ok(target.startsWith(homeDir + path.sep));
    const previous = '{ "name": "previous", "unicode": "Tiếng Việt" }\n';
    await registration.set(browser, previous);
    const snapshot = await registration.read(browser);
    await registration.set(browser, '{"name":"replacement"}\n');
    await registration.set(browser, snapshot.value);
    assert.equal(await fs.readFile(target, 'utf8'), previous);
    if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    await registration.remove(browser);
    assert.deepEqual(await registration.read(browser), { exists: false });
  }
});

test('native POSIX host wrapper executes through Unicode, spaces and apostrophes with private modes', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flowdm-native-' kiểm thử-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = await createHostBundle({ output: path.join(root, "host ' riêng"), dataDir: path.join(root, "dữ liệu ' riêng"), nodePath: process.execPath, extensionId: 'a'.repeat(32) });
  assert.equal((await fs.stat(bundle.wrapperPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(bundle.manifestPath)).mode & 0o777, 0o600);
  const result = spawnSync(bundle.wrapperPath, [], { input: encodeFrame({ request_id: 'native_platform', op: 'unsupported' }), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  const replies = []; const decoder = new FrameDecoder(value => replies.push(value)); decoder.push(result.stdout); decoder.end();
  assert.deepEqual(replies, [{ request_id: 'native_platform', ok: false, error: 'INVALID_REQUEST' }]);
});
