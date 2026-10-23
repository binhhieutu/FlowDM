'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { transferHlsParallel } = require('../../src/media/hls-parallel.cjs');
const packet = value => { const bytes = Buffer.alloc(188, value); bytes[0] = 0x47; return bytes; };
const box = (type, value) => { const payload = Buffer.from(value); const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); };
function mockedGet(resources, { slow = false, fail = -1 } = {}) {
  let active = 0, peak = 0;
  const get = async url => { const index = Number(url); active++; peak = Math.max(peak, active); if (slow || index === 0) await new Promise(resolve => setTimeout(resolve, index === fail ? 5 : 35)); active--; if (index === fail) throw Error('fixture failed'); const body = resources[index]; const stream = Readable.from([body]); stream.headers = { 'content-length': String(body.length) }; return { response: stream }; };
  return { get, state: () => ({ active, peak }) };
}
test('HLS workers honor requested concurrency and append out-of-order TS files deterministically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = [packet(1), packet(2), packet(3), packet(4)]; let active = 0, peak = 0; const output = [];
  const get = async url => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, Number(url) === 0 ? 50 : 5)); active--; const body = resources[Number(url)]; const stream = Readable.from([body]); stream.headers = { 'content-length': String(body.length) }; return { response: stream }; };
  const result = await transferHlsParallel({ playlist: { resources: ['0', '1', '2', '3'], extension: '.ts', context: {} }, connections: 4, tempRoot: root, maxBytes: 10000, speedLimit: 0, signal: new AbortController().signal, get, append: async chunk => output.push(chunk) });
  assert.ok(peak > 1 && peak <= 4); assert.equal(result.peakWorkers, 4); assert.deepEqual(Buffer.concat(output), Buffer.concat(resources));
});
test('N=1 has exactly one active worker and fMP4 keeps init before out-of-order fragments', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const init = Buffer.concat([box('ftyp', 'isom'), box('moov', 'init')]), a = Buffer.concat([box('moof', 'a'), box('mdat', 'a')]), b = Buffer.concat([box('moof', 'b'), box('mdat', 'b')]);
  const mock = mockedGet([init, a, b]); const output = [];
  const result = await transferHlsParallel({ playlist: { resources: ['0', '1', '2'], extension: '.mp4', context: {} }, connections: 1, tempRoot: root, maxBytes: 10000, speedLimit: 0, signal: new AbortController().signal, get: mock.get, append: async chunk => output.push(chunk) });
  assert.equal(mock.state().peak, 1); assert.equal(result.peakWorkers, 1); assert.deepEqual(Buffer.concat(output), Buffer.concat([init, a, b]));
});
test('parallel failure aborts peers, cleans scratch, and rejects combined size overflow', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = [packet(1), packet(2), packet(3)]; const failed = mockedGet(resources, { slow: true, fail: 0 });
  await assert.rejects(transferHlsParallel({ playlist: { resources: ['0', '1', '2'], extension: '.ts', context: {} }, connections: 3, tempRoot: root, maxBytes: 10000, speedLimit: 0, signal: new AbortController().signal, get: failed.get, append: async () => {} }), /fixture failed/);
  assert.equal(failed.state().active, 0); assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('hls-')), []);
  const oversized = mockedGet([packet(1), packet(2), packet(3)]);
  await assert.rejects(transferHlsParallel({ playlist: { resources: ['0', '1', '2'], extension: '.ts', context: {} }, connections: 3, tempRoot: root, maxBytes: 400, speedLimit: 0, signal: new AbortController().signal, get: oversized.get, append: async () => {} }), /size limit/);
});
test('parallel aggregate speed cap applies to all workers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = [packet(1), packet(2), packet(3), packet(4)]; const mock = mockedGet(resources); const output = []; const began = Date.now();
  await transferHlsParallel({ playlist: { resources: ['0', '1', '2', '3'], extension: '.ts', context: {} }, connections: 4, tempRoot: root, maxBytes: 10000, speedLimit: 1000, signal: new AbortController().signal, get: mock.get, append: async chunk => output.push(chunk) });
  assert.ok(Date.now() - began >= 600); assert.deepEqual(Buffer.concat(output), Buffer.concat(resources));
});
test('abort waits for active parallel workers and removes owned scratch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = mockedGet([packet(1), packet(2), packet(3), packet(4)], { slow: true }); const controller = new AbortController(); setTimeout(() => controller.abort(), 8).unref();
  await assert.rejects(transferHlsParallel({ playlist: { resources: ['0', '1', '2', '3'], extension: '.ts', context: {} }, connections: 4, tempRoot: root, maxBytes: 10000, speedLimit: 0, signal: controller.signal, get: mock.get, append: async () => {} }), /Aborted/);
  assert.equal(mock.state().active, 0); assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('hls-')), []);
});
test('stalled first HLS resource gates scheduling to N and preserves a later root error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-parallel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = Array.from({ length: 12 }, (_, index) => packet(index + 1)); let started = 0; let release; const hold = new Promise(resolve => { release = resolve; });
  const get = async url => { const index = Number(url); started++; if (index === 0) await hold; if (index === 2) throw Error('worker-two-validation'); const body = resources[index]; const stream = Readable.from([body]); stream.headers = { 'content-length': String(body.length) }; return { response: stream }; };
  const promise = transferHlsParallel({ playlist: { resources: resources.map((_, index) => String(index)), extension: '.ts', context: {} }, connections: 4, tempRoot: root, maxBytes: 10000, speedLimit: 0, signal: new AbortController().signal, get, append: async () => {} });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(started <= 4); release();
  await assert.rejects(promise, /worker-two-validation/); assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('hls-')), []);
});
