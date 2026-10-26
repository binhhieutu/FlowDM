'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

async function createCredentialFixture(t, { directBytes = 2 * 1024 ** 2, chunkDelayMs = 40, hlsDelayMs = 500 } = {}) {
  const fixtures = path.resolve(__dirname, '../../fixtures/video');
  const video = await fs.readFile(path.join(fixtures, 'direct.mp4'));
  assert.ok(directBytes > video.length + 8);
  const padding = Buffer.alloc(directBytes - video.length); padding.writeUInt32BE(padding.length, 0); padding.write('free', 4);
  const body = Buffer.concat([video, padding]);
  const resourceNames = ['segment00.ts', 'segment01.ts', 'segment02.ts'];
  const resources = new Map(await Promise.all(resourceNames.map(async name => [name, await fs.readFile(path.join(fixtures, name))])));
  const playlist = await fs.readFile(path.join(fixtures, 'list.m3u8'));
  const hlsBody = Buffer.concat(resourceNames.map(name => resources.get(name)));
  const requests = [], secrets = []; let phase = 'initial';
  const cookieName = 'flowdm_fixture_session'; let cookieValue;
  function rotateCookie(value = crypto.randomBytes(16).toString('hex')) {
    assert.match(value, /^[A-Za-z0-9_-]{1,64}$/); cookieValue = value; secrets.push(value); return value;
  }
  rotateCookie(); let otherOrigin;
  function log(req, pathname, accepted) {
    const entry = { path: pathname, method: req.method, range: req.headers.range || null, cookiePresent: !!req.headers.cookie, cookieAccepted: accepted, completed: false, phase };
    requests.push(entry); return entry;
  }
  function sendBody(req, res, data, entry, { attachment = true, slow = true, etag = '"credential-fixture-video"' } = {}) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    if (start > end || start >= data.length) return res.writeHead(416).end();
    Object.assign(entry, { start, end, probe: start === 0 && end === 0 });
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, ETag: etag, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}), ...(attachment ? { 'Content-Disposition': 'attachment; filename="auth-video.mp4"' } : {}) });
    res.once('finish', () => { entry.completed = true; });
    if (!slow || entry.probe) return res.end(data.subarray(start, end + 1));
    let offset = start;
    const timer = setInterval(() => { const next = Math.min(end + 1, offset + 16384); res.write(data.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); res.end(); } }, chunkDelayMs);
    res.once('close', () => clearInterval(timer));
  }
  const foreign = http.createServer((req, res) => { const entry = log(req, '/foreign' + new URL(req.url, 'http://fixture').pathname, false); sendBody(req, res, body, entry, { slow: false, etag: '"foreign"' }); });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/' || pathname === '/login') {
      if (pathname === '/login') res.setHeader('Set-Cookie', `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Credential rebind fixture</title><h1>Private browser test</h1><a id="auth" href="/auth.bin" download>Authenticated video</a><a id="fallback" href="/fallback.bin" download>Fallback video</a><button id="load-hls" onclick="fetch(\'/hls/list.m3u8\')">Observe HLS</button>'); return;
    }
    if (pathname === '/redirect') { log(req, pathname, false); res.writeHead(302, { Location: otherOrigin + '/foreign.bin' }).end(); return; }
    const accepted = (req.headers.cookie || '').split(/;\s*/).includes(`${cookieName}=${cookieValue}`);
    const entry = log(req, pathname, accepted);
    if (pathname !== '/fallback.bin' && !accepted) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Login required'); return; }
    if (pathname === '/auth.bin' || pathname === '/fallback.bin') return sendBody(req, res, body, entry);
    if (pathname === '/hls/list.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': playlist.length }); res.once('finish', () => { entry.completed = true; }); res.end(playlist); return; }
    const name = pathname.startsWith('/hls/') ? pathname.slice(5) : '';
    if (!resources.has(name)) return res.writeHead(404).end();
    const data = resources.get(name); res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length });
    res.once('finish', () => { entry.completed = true; }); const timer = setTimeout(() => res.end(data), hlsDelayMs); res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve)); otherOrigin = `http://127.0.0.1:${foreign.address().port}`;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const item of [server, foreign]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); } });
  const hashes = { direct: crypto.createHash('sha256').update(body).digest('hex'), hls: crypto.createHash('sha256').update(hlsBody).digest('hex') };
  return {
    origin, otherOrigin, body, hlsBody, requests, hashes, cookieName, resourceNames,
    urls: { direct: origin + '/auth.bin', hls: origin + '/hls/list.m3u8', fallback: origin + '/fallback.bin' },
    get cookieValue() { return cookieValue; }, get secrets() { return [...secrets]; },
    rotateCookie, grantCookie: () => ({ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' }),
    mark(value) { phase = value; return requests.length; },
    assertNoSecrets(text) { assert.ok(!text.includes(cookieName), 'Cookie name leaked'); for (const value of secrets) assert.ok(!text.includes(value), 'Cookie value leaked'); },
    assertNoCommittedReplay(task, since) {
      const actual = requests.slice(since).filter(entry => entry.path === '/auth.bin' && entry.cookieAccepted && !entry.probe && entry.start !== undefined);
      assert.ok(actual.length > 0, 'No continued HTTP ranges observed');
      for (const entry of actual) for (const segment of task.segments) if (segment.received > 0) assert.ok(entry.end < segment.start || entry.start >= segment.start + segment.received, 'Committed HTTP interval requested again');
    },
    assertHlsCommittedNotReplayed(count, since) { const retained = resourceNames.slice(0, count).map(name => '/hls/' + name); assert.ok(retained.length > 0); assert.ok(!requests.slice(since).some(entry => retained.includes(entry.path)), 'Committed HLS resource requested again'); }
  };
}
module.exports = { createCredentialFixture };
