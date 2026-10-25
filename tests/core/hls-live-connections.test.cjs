'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { transferHlsParallel } = require('../../src/media/hls-parallel.cjs');
const packet = value => { const data = Buffer.alloc(188, value); data[0] = 0x47; return data; };
async function until(check) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw Error('Timed out waiting for fragment workers'); await delay(5); } }
async function fixture(t, connections = 1, speedLimit = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-live-'));
  const bodies = Array.from({ length: 20 }, (_, i) => packet(i)); const calls = []; let active = 0, peak = 0;
  const server = http.createServer((req, res) => {
    const index = Number(req.url.slice(1)); calls.push(index); active++; peak = Math.max(peak, active);
    let done = false; const finish = () => { if (!done) { done = true; active--; } };
    res.on('close', finish); const timer = setTimeout(() => { res.writeHead(200, { 'content-length': bodies[index].length }); res.end(bodies[index]); }, 70);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController(); const output = []; const events = []; let control; let cleared = false;
  const url = 'http://127.0.0.1:' + server.address().port;
  const run = transferHlsParallel({ playlist: { resources: bodies.map((_, i) => url + '/' + i), context: { url, headers: {} }, extension: '.ts' }, connections, speedLimit, tempRoot: root, checkpointDir: path.join(root, 'cache'), maxBytes: 100000, signal: controller.signal, append: async chunk => output.push(chunk), onProgress: event => events.push(event), onControlReady: value => { if (value) control = value; else cleared = true; } });
  run.catch(() => {});
  t.after(async () => { controller.abort(); await run.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-hls-live-')); await fs.rm(root, { recursive: true, force: true }); });
  await until(() => control || events.some(e => e.completedResources === 20)); assert.ok(control, 'live resize control must be exposed');
  return { run, controller, output, events, calls, bodies, get control() { return control; }, get active() { return active; }, get peak() { return peak; }, get cleared() { return cleared; } };
}
test('HLS live 1 to 4 to 1 keeps every resource exactly once and drains before decrease commit', async t => {
  const f = await fixture(t); await until(() => f.active === 1);
  let commits = 0; await f.control.resize(4, async () => { commits++; assert.ok(f.peak <= 1); });
  await until(() => f.active === 4);
  await f.control.resize(1, async () => { commits++; assert.ok(f.events.at(-1).activeConnections <= 1); });
  const result = await f.run; assert.equal(commits, 2); assert.equal(f.peak, 4); assert.equal(result.peakWorkers, 4);
  assert.deepEqual(f.calls.slice().sort((a,b) => a-b), f.bodies.map((_,i) => i)); assert.deepEqual(Buffer.concat(f.output), Buffer.concat(f.bodies)); assert.ok(f.cleared);
  await assert.rejects(f.control.resize(2), /finished|Aborted/);
});
test('HLS live resize keeps one aggregate rate epoch', async t => {
  const began = Date.now(); const f = await fixture(t, 1, 3760); await f.control.resize(4); await until(() => f.events.some(e => e.completedResources >= 5)); await f.control.resize(2);
  const result = await f.run; assert.equal(result.networkBytes, 3760); assert.ok(Date.now() - began >= 950, 'aggregate cap must not reset or multiply when N changes'); assert.equal(new Set(f.calls).size, 20);
});
test('HLS failed increase and decrease commits restore worker cap without replay', async t => {
  const f = await fixture(t, 4); await until(() => f.active === 4);
  await assert.rejects(f.control.resize(1, async () => { throw Error('journal denied'); }), /journal denied/); await until(() => f.active === 4);
  await assert.rejects(f.control.resize(8, async () => { throw Error('journal denied'); }), /journal denied/);
  await f.run; assert.ok(f.peak <= 4); assert.equal(f.calls.length, 20); assert.equal(new Set(f.calls).size, 20);
});
test('HLS abort while decreasing rejects resize and preserves completed checkpoint', async t => {
  const f = await fixture(t, 4); await until(() => f.events.some(e => e.completedResources >= 1) && f.active === 4);
  const resizing = f.control.resize(1); f.controller.abort(); await assert.rejects(resizing, /Aborted|finished/); await assert.rejects(f.run, { name: 'AbortError' }); assert.ok(f.cleared); assert.ok(f.events.some(e => e.completedResources >= 1));
});
test('HLS live control rejects invalid N without affecting transfer', async t => {
  const f = await fixture(t); for (const value of [0,17,1.5,'4']) await assert.rejects(f.control.resize(value), /Connections/);
  await f.run; assert.equal(f.peak,1); assert.ok(f.events.every(e => Number.isInteger(e.activeConnections)));
});
