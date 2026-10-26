const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { zipSync, unzipSync } = require('fflate');
function api() { const file = path.resolve('scripts/release-package.cjs'); assert.ok(require('node:fs').existsSync(file), 'Release bundle allowlist/verifier is required'); return require(file); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = { 'README.md': 'source', LICENSE: 'MIT', 'package.json': '{"name":"flowdm","version":"1.0.0"}', 'package-lock.json': '{}', 'src/main.cjs': 'module.exports=1;', 'assets/icon.png': 'image fixture', 'extension/manifest.json': '{"version":"1.0.0"}', 'extension/background.js': 'export{};', 'docs/evidence/private.json': 'excluded evidence', 'tests/fixtures/video/direct.mp4': 'excluded media', 'vendor/media-tools/ffmpeg.exe': 'excluded binary' };
  for (const [name, value] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), value); }
  cp.execFileSync('git', ['init', '-q'], { cwd: root }); cp.execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: root });
  await fs.writeFile(path.join(root, 'src/local-secret.json'), 'untracked private file');
  return { root, outDir: path.join(root, 'dist') };
}
test('source and extension ZIPs contain only tracked allowlisted source and match every byte', async t => {
  const f = await fixture(t); const { createReleaseBundles, verifyReleaseBundles } = api();
  const results = await createReleaseBundles(f); assert.equal(results.length, 2);
  await verifyReleaseBundles(f);
  const source = unzipSync(await fs.readFile(path.join(f.outDir, 'FlowDM-1.0.0-source.zip')));
  assert.ok(source['src/main.cjs']); assert.ok(source['package-lock.json']);
  assert.ok(!Object.keys(source).some(name => /private|local-secret|vendor|\.mp4|\.exe|evidence/.test(name)));
  const extension = unzipSync(await fs.readFile(path.join(f.outDir, 'FlowDM-1.0.0-extension.zip')));
  assert.deepEqual(Object.keys(extension).sort(), ['background.js', 'manifest.json']);
  await assert.rejects(createReleaseBundles(f), /EEXIST|exist/i);
});
test('bundle verification refuses altered bytes, extra entries and traversal before extraction', async t => {
  const f = await fixture(t); const { createReleaseBundles, verifyReleaseBundles } = api(); await createReleaseBundles(f);
  const filename = path.join(f.outDir, 'FlowDM-1.0.0-extension.zip'); const original = unzipSync(await fs.readFile(filename));
  for (const changed of [{ ...original, 'background.js': Buffer.from('altered') }, { ...original, 'private.txt': Buffer.from('unexpected') }, { ...original, '../escape': Buffer.from('unsafe') }]) {
    await fs.writeFile(filename, zipSync(changed)); await assert.rejects(verifyReleaseBundles(f), /allowlist|content|bytes|entry|bundle/i);
  }
});
test('bundle creation refuses extension version drift and missing required source', async t => {
  const f = await fixture(t); const { createReleaseBundles } = api();
  await fs.writeFile(path.join(f.root, 'extension/manifest.json'), '{"version":"2.0.0"}');
  await assert.rejects(createReleaseBundles(f), /version/i);
  await fs.writeFile(path.join(f.root, 'extension/manifest.json'), '{"version":"1.0.0"}'); await fs.unlink(path.join(f.root, 'LICENSE'));
  await assert.rejects(createReleaseBundles(f), /ENOENT|required|source/i);
});
