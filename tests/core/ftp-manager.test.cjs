'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const { createFtpFixture } = require('../helpers/ftp-fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(manager, id, predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const task = manager.list().find(value => value.id === id);
    if (predicate(task)) return task;
    await sleep(10);
  }
  throw Error('FTP manager state timeout');
}
async function fixture(t, options = {}) {
  let manager; t.after(async () => manager?.close());
  const ftp = await createFtpFixture(t, options);
  const settings = { dataDir: path.join(ftp.root, 'state'), downloadDir: path.join(ftp.root, 'files') };
  manager = await new DownloadManager(settings).init();
  return { ...ftp, settings, get manager() { return manager; }, async reopen() { await manager.close(); manager = await new DownloadManager(settings).init(); } };
}
async function complete(f, id) {
  const task = await waitFor(f.manager, id, task => ['completed', 'failed'].includes(task.status));
  assert.equal(task.status, 'completed', task.error);
  assert.deepEqual(await fs.readFile(task.path), f.state.body);
  assert.equal(task.sha256, crypto.createHash('sha256').update(f.state.body).digest('hex'));
  return task;
}
test('manager downloads anonymous FTP with SHA and preserves canonical URL in schema8', async t => {
  const f = await fixture(t); const task = await f.manager.add({ url: f.url }); const done = await complete(f, task.id);
  assert.equal(done.mediaType, 'ftp'); assert.equal(new URL(done.url).username, '');
  assert.equal(done.activeConnections, 0); await f.manager.close();
  const journal = JSON.parse(await fs.readFile(path.join(f.settings.dataDir, 'downloads.json'), 'utf8'));
  assert.equal(journal.version, 8); assert.equal(journal.tasks[0].ftpIdentity.size, f.state.body.length);
  await f.reopen(); const restored = f.manager.list()[0]; assert.equal(restored.id, task.id); assert.equal(restored.status, 'completed');
});
test('manager pauses, closes and resumes FTP from the same committed REST byte after relaunch', async t => {
  const f = await fixture(t, { body: Buffer.alloc(512 * 1024, 53), delay: 10 });
  const task = await f.manager.add({ url: f.url });
  await waitFor(f.manager, task.id, task => task.downloadedBytes >= 32768);
  await f.manager.pause(task.id); const paused = f.manager.list()[0]; assert.equal(paused.status, 'paused');
  const prefix = await fs.readFile(path.join(f.settings.dataDir, task.id + '.part')); assert.equal(prefix.length, paused.downloadedBytes);
  await f.reopen(); const restored = f.manager.list()[0]; assert.equal(restored.id, task.id); assert.equal(restored.downloadedBytes, paused.downloadedBytes); assert.equal(restored.status, 'paused');
  const transferIndex = f.transfers.length;
  await f.manager.resume(task.id); await complete(f, task.id);
  assert.equal(f.transfers[transferIndex].start, paused.downloadedBytes);
  assert.equal(f.transfers[transferIndex].bytes, f.state.body.length - paused.downloadedBytes);
});
test('manager requires RAM-only FTP credentials to be rebound after app restart', async t => {
  const credentials = { user: 'fixture-account', password: 'fixture-password' };
  const f = await fixture(t, { ...credentials, delay: 10, body: Buffer.alloc(512 * 1024, 21) });
  const task = await f.manager.add({ url: f.url, ftpCredentials: credentials });
  await waitFor(f.manager, task.id, task => task.downloadedBytes >= 16384);
  await f.manager.pause(task.id); const paused = f.manager.list()[0]; await f.reopen();
  const journal = await fs.readFile(path.join(f.settings.dataDir, 'downloads.json'), 'utf8');
  assert.ok(!journal.includes(credentials.user) && !journal.includes(credentials.password));
  await assert.rejects(f.manager.resume(task.id), /credentials|RAM-only/i);
  await f.manager.bindFtpCredentials(task.id, credentials);
  const transferIndex = f.transfers.length; await f.manager.resume(task.id); const done = await complete(f, task.id);
  assert.equal(done.id, task.id); assert.equal(f.transfers[transferIndex].start, paused.downloadedBytes);
  assert.equal(Object.hasOwn(done, 'ftpCredentials'), false); assert.equal(f.manager.ftpSecrets.has(task.id), false);
  const queued = await f.manager.add({ url: f.url, ftpCredentials: credentials, startAt: Date.now()+60000 }); assert.equal(f.manager.ftpSecrets.has(queued.id), true); await f.manager.cancel(queued.id); assert.equal(f.manager.ftpSecrets.has(queued.id), false);
});
test('manager refuses changed FTP MDTM on resume without altering partial bytes or publishing', async t => {
  const f = await fixture(t, { delay: 10, body: Buffer.alloc(256 * 1024, 62) }); const task = await f.manager.add({ url: f.url });
  await waitFor(f.manager, task.id, task => task.downloadedBytes >= 16384); await f.manager.pause(task.id);
  const partial = path.join(f.settings.dataDir, task.id + '.part'), before = await fs.readFile(partial), transferCount = f.transfers.length;
  f.state.modified = '20261026020000'; await f.manager.resume(task.id);
  const failed = await waitFor(f.manager, task.id, task => task.status === 'failed');
  assert.match(failed.error, /identity|changed|resume/i); assert.equal(failed.downloadedBytes, before.length);
  assert.deepEqual(await fs.readFile(partial), before); assert.equal(f.transfers.length, transferCount);
  await assert.rejects(fs.stat(task.path), { code: 'ENOENT' });
});
test('manager configured proxy refuses FTP before contacting its origin', async t => {
  const f = await fixture(t);
  await f.manager.configure({ proxy: { type: 'http', host: '127.0.0.1', port: 9, username: 'fixture-proxy', password: 'fixture-proxy-password' } });
  const task = await f.manager.add({ url: f.url });
  const failed = await waitFor(f.manager, task.id, task => task.status === 'failed');
  assert.match(failed.error, /FTP.*proxy|direct fallback/i); assert.equal(f.state.connections, 0);
  assert.ok(!JSON.stringify(f.manager.list()).includes('fixture-proxy-password'));
});
