'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFtpFixture } = require('../helpers/ftp-fixture.cjs');
const { testCertificate } = require('../helpers/tls-fixture.cjs');
const { inspectFtp, listFtp, downloadFtp } = require('../../src/core/ftp-download.cjs');
test('FTP passive Unicode listing, SIZE/MDTM and actual download preserve exact bytes', async t => {
  const f = await createFtpFixture(t); const inspected = await inspectFtp({ url: f.url });
  assert.equal(inspected.totalBytes, f.state.body.length); assert.equal(inspected.identity.modifiedAt, '2026-10-26T01:00:00.000Z');
  const listing = await listFtp({ url: new URL('/', f.url).href }); assert.equal(listing[0].name, 'ảnh.bin');
  let progress; const done = await downloadFtp({ url: f.url, partialPath: f.partialPath, onProgress: value => { progress = value; } });
  assert.deepEqual(await fs.readFile(f.partialPath), f.state.body); assert.equal(done.totalBytes, f.state.body.length); assert.equal(progress.downloadedBytes, f.state.body.length); assert.equal(progress.activeConnections, 1);
  assert.ok(f.commands.some(c => c.verb === 'EPSV')); assert.ok(f.commands.some(c => c.verb === 'RETR' && c.value === '/ảnh.bin'));
});
test('FTP pause retains bytes and REST resumes only the committed local offset', async t => {
  const f = await createFtpFixture(t, { delay: 10 }); const controller = new AbortController(); let checkpoint;
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, signal: controller.signal, onProgress: value => { checkpoint = value; if (value.downloadedBytes >= 16384) controller.abort(); } }));
  const first = await fs.readFile(f.partialPath); assert.ok(first.length >= 16384 && first.length < f.state.body.length);
  const before = f.transfers.length;
  await downloadFtp({ url: f.url, partialPath: f.partialPath, startOffset: first.length, expectedIdentity: checkpoint.identity });
  assert.deepEqual(await fs.readFile(f.partialPath), f.state.body); assert.equal(f.transfers[before].start, first.length); assert.equal(f.transfers[before].bytes, f.state.body.length - first.length);
  assert.ok(f.commands.some(c => c.verb === 'REST' && c.value === String(first.length)));
});
test('FTP changed or missing resume identity is refused without modifying partial bytes', async t => {
  const f = await createFtpFixture(t); const info = await inspectFtp({ url: f.url }); const partial = f.state.body.subarray(0, 8192); await fs.writeFile(f.partialPath, partial);
  f.state.modified = '20261026020000';
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, startOffset: partial.length, expectedIdentity: info.identity }), /identity|changed/i);
  f.state.modified = '20261026010000'; f.state.missingMdtm = true;
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, startOffset: partial.length, expectedIdentity: info.identity }), /identity|MDTM/i);
  assert.deepEqual(await fs.readFile(f.partialPath), partial); assert.equal(f.transfers.length, 0);
});
test('explicit FTPS validates certificate on control and passive data channels', async t => {
  const f = await createFtpFixture(t, { secure: true });
  await assert.rejects(inspectFtp({ url: f.url }), /certificate|TLS/i);
  await assert.rejects(inspectFtp({ url: f.url, tlsOptions: { rejectUnauthorized: false } }), /TLS|option/i);
  const info = await inspectFtp({ url: f.url, tlsOptions: { ca: f.cert } }); assert.equal(info.secure, true);
  await downloadFtp({ url: f.url, partialPath: f.partialPath, tlsOptions: { ca: f.cert } }); assert.deepEqual(await fs.readFile(f.partialPath), f.state.body);
  assert.ok(f.commands.some(c => c.verb === 'AUTH')); assert.ok(f.commands.some(c => c.verb === 'PROT' && c.value === 'P'));
});
test('FTP validates boundaries before network, credentials stay RAM and errors are redacted', async t => {
  const f = await createFtpFixture(t, { user: 'private-user', password: 'private-secret' });
  for (const input of [{ url: f.url.replace('ftp://', 'ftp://user:secret@') }, { url: f.url.replace(/\/[^/]+$/, '/x%0d%0aDELE%20file') }, { url: f.url, proxy: 'http://127.0.0.1:1' }, { url: f.url, credentials: { user: 'x\r\nDELE file', password: 'x' } }]) await assert.rejects(inspectFtp(input));
  assert.equal(f.state.connections, 0);
  await assert.rejects(inspectFtp({ url: f.url, credentials: { user: 'private-user', password: 'wrong-secret' } }), error => !/private-user|wrong-secret|private-secret/.test(error.message));
  const info = await inspectFtp({ url: f.url, credentials: { user: 'private-user', password: 'private-secret' } }); assert.ok(info.totalBytes > 0);
  assert.ok(!JSON.stringify(info).includes('private')); assert.ok(!JSON.stringify(f.commands).includes('private-secret'));
});
test('FTP size limits and existing destination/offset mismatches preserve local data', async t => {
  const f = await createFtpFixture(t); await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, maxBytes: 100 }), /size|limit/i);
  await assert.rejects(fs.stat(f.partialPath), { code: 'ENOENT' });
  await fs.writeFile(f.partialPath, 'original');
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath }), /exist|partial/i);
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, startOffset: 5, expectedIdentity: (await inspectFtp({ url: f.url })).identity }), /offset|size/i);
  assert.equal(await fs.readFile(f.partialPath, 'utf8'), 'original');
});
test('FTP speed cap applies to actual persisted bytes and abort stops capped transfer', async t => {
  const f = await createFtpFixture(t, { body: Buffer.alloc(32768, 11), delay: 0 }); const start = Date.now();
  await downloadFtp({ url: f.url, partialPath: f.partialPath, speedLimit: 16384 }); assert.ok(Date.now() - start >= 1800);
  assert.deepEqual(await fs.readFile(f.partialPath), f.state.body);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
  await assert.rejects(downloadFtp({ url: f.url, partialPath: path.join(f.root, 'abort.part'), speedLimit: 1, signal: controller.signal }));
});
test('FTP reconnect resumes an owned zero-byte partial after cancellation before data', async t => {
  const f = await createFtpFixture(t); const controller = new AbortController(); let identity;
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, signal: controller.signal, onProgress: value => { identity = value.identity; controller.abort(); } }));
  assert.equal((await fs.stat(f.partialPath)).size, 0);
  await downloadFtp({ url: f.url, partialPath: f.partialPath, startOffset: 0, expectedIdentity: identity });
  assert.deepEqual(await fs.readFile(f.partialPath), f.state.body);
});
test('FTP refuses publication when SIZE or MDTM changes during the transfer', async t => {
  const f = await createFtpFixture(t); let changed = false;
  await assert.rejects(downloadFtp({ url: f.url, partialPath: f.partialPath, onProgress: value => { if (!changed && value.downloadedBytes > 0) { changed = true; f.state.modified = '20261026020000'; } } }), /identity|changed/i);
  assert.deepEqual(await fs.readFile(f.partialPath), f.state.body);
});
test('FTP falls back to PASV and FTPS rejects an untrusted passive data certificate', async t => {
  const plain = await createFtpFixture(t, { disableEpsv: true });
  await downloadFtp({ url: plain.url, partialPath: plain.partialPath }); assert.deepEqual(await fs.readFile(plain.partialPath), plain.state.body); assert.ok(plain.commands.some(c => c.verb === 'PASV'));
  const other = await createFtpFixture(t, { secure: true });
  const isolated = path.join(other.root, 'other-certificate'); await fs.mkdir(isolated); const dataCertificates = await testCertificate(isolated);
  const secure = await createFtpFixture(t, { secure: true, dataCertificates });
  await assert.rejects(downloadFtp({ url: secure.url, partialPath: secure.partialPath, tlsOptions: { ca: secure.cert } }), /certificate|TLS/i);
  assert.equal((await fs.stat(secure.partialPath)).size, 0);
});
test('FTP resume refuses a different principal with same path SIZE and MDTM',async t=>{const f=await createFtpFixture(t,{accounts:{alice:{password:'a',body:Buffer.alloc(131072,65)},bob:{password:'b',body:Buffer.alloc(131072,66)}}});const signal=new AbortController();let identity;await assert.rejects(downloadFtp({url:f.url,credentials:{user:'alice',password:'a'},partialPath:f.partialPath,signal:signal.signal,onProgress:p=>{identity=p.identity;if(p.downloadedBytes>=16384)signal.abort();}}));const before=await fs.readFile(f.partialPath);assert.ok(before.length>0);await assert.rejects(downloadFtp({url:f.url,credentials:{user:'bob',password:'b'},partialPath:f.partialPath,startOffset:before.length,expectedIdentity:identity}),/identity/);assert.deepEqual(await fs.readFile(f.partialPath),before);assert.ok(!JSON.stringify(identity).includes('alice'));});
