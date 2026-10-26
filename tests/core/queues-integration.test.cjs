'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 1200; i++) { const v = await fn(); if (v) return v; await sleep(10); } throw Error('Queue integration timeout'); }
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-queues-core-'));
  const body = Buffer.alloc(64 * 1024, 91), starts = []; let active = 0, peak = 0;
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || ''); const start = range ? +range[1] : 0, end = range ? +range[2] : body.length - 1;
    res.writeHead(range ? 206 : 200, { ETag: '"queue-fixture"', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    if (end === 0) return res.end(body.subarray(0, 1));
    active++; peak = Math.max(peak, active); starts.push(req.url); let offset = start;
    const timer = setInterval(() => { const next = Math.min(end + 1, offset + 1024); res.write(body.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); res.end(); } }, 4);
    res.once('close', () => { active--; clearInterval(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { dataDir: path.join(root, 'state'), downloadDir: path.join(root, 'files'), ...overrides }; let manager = await new DownloadManager(options).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-queues-core-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, options, body, starts, url: `http://127.0.0.1:${server.address().port}`, get manager() { return manager; }, get peak() { return peak; }, async relaunch() { await manager.close(); manager = await new DownloadManager(options).init(); } };
}
test('queues preserve move/order/caps across app restart and finish exact data', async t => {
  const f = await fixture(t, { maxConcurrent: 2, maxPerHost: 2 });
  assert.equal(typeof f.manager.createQueue, 'function');
  const q = await f.manager.createQueue({ name: 'Video', enabled: false, concurrency: 1 });
  const second = await f.manager.createQueue({ name: 'Other', enabled: false, concurrency: 1 });
  const a = await f.manager.add({ url: f.url + '/a', queueId: q.id, connections: 1 });
  const b = await f.manager.add({ url: f.url + '/b', queueId: q.id, connections: 1 });
  const c = await f.manager.add({ url: f.url + '/c', connections: 1, startAt: Date.now() + 60000 });
  await f.manager.pause(c.id); await f.manager.moveTask(c.id, second.id); await f.manager.reorderQueue(q.id, [b.id, a.id]);
  await f.relaunch(); assert.deepEqual(f.manager.listQueues().find(v => v.id === q.id).taskIds, [b.id, a.id]);
  assert.equal(f.manager.list().find(v => v.id === c.id).queueId, second.id);
  await f.manager.resumeQueue(q.id); await f.manager.resumeQueue(second.id); await f.manager.resume(c.id);
  await until(() => f.manager.list().every(v => v.status === 'completed'));
  assert.ok(f.starts.indexOf('/b') < f.starts.indexOf('/a')); assert.ok(f.peak <= 2);
  for (const task of f.manager.list()) { assert.equal(task.sha256, crypto.createHash('sha256').update(f.body).digest('hex')); assert.deepEqual(await fs.readFile(task.path), f.body); }
  await assert.rejects(f.manager.deleteQueue('default')); await assert.rejects(f.manager.deleteQueue(q.id));
});
test('schema6 migrates to a default queue with exact backup before schema7 write', async t => {
  const f = await fixture(t); const task = await f.manager.add({ url: f.url + '/legacy', startAt: Date.now() + 60000 }); await f.manager.close();
  const filename = path.join(f.options.dataDir, 'downloads.json'); const legacy = JSON.parse(await fs.readFile(filename, 'utf8')); legacy.version = 6; delete legacy.queues;
  for (const item of legacy.tasks) { delete item.queueId; delete item.queueHold; }
  const raw = JSON.stringify(legacy, null, 2) + '\n'; await fs.writeFile(filename, raw); await f.relaunch();
  const saved = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(saved.version, 7);
  assert.deepEqual(saved.queues[0].taskIds, [task.id]); assert.equal(saved.tasks[0].queueId, 'default');
  const names = (await fs.readdir(f.options.dataDir)).filter(n => /^downloads\.v6\..*\.backup\.json$/.test(n)); assert.equal(names.length, 1);
  assert.equal(await fs.readFile(path.join(f.options.dataDir, names[0]), 'utf8'), raw);
});
test('scheduled holds survive stop and clock rollback; manual pause stays manual next window', async t => {
  let clock = Date.parse('2026-10-26T01:00:10Z'); const f = await fixture(t, { clock: () => clock });
  assert.equal(typeof f.manager.createQueue, 'function');
  const q = await f.manager.createQueue({ name: 'Weekdays', concurrency: 1, schedule: { timezone: 'UTC', weekdays: [1, 2], start: '01:00', stop: '01:01' } });
  const a = await f.manager.add({ url: f.url + '/scheduled', queueId: q.id, connections: 1, startAt: Date.parse('2026-10-26T01:00:15Z') });
  await sleep(50); assert.equal(f.manager.list()[0].status, 'queued');
  clock = Date.parse('2026-10-26T01:00:16Z'); f.manager._pump(); await until(() => f.manager.list()[0].downloadedBytes > 0);
  clock = Date.parse('2026-10-26T01:01:00Z'); f.manager._pump(); await until(() => f.manager.list()[0].status === 'paused' && f.manager.running.size === 0);
  assert.equal(f.manager.list()[0].queueHold, true); const before = f.manager.list()[0].downloadedBytes;
  clock = Date.parse('2026-10-26T01:00:30Z'); f.manager._pump(); await sleep(60); assert.equal(f.manager.list()[0].downloadedBytes, before);
  await f.manager.pause(a.id); assert.equal(f.manager.list()[0].queueHold, false);
  clock = Date.parse('2026-10-27T01:00:30Z'); f.manager._pump(); await sleep(60); assert.equal(f.manager.list()[0].status, 'paused');
});
test('queue bandwidth reservations cap aggregate sustained transfer and preserve task rate settings', async t => {
  const f = await fixture(t, { maxConcurrent: 2, maxPerHost: 2 }); assert.equal(typeof f.manager.createQueue, 'function');
  const q = await f.manager.createQueue({ name: 'Limited', enabled: false, concurrency: 2, speedLimit: 65536 });
  for (const name of ['one', 'two']) await f.manager.add({ url: f.url + '/' + name, queueId: q.id, connections: 1 });
  const began = Date.now(); await f.manager.resumeQueue(q.id);
  await until(() => f.manager.list().every(v => v.status === 'completed'));
  assert.ok(Date.now() - began >= 1850, 'Queue cap bypassed'); assert.ok(f.peak <= 2);
  assert.ok(f.manager.list().every(v => v.speedLimit === 0));
});
test('public mutations cancel power immediately while final validation is blocked', async t => {
  const actions = {
    add: m => m.add({ url: 'http://127.0.0.1:9/new', startAt: Date.now() + 60000 }),
    resume: m => m.resume('missing'),
    createQueue: m => m.createQueue({ name: 'Later' }),
    updateQueue: m => m.updateQueue('default', { name: 'Renamed' }),
    deleteQueue: m => m.deleteQueue('default'),
    reorderQueue: m => m.reorderQueue('default', []),
    moveTask: m => m.moveTask('missing', 'default'),
    pauseQueue: m => m.pauseQueue('default'),
    resumeQueue: m => m.resumeQueue('default'),
    remove: m => m.remove('missing')
  };
  for (const [name, mutate] of Object.entries(actions)) await t.test(name, async sub => {
    let monotonic = 0; const calls = [];
    const f = await fixture(sub, { monotonicClock: () => monotonic, powerAdapter: { perform: async action => calls.push(action) } });
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    f.manager.powerController.beforeDispatch = () => f.manager._mutate(async () => { enter(); await blocked; return true; });
    f.manager.powerController.arm({ intentId: 'race-' + name, queueId: 'default', action: 'shutdown' });
    monotonic = 60001; const tick = f.manager.powerController.tick(); await entered;
    const mutation = mutate(f.manager).catch(() => {});
    release(); await tick; await mutation;
    assert.deepEqual(calls, [], name + ' must fence OS dispatch at public API entry');
    assert.equal(f.manager.powerInfo().status, 'cancelled');
  });
});
test('scheduled running downloads keep automatic provenance across close or interrupted journal restore', async t => {
  for (const mode of ['close-inside', 'close-outside', 'interrupted']) await t.test(mode, async sub => {
    let clock = Date.parse('2026-10-26T01:00:10Z');
    const f = await fixture(sub, { clock: () => clock });
    const q = await f.manager.createQueue({ name: 'Recurring', schedule: { timezone: 'UTC', weekdays: [1, 2], start: '01:00', stop: '02:00' } });
    const task = await f.manager.add({ url: f.url + '/restart', queueId: q.id, connections: 1 });
    await until(() => f.manager.list()[0].downloadedBytes > 0);
    await f.manager.close();
    if (mode === 'interrupted') {
      const journal = path.join(f.options.dataDir, 'downloads.json');
      const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
      saved.tasks[0].status = 'downloading'; saved.tasks[0].queueHold = false;
      await fs.writeFile(journal, JSON.stringify(saved));
    }
    if (mode === 'close-outside') clock = Date.parse('2026-10-26T02:01:00Z');
    await f.relaunch();
    if (mode === 'close-outside') {
      await sleep(80); const restored = f.manager.list()[0];
      assert.equal(restored.status, 'paused'); assert.equal(restored.queueHold, true);
      clock = Date.parse('2026-10-27T01:00:10Z'); f.manager._pump();
    }
    await until(() => f.manager.list()[0].status === 'completed');
    assert.equal(f.manager.list()[0].id, task.id); assert.deepEqual(await fs.readFile(task.path), f.body);
  });
});
