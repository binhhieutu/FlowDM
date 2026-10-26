'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
async function legacy(t, version = 4) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-journal-v5-')); const options = { dataDir: root, downloadDir: path.join(root, 'files') };
  const first = await new DownloadManager(options).init(); await first.add({ url: 'http://127.0.0.1:1/file', startAt: Date.now() + 60000 }); await first.close();
  const filename = path.join(root, 'downloads.json'); const state = JSON.parse(await fs.readFile(filename, 'utf8')); state.version = version;
  const raw = JSON.stringify(state, null, 2) + '\n'; await fs.writeFile(filename, raw); let next;
  t.after(async () => { if (next) await next.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, filename, state, raw, make() { next = new DownloadManager(options); return next; } };
}
test('journal v4 migration preserves an exact private backup before writing v7', async t => {
  const f = await legacy(t); const manager = await f.make().init();
  assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).version, 7);
  const backups = (await fs.readdir(f.root)).filter(name => /^downloads\.v4\..*\.backup\.json$/.test(name)); assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, backups[0]), 'utf8'), f.raw); assert.equal(manager.list()[0].id, f.state.tasks[0].id);
});
test('backup failure blocks migration without changing the original journal', async t => {
  const f = await legacy(t); const original = fs.open;
  fs.open = async (filename, ...args) => { if (String(filename).includes('.backup.json')) throw Object.assign(Error('backup denied'), { code: 'EACCES' }); return original(filename, ...args); };
  try { await assert.rejects(f.make().init(), /backup denied/); assert.equal(await fs.readFile(f.filename, 'utf8'), f.raw); }
  finally { fs.open = original; }
});
test('v5 rejects a segment plan whose tail does not cover the declared total', async t => {
  const f = await legacy(t, 5); Object.assign(f.state.tasks[0], { totalBytes: 100, downloadedBytes: 0, status: 'paused', segments: [{ index: 0, start: 0, end: 98, received: 0 }] });
  await fs.writeFile(f.filename, JSON.stringify(f.state)); await assert.rejects(f.make().init(), /coverage|bounds/i);
});
test('v5 preserves a completed unknown-length single-stream download', async t => {
  const f = await legacy(t, 5); Object.assign(f.state.tasks[0], { totalBytes: 100, downloadedBytes: 100, status: 'completed', segments: [{ index: 0, start: 0, end: null, received: 100 }] });
  await fs.writeFile(f.filename, JSON.stringify(f.state)); const restored = await f.make().init(); assert.equal(restored.list()[0].status, 'completed');
});
