const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBrowserAdmission } = require('../../src/browser/admission.cjs');
test('browser ownership ACK requires an accessible non-login response before queueing', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/auth' && req.headers.cookie !== 'session=ok') { res.writeHead(401).end(); return; }
    if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Login</h1>'); return; }
    if (req.url === '/live.m3u8') { res.end('#EXTM3U\n#EXTINF:1,\na.ts\n'); return; }
    if (req.url === '/slow') return;
    if (req.url === '/encoded') { res.writeHead(200, { 'Content-Encoding': 'gzip' }).end('encoded'); return; }
    if (req.url === '/wrong-range') { res.writeHead(206, { 'Content-Range': 'bytes 1-1/99', 'Content-Length': 1 }).end('a'); return; }
    if (req.url === '/large') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/1001', 'Content-Length': 1 }).end('a'); return; }
    if (req.url === '/plain') { res.writeHead(200, { 'Content-Length': 1 }).end('a'); return; }
    res.writeHead(206, { 'Content-Range': 'bytes 0-0/99', 'Content-Length': 1 }).end('a');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`; const added = [];
  const manager = { maxBytes: 1000, add: async payload => { added.push(payload); return { id: 'queued' }; } };
  const accept = createBrowserAdmission(manager, { timeoutMs: 60, maxPending: 1, resolveTools: async () => ({ ready: true }) });
  await assert.rejects(accept({ url: `${url}/auth` }), /401/); assert.equal(added.length, 0);
  await assert.rejects(accept({ url: `${url}/html` }), /HTML|login/i); assert.equal(added.length, 0);
  assert.equal((await accept({ url: `${url}/auth`, headers: { cookie: 'session=ok' } })).id, 'queued');
  assert.equal(added[0].headers.cookie, 'session=ok');
  await assert.rejects(accept({ url: `${url}/live.m3u8`, mediaType: 'hls' }), /Live HLS/);
  await assert.rejects(accept({ url: `${url}/encoded` }), /Encoded/);
  await assert.rejects(accept({ url: `${url}/wrong-range` }), /range/);
  await assert.rejects(accept({ url: `${url}/large` }), /size limit/);
  assert.equal((await accept({ url: `${url}/plain`, mediaType: 'direct' })).id, 'queued');
  assert.equal((await accept({ url: `${url}/manifest.mpd`, mediaType: 'dash' })).id, 'queued');
  assert.equal((await accept({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mediaType: 'youtube' })).id, 'queued');
  const slow = accept({ url: `${url}/slow` });
  await assert.rejects(accept({ url: `${url}/auth` }), /busy/i); await assert.rejects(slow); assert.equal(added.length, 4);
});
