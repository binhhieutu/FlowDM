'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { loadPlaylist } = require('../../src/media/hls.cjs');
const http = require('node:http');
const { transferHlsParallel } = require('../../src/media/hls-parallel.cjs');
const packet = value => { const data = Buffer.alloc(188, value); data[0] = 0x47; return data; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-resume-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = [packet(1), packet(2), packet(3), packet(4)]; const calls = []; const playlist = { resources: ['0', '1', '2', '3'], extension: '.ts', context: { headers: { cookie: 'secret-cookie' } } };
  const get = async url => { calls.push(Number(url)); const response = Readable.from([resources[Number(url)]]); response.headers = { 'content-length': '188' }; return { response }; };
  return { root, resources, calls, playlist, get, options: { playlist, connections: 1, tempRoot: root, checkpointDir: path.join(root, 'checkpoint'), maxBytes: 10000, speedLimit: 0, get } };
}
test('HLS pause/reopen reuses durable resources without repeat requests and reconstructs full output', async t => {
  const f = await fixture(t); const controller = new AbortController();
  await assert.rejects(transferHlsParallel({ ...f.options, signal: controller.signal, append: async () => {}, onProgress: event => { if (event.completedResources === 2) controller.abort(); } }), /Aborted/);
  assert.deepEqual(f.calls, [0, 1]); const output = []; const progress = [];
  const result = await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async chunk => output.push(chunk), onProgress: event => progress.push(event) });
  assert.deepEqual(f.calls, [0, 1, 2, 3]); assert.deepEqual(Buffer.concat(output), Buffer.concat(f.resources));
  assert.equal(result.reusedResources, 2); assert.equal(result.completedResources, 4); assert.equal(result.networkBytes, 376); assert.equal(result.bytes, 752);
  assert.equal(progress.at(-1).cumulativeBytes, 752);
  const metadata = await fs.readFile(path.join(f.options.checkpointDir, 'checkpoint.json'), 'utf8'); assert.ok(!metadata.includes('secret-cookie'));
});
test('HLS changed playlist or tampered/missing cache refuses continuation before network requests', async t => {
  for (const mutation of ['playlist', 'tamper', 'missing', 'size']) {
    const f = await fixture(t); await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} }); const before = f.calls.length;
    let options = f.options;
    if (mutation === 'playlist') options = { ...options, playlist: { ...f.playlist, resources: ['changed', '1', '2', '3'] } };
    if (mutation === 'tamper') await fs.writeFile(path.join(options.checkpointDir, 'index-0.bin'), packet(9));
    if (mutation === 'missing') await fs.unlink(path.join(options.checkpointDir, 'index-0.bin'));
    if (mutation === 'size') options = { ...options, maxBytes: 500 };
    await assert.rejects(transferHlsParallel({ ...options, signal: new AbortController().signal, append: async () => {} }), /checkpoint|size limit/i); assert.equal(f.calls.length, before);
  }
});
test('HLS completed out-of-order resource survives earlier resource abort', async t => {
  const f = await fixture(t); const controller = new AbortController(); let completed;
  const saved = new Promise(resolve => { completed = resolve; });
  const get = async (url, context, signal) => {
    if (url === '0') { await saved; controller.abort(); throw Object.assign(Error('Aborted'), { name: 'AbortError' }); }
    return f.get(url, context, signal);
  };
  const run = transferHlsParallel({ ...f.options, connections: 2, get, signal: controller.signal, append: async () => {}, onProgress: event => { if (event.completedResources >= 1) completed(); } });
  await assert.rejects(run, /Aborted/);
  const result = await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} });
  assert.equal(result.reusedResources, 1); assert.equal(f.calls.filter(index => index === 1).length, 1);
});
test('HLS in-flight partial restarts while completed fragments remain reusable and unthrottled', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const get = async (url, context, signal) => {
    if (url !== '1') return f.get(url, context, signal);
    const response = Readable.from((async function* () { yield f.resources[1].subarray(0, 94); controller.abort(); yield f.resources[1].subarray(94); })());
    response.headers = { 'content-length': '188' }; return { response };
  };
  await assert.rejects(transferHlsParallel({ ...f.options, get, signal: controller.signal, append: async () => {} }), /Aborted/);
  const result = await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} });
  assert.equal(result.reusedResources, 1); assert.equal(result.networkBytes, 564);
  const before = Date.now(); const cached = await transferHlsParallel({ ...f.options, speedLimit: 1, signal: new AbortController().signal, append: async () => {} });
  assert.equal(cached.networkBytes, 0); assert.equal(cached.reusedResources, 4); assert.ok(Date.now() - before < 500);
});
test('HLS rejects invalid checkpoint JSON and metadata indexes without using stored paths', async t => {
  for (const mutation of ['json', 'index', 'container', 'hardlink']) {
    const f = await fixture(t); await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} });
    const file = path.join(f.options.checkpointDir, 'checkpoint.json'); const state = JSON.parse(await fs.readFile(file, 'utf8')); const calls = f.calls.length;
    if (mutation === 'json') await fs.writeFile(file, '{bad');
    if (mutation === 'index') { state.resources[0].index = '../outside'; await fs.writeFile(file, JSON.stringify(state)); }
    if (mutation === 'container') {
      const invalid = Buffer.alloc(188); await fs.writeFile(path.join(f.options.checkpointDir, 'index-0.bin'), invalid);
      state.resources[0].sha256 = crypto.createHash('sha256').update(invalid).digest('hex'); await fs.writeFile(file, JSON.stringify(state));
    }
    if (mutation === 'hardlink') await fs.link(path.join(f.options.checkpointDir, 'index-0.bin'), path.join(f.root, 'outside-link'));
    await assert.rejects(transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} }), /checkpoint/i); assert.equal(f.calls.length, calls);
  }
});
test('HLS fMP4 cached init and media fragments reconstruct in order on reopen', async t => {
  const f = await fixture(t); const box = (type, value) => { const data = Buffer.from(value); const header = Buffer.alloc(8); header.writeUInt32BE(8 + data.length); header.write(type, 4); return Buffer.concat([header, data]); };
  f.resources.splice(0, 4, Buffer.concat([box('ftyp', 'isom'), box('moov', 'init')]), ...['a', 'b', 'c'].map(value => Buffer.concat([box('moof', value), box('mdat', value)])));
  const get = async url => { f.calls.push(Number(url)); const body = f.resources[Number(url)]; const response = Readable.from([body]); response.headers = { 'content-length': String(body.length) }; return { response }; };
  const playlist = { ...f.playlist, extension: '.mp4' }; const controller = new AbortController();
  await assert.rejects(transferHlsParallel({ ...f.options, playlist, get, signal: controller.signal, append: async () => {}, onProgress: event => { if (event.completedResources === 2) controller.abort(); } }), /Aborted/);
  const output = []; const result = await transferHlsParallel({ ...f.options, playlist, get, connections: 4, signal: new AbortController().signal, append: async chunk => output.push(chunk) });
  assert.deepEqual(f.calls, [0, 1, 2, 3]); assert.equal(result.reusedResources, 2); assert.deepEqual(Buffer.concat(output), Buffer.concat(f.resources));
});
test('HLS refuses stable resources absent from metadata after an interrupted checkpoint commit', async t => {
  const f = await fixture(t); await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} });
  const filename = path.join(f.options.checkpointDir, 'checkpoint.json'); const state = JSON.parse(await fs.readFile(filename, 'utf8'));
  state.resources = state.resources.slice(0, -1); await fs.writeFile(filename, JSON.stringify(state)); const before = f.calls.length;
  await assert.rejects(transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} }), /checkpoint.*unreferenced/i);
  assert.equal(f.calls.length, before); assert.equal((await fs.stat(path.join(f.options.checkpointDir, 'index-3.bin'))).size, 188);
});
test('HLS atomically retries transient checkpoint sharing violations without removing old metadata', async t => {
  const f = await fixture(t); const rename = fs.rename; let failures = 0;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (source.endsWith('checkpoint.tmp') && failures++ < 3) throw Object.assign(Error('sharing violation'), { code: 'EPERM' });
    return rename(source, destination);
  });
  const result = await transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} });
  assert.equal(result.completedResources, 4); assert.ok(failures >= 4);
});
test('HLS checkpoint rename retries are bounded and retain the last durable metadata on permanent denial', async t => {
  const f = await fixture(t); const controller = new AbortController();
  await assert.rejects(transferHlsParallel({ ...f.options, signal: controller.signal, append: async () => {}, onProgress: event => { if (event.completedResources === 1) controller.abort(); } }), /Aborted/);
  const file = path.join(f.options.checkpointDir, 'checkpoint.json'); const before = await fs.readFile(file, 'utf8'); const rename = fs.rename; let failures = 0;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (source.endsWith('checkpoint.tmp')) { failures++; throw Object.assign(Error('permanent sharing denial'), { code: 'EPERM' }); }
    return rename(source, destination);
  });
  await assert.rejects(transferHlsParallel({ ...f.options, signal: new AbortController().signal, append: async () => {} }), /permanent sharing denial/);
  assert.equal(failures, 8); assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('HLS refuses changed EXTINF or media sequence even with identical resource URLs', async t => {
  const f = await fixture(t); let manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\n0\n#EXT-X-ENDLIST';
  const server = http.createServer((req, res) => res.end(manifest)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/list.m3u8`; const signal = new AbortController().signal;
  const get = async resource => f.get(new URL(resource).pathname.slice(1)); const first = await loadPlaylist(url, {}, signal);
  await transferHlsParallel({ ...f.options, playlist: first, get, signal, append: async () => {} }); const before = f.calls.length;
  for (const changed of [manifest.replace('#EXTINF:2,', '#EXTINF:3,'), manifest.replace('SEQUENCE:1', 'SEQUENCE:2')]) {
    manifest = changed; const playlist = await loadPlaylist(url, {}, signal); assert.deepEqual(playlist.resources, first.resources);
    await assert.rejects(transferHlsParallel({ ...f.options, playlist, get, signal, append: async () => {} }), /checkpoint.*identity/i); assert.equal(f.calls.length, before);
  }
});
test('HLS pure playlist callers pin explicit semantic fields and reject malformed manifest identities', async t => {
  const f = await fixture(t); const signal = new AbortController().signal;
  const playlist = { ...f.playlist, segmentCount: 4, mediaSequence: 1, durations: [2, 2, 2, 2] };
  await transferHlsParallel({ ...f.options, playlist, signal, append: async () => {} }); const before = f.calls.length;
  for (const changed of [{ ...playlist, mediaSequence: 2 }, { ...playlist, durations: [3, 2, 2, 2] }, { ...playlist, manifestIdentity: 'bad' }]) {
    await assert.rejects(transferHlsParallel({ ...f.options, playlist: changed, signal, append: async () => {} }), /checkpoint.*identity/i);
    assert.equal(f.calls.length, before);
  }
});
