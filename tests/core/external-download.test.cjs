'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const waitForAbort = signal => new Promise(resolve => {
  if (signal.aborted) return resolve();
  signal.addEventListener('abort', resolve, { once: true });
  if (signal.aborted) resolve();
});

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

test('DASH uses a checkpoint task, journal v5, hashing and atomic publication', async t => {
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
  assert.equal(journal.version, 6); assert.equal(journal.tasks[0].media.resumePolicy, 'checkpoint');
});

test('external pause/reopen preserves progress and uses the same owned checkpoint, then cleans it on success', async t => {
  let calls = 0; const directories = [];
  const externalDownloader = async ({ checkpointDir, output, signal, onProgress }) => {
    assert.ok(path.isAbsolute(checkpointDir)); directories.push(checkpointDir); calls++;
    if (calls === 1) {
      await fs.writeFile(path.join(checkpointDir, 'fragment'), 'saved-fragment');
      await fs.writeFile(path.join(checkpointDir, 'checkpoint.json'), '{}');
      onProgress({ downloadedBytes: 5, totalBytes: null, completedSegments: 1 });
      await waitForAbort(signal);
      throw Object.assign(Error('Aborted'), { name: 'AbortError' });
    }
    assert.equal(await fs.readFile(path.join(checkpointDir, 'fragment'), 'utf8'), 'saved-fragment');
    await fs.writeFile(output, 'resumed-video'); return { bytes: 13, finalUrl: null, metadata: { reusedResources: 1 } };
  };
  const { manager, root } = await setup(t, externalDownloader);
  const task = await manager.add({ url: 'https://cdn.example/movie.mpd' });
  for (let i = 0; i < 100 && manager.list()[0].downloadedBytes < 5; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id); assert.equal(manager.list()[0].downloadedBytes, 5); await manager.close();
  const restored = await new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files'), externalDownloader }).init();
  try {
    assert.equal(restored.list()[0].downloadedBytes, 5);
    await restored.resume(task.id); const done = await wait(restored, task.id);
    assert.equal(done.status, 'completed', done.error); assert.equal(directories[0], directories[1]);
    assert.equal(await fs.readFile(done.path, 'utf8'), 'resumed-video');
    await assert.rejects(fs.stat(directories[0]), { code: 'ENOENT' });
  } finally { await restored.close(); }
});

test('cancel removes only the task media checkpoint', async t => {
  const { manager, root } = await setup(t, async ({ checkpointDir, signal }) => {
    await fs.writeFile(path.join(checkpointDir, 'fragment'), 'partial');
    await waitForAbort(signal);
    throw Object.assign(Error('Aborted'), { name: 'AbortError' });
  });
  const unrelated = path.join(root, 'data', 'owner.txt'); await fs.writeFile(unrelated, 'keep');
  const task = await manager.add({ url: 'https://cdn.example/movie.mpd' }); const checkpoint = path.join(root, 'data', `${task.id}.media`);
  for (let i = 0; i < 100; i++) { try { await fs.stat(path.join(checkpoint, 'fragment')); break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
  await manager.cancel(task.id); await assert.rejects(fs.stat(checkpoint), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
});

test('an emptied checkpoint cannot silently restart a paused media task', async t => {
  let calls = 0;
  const externalDownloader = async ({ checkpointDir, signal, onProgress }) => {
    calls++; await fs.writeFile(path.join(checkpointDir, 'checkpoint.json'), '{}');
    onProgress({ downloadedBytes: 5, totalBytes: null });
    await waitForAbort(signal);
    throw Object.assign(Error('Aborted'), { name: 'AbortError' });
  };
  const { manager, root } = await setup(t, externalDownloader);
  const task = await manager.add({ url: 'https://cdn.example/movie.mpd' });
  for (let i = 0; i < 100 && !manager.list()[0].downloadedBytes; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.pause(task.id);
  const checkpoint = path.join(root, 'data', `${task.id}.media`); await fs.unlink(path.join(checkpoint, 'checkpoint.json'));
  await manager.resume(task.id);
  const done = await wait(manager, task.id);
  assert.equal(done.status, 'failed'); assert.match(done.error, /checkpoint.*missing/i); assert.equal(calls, 1);
});

test('external failures never publish and sensitive external headers are rejected before queueing', async t => {
  const { manager } = await setup(t, async () => { throw Object.assign(Error('token=https://secret.invalid'), { code: 'EXTERNAL_MEDIA_TOOL' }); });
  await assert.rejects(manager.add({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', headers: { 'User-Agent': 'browser' } }), /browser headers/);
  const task = await manager.add({ url: 'https://www.youtube.com/watch?v=AbCdEf12345' }); const done = await wait(manager, task.id);
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'Download failed (EXTERNAL_MEDIA_TOOL)'); await assert.rejects(fs.stat(done.path), { code: 'ENOENT' });
});
