'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { assessHttpResume } = require('../../src/core/http-resume.cjs');
const { probe, contentLength } = require('../../src/core/http-client.cjs');

const metadata = () => ({ validator: { type: 'etag', value: '"revision-1"' }, total: 128, ranges: true, contentEncoding: 'identity', finalUrl: 'http://example.test/video' });
test('HTTP resume requires the same strong validator, size, range and representation', () => {
  const saved = metadata();
  assert.deepEqual(assessHttpResume({ saved, probed: metadata() }), { allowed: true, reason: null });
  assert.deepEqual(saved, metadata(), 'assessment does not mutate stored identity');
  assert.equal(assessHttpResume({ saved, probed: { ...metadata(), finalUrl: 'http://example.test/replacement?token=new' } }).allowed, true);
  for (const change of [
    { validator: null }, { validator: { type: 'modified', value: 'yesterday' } },
    { validator: { type: 'etag', value: 'W/"revision-1"' } },
    { validator: { type: 'etag', value: 'unquoted' } },
    { validator: { type: 'etag', value: '"revision-2"' } },
    { total: 129 }, { total: null }, { total: 0 }, { total: Number.MAX_SAFE_INTEGER + 1 },
    { ranges: false }, { contentEncoding: 'gzip' }, { finalUrl: 'http://other.test/video' }
  ]) {
    const result = assessHttpResume({ saved, probed: { ...metadata(), ...change } });
    assert.equal(result.allowed, false, JSON.stringify(change));
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 5);
  }
});
test('saved metadata must meet the same contract; legacy identity encoding is supported', () => {
  for (const change of [{ validator: null }, { ranges: false }, { contentEncoding: 'br' }, { total: -1 }]) {
    assert.equal(assessHttpResume({ saved: { ...metadata(), ...change }, probed: metadata() }).allowed, false);
  }
  const { total, contentEncoding, ...legacy } = metadata();
  assert.equal(assessHttpResume({ saved: { ...legacy, totalBytes: total }, probed: metadata() }).allowed, true);
  assert.equal(assessHttpResume({ saved: null, probed: null }).allowed, false);
});

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/video`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const inspect = url => probe(url, {}, new AbortController().signal, 1024);
test('probe reads the one-byte range and returns representation metadata', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.range, 'bytes=0-0');
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.writeHead(206, { 'content-range': 'bytes 0-0/128', 'content-length': '1', etag: '"revision-1"', 'content-type': 'video/mp4' });
    res.end('a');
  }, async url => {
    assert.deepEqual(await inspect(url), { finalUrl: url, ranges: true, total: 128, validator: { type: 'etag', value: '"revision-1"' }, contentEncoding: 'identity', contentType: 'video/mp4' });
  });
});
test('probe refuses malformed ranges, lengths, truncation, encodings and error statuses', async () => {
  const cases = [
    [206, { 'content-range': 'bytes 1-1/128' }, 'a'],
    [206, { 'content-range': 'bytes 0-1/128' }, 'ab'],
    [206, { 'content-range': 'bytes 0-0/0' }, 'a'],
    [206, { 'content-range': 'bytes 0-0/128', 'content-length': '2' }, 'ab'],
    [206, { 'content-range': 'bytes 0-0/128' }, 'ab'],
    [206, { 'content-range': 'bytes 0-0/128' }, ''],
    [200, { 'content-length': '1', 'content-encoding': 'gzip' }, 'a'],
    [200, { 'content-range': 'bytes 0-0/128', 'content-length': '1' }, 'a'],
    [416, { 'content-range': 'bytes */128' }, '']
  ];
  for (const [status, headers, body] of cases) {
    await withServer((req, res) => { res.writeHead(status, headers); res.end(body); }, async url => {
      await assert.rejects(inspect(url), /Content-Range|Content-Length|probe|Encoded|HTTP 416/i);
    });
  }
});
test('weak or malformed ETags never become strong validators', async () => {
  for (const etag of ['W/"revision-1"', 'revision-1']) {
    await withServer((req, res) => { res.writeHead(200, { 'content-length': '1', etag }); res.end('a'); }, async url => {
      assert.equal((await inspect(url)).validator, null);
    });
  }
});
test('probe rejects a socket closing before the declared range byte arrives', async () => {
  await withServer((req, res) => {
    res.writeHead(206, { 'content-range': 'bytes 0-0/128', 'content-length': '1' });
    res.flushHeaders();
    res.socket.end();
  }, async url => { await assert.rejects(inspect(url)); });
});
test('Content-Length parser rejects non-decimal syntax', () => {
  for (const raw of ['', '+1', '1e2', '0x10', '1.5', ['1']]) assert.throws(() => contentLength({ headers: { 'content-length': raw } }), /Invalid Content-Length/);
});
