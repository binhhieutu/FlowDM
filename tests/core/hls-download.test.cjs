const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DownloadManager } = require('../../src/core/download-manager.cjs');
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST';
function packet(value) { const bytes = Buffer.alloc(188, value); bytes[0] = 0x47; return bytes; }
function box(type, value) { const header = Buffer.alloc(8); const payload = Buffer.from(value); header.writeUInt32BE(8 + payload.length); header.write(type, 4); return Buffer.concat([header, payload]); }
const a = packet(1), b = packet(2), c = packet(3);
const init = Buffer.concat([box('ftyp', 'isom'), box('moov', 'init')]);
const fragmentA = Buffer.concat([box('moof', 'head-a'), box('mdat', 'data-a')]);
const fragmentB = Buffer.concat([box('styp', 'isom'), box('sidx', 'index'), box('moof', 'head-b'), box('mdat', 'data-b')]);
async function setup(t, handler, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-hls-'));
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const config = { dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'files'), ...options };
  const manager = await new DownloadManager(config).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  return { manager, root, config, url: `http://127.0.0.1:${server.address().port}/list.m3u8` };
}
async function wait(manager, id, states = ['completed', 'failed']) {
  for (let i = 0; i < 500; i++) { const task = manager.list().find(t => t.id === id); if (states.includes(task.status)) return task; await new Promise(r => setTimeout(r, 10)); }
  throw Error(JSON.stringify(manager.list()));
}
test('HLS auto detection downloads exact TS concatenation through queue and SHA-256 publication', async t => {
  const { manager, url, root } = await setup(t, (req, res) => res.end(req.url.startsWith('/list') ? playlist : req.url === '/a.ts' ? a : b));
  const task = await manager.add({ url: `${url}?token=signed`, headers: { Cookie: 'private-cookie' } });
  const done = await wait(manager, task.id); assert.equal(done.status, 'completed', done.error);
  assert.equal(done.mediaType, 'hls'); assert.equal(done.filename, 'list.ts');
  assert.deepEqual(await fs.readFile(done.path), Buffer.concat([a, b])); assert.equal(done.totalBytes, 376);
  assert.equal(done.sha256, crypto.createHash('sha256').update(Buffer.concat([a, b])).digest('hex'));
  assert.ok(!(await fs.readFile(path.join(root, 'data/downloads.json'), 'utf8')).includes('private-cookie'));
});
test('HLS master selects highest bandwidth and fMP4 initialization precedes fragments', async t => {
  const { manager, url } = await setup(t, (req, res) => {
    if (req.url === '/list.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9\nhigh.m3u8');
    if (req.url === '/high.m3u8') return res.end(playlist.replace('#EXTINF:2,', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,'));
    res.end(req.url === '/init.mp4' ? init : req.url === '/a.ts' ? fragmentA : fragmentB);
  });
  const done = await wait(manager, (await manager.add({ url })).id);
  assert.equal(done.status, 'completed', done.error); assert.equal(done.filename, 'list.mp4'); assert.deepEqual(await fs.readFile(done.path), Buffer.concat([init, fragmentA, fragmentB]));
});
test('HLS pause and manager restart resume safely restart from first segment', async t => {
  let first = 0;
  const { manager, url, config } = await setup(t, (req, res) => {
    if (req.url === '/list.m3u8') return res.end(playlist);
    if (req.url === '/a.ts') { first++; return res.end(a); }
    res.write(b); setTimeout(() => res.end(c), 300);
  });
  const task = await manager.add({ url, speedLimit: 10000 });
  while (manager.list()[0].downloadedBytes < 188) await new Promise(r => setTimeout(r, 10));
  await manager.pause(task.id); assert.equal(manager.list()[0].status, 'paused'); await manager.close();
  const restored = await new DownloadManager(config).init();
  await restored.resume(task.id); const done = await wait(restored, task.id);
  assert.equal(done.status, 'completed', done.error); assert.ok(first >= 2); assert.deepEqual(await fs.readFile(done.path), Buffer.concat([a, b, c]));
  await restored.close();
});
test('HLS unsafe manifests and segment errors never publish a completed file', async t => {
  for (const mode of ['live', 'encrypted', 'audio', 'range', 'failed', 'large', 'truncated', 'empty']) {
    const { manager, url } = await setup(t, (req, res) => {
      if (req.url === '/list.m3u8') return res.end(mode === 'live' ? playlist.replace('#EXT-X-ENDLIST', '') : mode === 'encrypted' ? playlist.replace('a.ts', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\na.ts') : mode === 'audio' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="audio"\nother.m3u8' : mode === 'range' ? playlist.replace('a.ts', '#EXT-X-BYTERANGE:3@0\na.ts') : playlist);
      if (mode === 'failed') { res.writeHead(404); return res.end(); }
      if (mode === 'truncated') { res.writeHead(200, { 'Content-Length': 30 }); res.write('abc'); return setTimeout(() => res.destroy(), 5); }
      res.end(mode === 'large' ? 'A'.repeat(40) : mode === 'empty' ? '' : 'AAA');
    }, { maxBytes: 20 });
    const task = await manager.add({ url }); const done = await wait(manager, task.id);
    assert.equal(done.status, 'failed', mode); await assert.rejects(fs.stat(done.path), { code: 'ENOENT' });
  }
});
test('HLS strips credential context for cross-origin variants and redirects', async t => {
  let leaked = false;
  const target = http.createServer((req, res) => { if (req.headers.cookie || req.headers.authorization || req.headers.referer) leaked = true; res.end(req.url === '/vod' ? playlist : a); });
  await new Promise(r => target.listen(0, '127.0.0.1', r)); t.after(() => { target.closeAllConnections(); target.close(); });
  const { manager, url } = await setup(t, (req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/vod` }); res.end(); });
  const task = await manager.add({ url, headers: { Cookie: 'secret', Authorization: 'secret', Referer: 'https://private/' } });
  assert.equal((await wait(manager, task.id)).status, 'completed'); assert.equal(leaked, false);
});
test('validates media type, bounded URL and explicit direct override', async t => {
  const { manager, url } = await setup(t, (req, res) => res.end('plain'));
  await assert.rejects(manager.add({ url, mediaType: 'dash' }), /Media type/);
  await assert.rejects(manager.add({ url: `${url}?${'x'.repeat(32769)}` }), /32768/);
  await assert.rejects(manager.add({ url: `${url}?${'é'.repeat(6000)}` }), /32768/);
  const done = await wait(manager, (await manager.add({ url, mediaType: 'direct' })).id);
  assert.equal(done.status, 'completed'); assert.equal(await fs.readFile(done.path, 'utf8'), 'plain');
});
test('HLS refuses HTTP 200 HTML, packed AAC, invalid initialization and fragment boxes', async t => {
  for (const mode of ['html', 'aac', 'bad-init', 'bad-fragment', 'partial-ts', 'bad-sync']) {
    const mapped = mode.startsWith('bad-');
    const { manager, url } = await setup(t, (req, res) => {
      if (req.url === '/list.m3u8') return res.end(mapped ? playlist.replace('#EXTINF:2,', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,') : playlist);
      if (req.url === '/init.mp4') return res.end(mode === 'bad-init' ? Buffer.from('<html>login</html>') : init);
      if (mode === 'html') return res.end('<html>login required</html>');
      if (mode === 'aac') return res.end(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc]));
      if (mode === 'partial-ts') return res.end(a.subarray(0, 187));
      if (mode === 'bad-sync') return res.end(Buffer.concat([a, Buffer.alloc(188)]));
      res.end(box('mdat', 'no-moof'));
    });
    const done = await wait(manager, (await manager.add({ url })).id);
    assert.equal(done.status, 'failed', mode); assert.match(done.error, /MPEG-TS|MP4/);
    await assert.rejects(fs.stat(done.path), { code: 'ENOENT' });
  }
});
