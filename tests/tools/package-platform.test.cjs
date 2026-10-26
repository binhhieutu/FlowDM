const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

async function fixture(t, target) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-package-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'src/main.cjs': 'module.exports = 1;', 'assets/icon.txt': 'fixture', 'extension/manifest.json': '{"version":"1.0.0"}',
    'package.json': JSON.stringify({ name: 'flowdm', version: '1.0.0', main: 'src/main.cjs', dependencies: { 'basic-ftp': '6.2.3' } }),
    'node_modules/basic-ftp/package.json': '{"version":"6.2.3","license":"MIT"}',
    'node_modules/basic-ftp/dist/index.js': 'exports.fixture=true;', 'node_modules/basic-ftp/LICENSE.txt': 'MIT fixture'
  };
  for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); }
  const locations = { linux: 'linux-unpacked/resources', 'mac-x64': 'mac/FlowDM.app/Contents/Resources', 'mac-arm64': 'mac-arm64/FlowDM.app/Contents/Resources' };
  const archive = path.join(root, 'dist', locations[target], 'app.asar');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const payload = path.join(root, 'payload'); await fs.mkdir(payload);
  for (const file of Object.keys(files)) { await fs.mkdir(path.dirname(path.join(payload, file)), { recursive: true }); await fs.copyFile(path.join(root, file), path.join(payload, file)); }
  await asar.createPackage(payload, archive);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(path.resolve('scripts/verify-package.cjs'), path.join(root, 'scripts/verify-package.cjs'));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/verify-package.cjs'), ...args], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.resolve('node_modules') }, timeout: 15000 });
  return { root, archive, run };
}

for (const platform of ['linux', 'mac-x64', 'mac-arm64']) test(`verifies a standalone ${platform} archive without requiring other platforms`, async t => {
  const { archive, run } = await fixture(t, platform);
  const result = run('--platform', platform);
  assert.equal(result.status, 0, result.stderr);
  const [manifest] = JSON.parse(result.stdout);
  assert.equal(manifest.filesVerified, 3); assert.equal(manifest.ftpDependency.filesVerified, 2);
  assert.equal(manifest.asarSha256, crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
});

test('platform verifier refuses stale runtime bytes and missing selected archive', async t => {
  const { root, archive, run } = await fixture(t, 'linux');
  await fs.writeFile(path.join(root, 'src/main.cjs'), 'changed');
  const stale = run('--platform', 'linux'); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /stale|corrupted/);
  await fs.unlink(archive);
  const missing = run('--platform', 'linux'); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ENOENT|archive/i);
});

test('platform verifier rejects unknown, repeated and missing platform arguments', async t => {
  const { run } = await fixture(t, 'linux');
  for (const args of [['--platform', 'windows-ish'], ['--platform'], ['--unexpected'], ['--platform', 'linux', '--platform', 'linux']]) {
    const result = run(...args); assert.notEqual(result.status, 0); assert.match(result.stderr, /platform|argument|usage/i);
  }
});
