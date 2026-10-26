const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

test('native runner refuses a target that differs from the real execution OS', () => {
  const target = process.platform === 'linux' ? 'darwin' : 'linux';
  const result = spawnSync(process.execPath, [path.resolve('scripts/test-native.cjs'), '--platform', target], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /native host|actual platform/i);
});

test('native runner rejects an unknown platform before launching any desktop', () => {
  const result = spawnSync(process.execPath, [path.resolve('scripts/test-native.cjs'), '--platform', 'pretend-os'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /usage|platform/i);
});

test('native evidence binds the exact executable, ASAR path and application version', async t => {
  const helper = path.resolve('scripts/native-target.cjs');
  assert.equal(require('node:fs').existsSync(helper), true, 'Native artifact binding is required');
  const { nativeTarget, assertNativeArtifact } = require(helper);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-native-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const target = nativeTarget(root, platform, arch);
    await fs.mkdir(path.dirname(target.executable), { recursive: true }); await fs.writeFile(target.executable, 'app');
    await fs.mkdir(path.dirname(target.archive), { recursive: true }); await fs.writeFile(target.archive, 'archive');
    const options = { root, platform, arch, executable: target.executable };
    assert.equal(assertNativeArtifact(options).archive, target.archive);
    assert.throws(() => assertNativeArtifact({ ...options, executable: process.execPath }), /exact|canonical/i);
    assert.throws(() => assertNativeArtifact({ ...options, appPath: path.join(root, 'other.asar') }), /ASAR/i);
    assert.throws(() => assertNativeArtifact({ ...options, version: '0.12.0', expectedVersion: '0.13.0' }), /version/i);
    assert.equal(assertNativeArtifact({ ...options, appPath: target.archive, version: '0.13.0', expectedVersion: '0.13.0' }).target, target.target);
  }
  assert.throws(() => nativeTarget(root, 'darwin', 'ia32'), /architecture/i);
});
