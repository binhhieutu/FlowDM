'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadManager } = require('../../src/core/download-manager.cjs');

async function setup(t, externalDownloader) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-external-manager-'));
  const manager = await new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files'), externalDownloader }).init();
  t.after(async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager };
}
async function wait(manager, id) {
  for (let index = 0; index < 200; index++) { const task = manager.list().find(item => item.id === id); if (['completed', 'failed'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error(JSON.stringify(manager.list()));
}

test('DASH uses one restart-only external task, journal v3, hashing and atomic publication', async t => {
  const { manager, root } = await setup(t, async ({ output, onProgress }) => {
    onProgress({ downloadedBytes: 3, totalBytes: null });
    await fs.writeFile(output, 'dash-mux'); onProgress({ downloadedBytes: 8, totalBytes: 8 });
    return { bytes: 8, finalUrl: 'https://cdn.example/video.mpd' };
  });
  const task = await manager.add({ url: 'https://cdn.example/video.mpd' });
  const done = await wait(manager, task.id);
  assert.equal(done.status, 'completed', done.error); assert.equal(done.mediaType, 'dash'); assert.equal(done.filename, 'video.mp4');
  assert.deepEqual(done.segments, [{ index: 0, start: 0, end: null, received: 8 }]); assert.equal(await fs.readFile(done.path, 'utf8'), 'dash-mux');
  const journal = JSON.parse(await fs.readFile(path.join(root, 'data', 'downloads.json'), 'utf8'));
  assert.equal(journal.version, 3); assert.equal(journal.tasks[0].media.resumePolicy, 'restart');
});

test('external failures never publish and sensitive external headers are rejected before queueing', async t => {
  const { manager } = await setup(t, async () => { throw Object.assign(Error('token=https://secret.invalid'), { code: 'EXTERNAL_MEDIA_TOOL' }); });
  await assert.rejects(manager.add({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', headers: { 'User-Agent': 'browser' } }), /browser headers/);
  const task = await manager.add({ url: 'https://www.youtube.com/watch?v=AbCdEf12345' }); const done = await wait(manager, task.id);
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'Download failed (EXTERNAL_MEDIA_TOOL)'); await assert.rejects(fs.stat(done.path), { code: 'ENOENT' });
});
