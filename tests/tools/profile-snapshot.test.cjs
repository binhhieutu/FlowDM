const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'state'); await fs.mkdir(path.join(source, 'job.media'), { recursive: true });
  await fs.writeFile(path.join(source, 'downloads.json'), JSON.stringify({ version: 8, tasks: [{ status: 'paused' }], queues: [] }));
  await fs.writeFile(path.join(source, 'job.part'), Buffer.alloc(65536, 71));
  await fs.writeFile(path.join(source, 'job.media', 'đoạn tải dở'), 'private media bytes');
  return { root, source, destination: path.join(root, 'backup'), appVersion: '0.13.0' };
}
function api() { const filename = path.resolve('src/tools/profile-snapshot.cjs'); assert.ok(require('node:fs').existsSync(filename), 'Offline full-profile snapshot support is required'); return require(filename); }

test('snapshot restores all partial/media bytes into a fresh directory and preserves source', async t => {
  const f = await fixture(t); const { createProfileSnapshot, restoreProfileSnapshot, assertProfileReady } = api();
  const saved = await createProfileSnapshot(f); assert.equal(saved.journalVersion, 8); assert.equal(saved.files.length, 3);
  const restored = path.join(f.root, 'restored'); await restoreProfileSnapshot({ snapshot: f.destination, destination: restored, compatibleSchemas: [8] });
  await assertProfileReady(restored);
  for (const name of ['downloads.json', 'job.part', 'job.media/đoạn tải dở']) assert.deepEqual(await fs.readFile(path.join(restored, name)), await fs.readFile(path.join(f.source, name)));
  await assert.rejects(restoreProfileSnapshot({ snapshot: f.destination, destination: f.source, compatibleSchemas: [8] }), /exist|fresh/i);
});

test('snapshot refuses live, active, unsupported and nested profiles before completing', async t => {
  const f = await fixture(t); const { createProfileSnapshot } = api();
  await fs.writeFile(path.join(f.source, 'browser-bridge.json'), '{}');
  await assert.rejects(createProfileSnapshot(f), /close|closed/i); await fs.unlink(path.join(f.source, 'browser-bridge.json'));
  for (const journal of [{ version: 8, tasks: [{ status: 'downloading' }] }, { version: 9, tasks: [] }]) {
    await fs.writeFile(path.join(f.source, 'downloads.json'), JSON.stringify(journal));
    await assert.rejects(createProfileSnapshot(f), /active|paused|version|schema/i);
  }
  await assert.rejects(createProfileSnapshot({ ...f, destination: path.join(f.source, 'backup') }), /nested|outside/i);
});

test('restore refuses corrupted, incomplete, extra files and incompatible journal schema', async t => {
  const f = await fixture(t); const { createProfileSnapshot, restoreProfileSnapshot } = api(); await createProfileSnapshot(f);
  const options = { snapshot: f.destination, destination: path.join(f.root, 'restored'), compatibleSchemas: [4] };
  await assert.rejects(restoreProfileSnapshot(options), /schema|compatible/i);
  options.compatibleSchemas = [8]; await fs.writeFile(path.join(f.destination, 'data', 'extra'), 'unexpected');
  await assert.rejects(restoreProfileSnapshot(options), /files|manifest|extra/i); await fs.unlink(path.join(f.destination, 'data', 'extra'));
  await fs.writeFile(path.join(f.destination, 'data', 'job.part'), 'corrupt');
  await assert.rejects(restoreProfileSnapshot(options), /hash|integrity|size/i);
  await fs.unlink(path.join(f.destination, 'complete.json'));
  await assert.rejects(restoreProfileSnapshot(options), /ENOENT|complete/i);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
});

test('interrupted backup is unusable; interrupted restore blocks current app admission', async t => {
  const f = await fixture(t); const { createProfileSnapshot, restoreProfileSnapshot, assertProfileReady } = api();
  const interrupted = new AbortController();
  await assert.rejects(createProfileSnapshot({ ...f, signal: interrupted.signal, onProgress: () => interrupted.abort() }), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.join(f.destination, 'complete.json')), { code: 'ENOENT' });
  const backup = path.join(f.root, 'valid'); await createProfileSnapshot({ ...f, destination: backup });
  const controller = new AbortController(); const destination = path.join(f.root, 'restore-incomplete');
  await assert.rejects(restoreProfileSnapshot({ snapshot: backup, destination, compatibleSchemas: [8], signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  await assert.rejects(assertProfileReady(destination), /restore|Khôi phục/i);
  assert.ok((await fs.stat(path.join(f.source, 'job.part'))).size > 0);
});

test('source mutation during backup prevents its completion marker', async t => {
  const f = await fixture(t); const { createProfileSnapshot } = api(); let changed = false;
  await assert.rejects(createProfileSnapshot({ ...f, onProgress: async () => { if (!changed) { changed = true; await fs.writeFile(path.join(f.source, 'job.part'), 'changed'); } } }), /hash|integrity|changed|size/i);
  await assert.rejects(fs.stat(path.join(f.destination, 'complete.json')), { code: 'ENOENT' });
});

test('native POSIX snapshot rejects symbolic links instead of following external state', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const { createProfileSnapshot } = api(); await fs.symlink('/etc/passwd', path.join(f.source, 'link'));
  await assert.rejects(createProfileSnapshot(f), /link|regular/i);
});

test('restore refuses path aliases and traversal even when the manifest checksum is valid', async t => {
  const f = await fixture(t); const { createProfileSnapshot, restoreProfileSnapshot } = api(); await createProfileSnapshot(f);
  const manifest = JSON.parse(await fs.readFile(path.join(f.destination, 'manifest.json'), 'utf8'));
  for (const filename of ['../escape', '.. /escape', 'dir./escape', 'CON.txt', 'C:/escape']) {
    const changed = { ...manifest, files: [{ ...manifest.files[0], path: filename }] }; const bytes = Buffer.from(JSON.stringify(changed));
    await fs.writeFile(path.join(f.destination, 'manifest.json'), bytes);
    await fs.writeFile(path.join(f.destination, 'complete.json'), JSON.stringify({ manifestSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }));
    await assert.rejects(restoreProfileSnapshot({ snapshot: f.destination, destination: path.join(f.root, 'restored'), compatibleSchemas: [8] }), /manifest|files/i);
  }
});

test('native POSIX restore refuses a symlink replacing its data root', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const { createProfileSnapshot, restoreProfileSnapshot } = api(); await createProfileSnapshot(f);
  await fs.rename(path.join(f.destination, 'data'), path.join(f.destination, 'original-data'));
  await fs.symlink(path.join(f.destination, 'original-data'), path.join(f.destination, 'data'));
  await assert.rejects(restoreProfileSnapshot({ snapshot: f.destination, destination: path.join(f.root, 'restored'), compatibleSchemas: [8] }), /link|directory/i);
});
