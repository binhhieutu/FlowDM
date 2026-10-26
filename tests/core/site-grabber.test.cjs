'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { crawlLinks } = require('../../src/core/site-grabber.cjs');
async function fixture(t, handler) {
  const requests = []; let active = 0, peak = 0;
  const server = http.createServer((req, res) => { requests.push(req.url); active++; peak = Math.max(peak, active); res.once('close', () => active--); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, get peak() { return peak; }, origin: 'http://127.0.0.1:' + server.address().port };
}
async function collect(options) { const records = []; for await (const record of crawlLinks(options)) records.push(record); return records; }
function html(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }
test('crawler discovers bounded same-origin anchors, deduplicates loops and does not execute scripts or fetch files', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/') return html(res, `<a href="/page">Next</a><a href="/tệp.zip?x=1&amp;y=2#one">Tệp &amp; file</a><a href="/tệp.zip?x=1&amp;y=2#two">Duplicate</a><a href="javascript:alert(1)">bad</a><a href="https://example.org/out">off</a><script>fetch('/evil'); '<a href="/fake">fake</a>'</script><!-- <a href='/comment'>bad</a> -->`);
    if (req.url === '/page') return html(res, '<a href="/">Loop</a><a href="/two">Two</a>');
    return html(res, '<a href="/three">Three</a>');
  });
  const records = await collect({ seed: f.origin, maxDepth: 1 });
  const links = records.flatMap(record => record.links);
  assert.deepEqual(f.requests, ['/', '/page']); assert.equal(f.peak, 1);
  assert.ok(links.some(link => link.url === f.origin + '/t%E1%BB%87p.zip?x=1&y=2' && link.text === 'Tệp & file'));
  assert.ok(links.some(link => link.url === f.origin + '/two'));
  assert.ok(links.every(link => new URL(link.url).origin === f.origin));
  assert.ok(links.every(link => !/fake|comment|evil/.test(link.url)));
});
test('HTML lexical extraction handles base, quote delimiters, numeric entities and raw-text contexts safely', async t => {
  const f = await fixture(t, (_req, res) => html(res, `<base href='/folder/'><a data-title='>' HREF="fi&#108;e.zip?x=1&amp;y=2"><b>Report</b></a><a href=plain.zip>Plain</a><textarea><a href='/fake'>fake</a></textarea><template><a href='/template'>fake</a></template><a href='&unknown;.zip'>skip</a><a href='/long.zip'>${'x'.repeat(300)}</a>`));
  const records = await collect({ seed: f.origin, maxDepth: 0 });
  const links = records[0].links;
  assert.ok(links.some(link => link.url === f.origin + '/folder/file.zip?x=1&y=2' && link.text === 'Report'));
  assert.ok(links.some(link => link.url === f.origin + '/folder/plain.zip'));
  assert.ok(links.every(link => link.text.length <= 180));
  assert.ok(links.every(link => !/fake|template|unknown/.test(link.url)));
});
test('crawler checks redirect origin before following', async t => {
  const other = await fixture(t, (_req, res) => html(res, 'must never request'));
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: other.origin + '/private' }); res.end(); });
  const records = await collect({ seed: f.origin });
  assert.match(records[0].error, /origin|redirect/i); assert.deepEqual(other.requests, []);
});
test('same-origin redirects consume request budget and redirect cycles terminate', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(302, { Location: req.url === '/' ? '/next' : '/' }); res.end(); });
  const records = await collect({ seed: f.origin, maxPages: 3 });
  assert.ok(f.requests.length <= 3); assert.match(records[0].error, /redirect|visited|budget|limit/i);
});
test('crawler reports protected pages, login forms, non-HTML and encoded responses without consuming bodies', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/401') { res.writeHead(401); return res.end('private'); }
    if (req.url === '/login') return html(res, '<form><input type=password><a href="/secret">hidden</a></form>');
    if (req.url === '/encoded') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); return res.end('not gzip'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('bytes');
  });
  for (const pathname of ['/401', '/login', '/encoded', '/binary']) {
    const rows = await collect({ seed: f.origin + pathname }); assert.ok(rows[0].error); assert.deepEqual(rows[0].links, []);
  }
});
test('crawler refuses unsupported settings and bounds pages, link count, text and total result bytes', async t => {
  const f = await fixture(t, (req, res) => html(res, Array.from({ length: 1100 }, (_, index) => `<a href='/page${index}'>${index}</a>`).join('')));
  for (const options of [{ maxDepth: 3 }, { maxPages: 101 }, { maxDepth: -1 }, { maxPages: 0 }, { seed: 'file:///private' }]) await assert.rejects(collect({ seed: f.origin, ...options }));
  const records = await collect({ seed: f.origin, maxPages: 2 });
  assert.ok(records.flatMap(row => row.links).length <= 1000); assert.ok(f.requests.length <= 2);
});
test('crawler rejects oversized HTML and cancellation destroys live requests without further discovery', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 2 * 1024 * 1024 + 1 }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html>');
  });
  assert.match((await collect({ seed: f.origin + '/big' }))[0].error, /size|large|limit/i);
  const controller = new AbortController(); const pending = collect({ seed: f.origin, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 40)); controller.abort();
  await assert.rejects(pending, /abort|cancel/i);
  const already = new AbortController(); already.abort(); await assert.rejects(collect({ seed: f.origin, signal: already.signal }), /abort|cancel/i);
});
test('crawler maxDepth two and maxPages bound an infinite same-origin navigation chain', async t => {
  const f = await fixture(t, (req, res) => { const page = Number(req.url.slice(1)) || 0; html(res, `<a href='/${page + 1}'>Next</a>`); });
  const depth = await collect({ seed: f.origin, maxDepth: 2 });
  assert.deepEqual(depth.map(row => row.depth), [0, 1, 2]); assert.equal(f.requests.length, 3);
  f.requests.length = 0;
  const pages = await collect({ seed: f.origin, maxPages: 1 }); assert.equal(pages.length, 1); assert.equal(f.requests.length, 1);
});
test('same-origin redirect resolves final-page links while external base cannot rewrite candidates onto the seed', async t => {
  let origin;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/') { res.writeHead(302, { Location: '/folder/page.html' }); return res.end(); }
    html(res, `<base href='https://example.org/out/'><a href='wrong.zip'>skip</a><a href='${origin}/safe.zip'>Safe</a>`);
  }); origin = f.origin;
  const rows = await collect({ seed: f.origin, maxDepth: 0 });
  assert.deepEqual(f.requests, ['/', '/folder/page.html']); assert.equal(rows[0].url, f.origin + '/folder/page.html');
  assert.deepEqual(rows[0].links, [{ url: f.origin + '/safe.zip', text: 'Safe' }]);
});
test('crawler bounds unknown-length HTML streams and aggregate canonical URL bytes', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/chunked') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('x'.repeat(1024 * 1024)); return res.end('y'.repeat(1024 * 1024 + 1)); }
    html(res, Array.from({ length: 1000 }, (_, index) => `<a href='/${'x'.repeat(3000)}${index}.zip'>File</a>`).join(''));
  });
  assert.match((await collect({ seed: f.origin + '/chunked' }))[0].error, /size|large|limit/i);
  // Keep each HTML page under 2 MiB while exceeding the aggregate URL budget.
  const small = await fixture(t, (_req, res) => html(res, Array.from({ length: 250 }, (_, index) => `<a href='/${'x'.repeat(3000)}${index}.zip'>File</a>`).join('')));
  const urls = (await collect({ seed: small.origin, maxDepth: 0 })).flatMap(row => row.links.map(link => link.url));
  assert.ok(urls.length > 0 && urls.length < 250); assert.ok(Buffer.byteLength(urls.join('\n')) <= 512 * 1024);
});
test('crawler handles missing redirects, bad settings and unsupported seeds without exposing credentials', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302); res.end(); });
  assert.match((await collect({ seed: f.origin }))[0].error, /redirect|location/i);
  for (const options of [null, { seed: f.origin, unexpected: true }, { seed: f.origin, signal: null }, { seed: 'http://name:secret@example.com/' }]) await assert.rejects(collect(options));
});
test('crawler terminates a silent page at its real ten second deadline', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html>'); });
  const started = Date.now(), rows = await collect({ seed: f.origin });
  assert.match(rows[0].error, /timed out/i); assert.ok(Date.now() - started >= 9900); assert.ok(Date.now() - started < 14000);
});
test('HTML anchor extraction preserves bare query ampersands and ambiguous entity-like parameter names', async t => {
  const f = await fixture(t, (_req, res) => html(res, `<a href='/file.zip?x=1&y=2'>Query</a><a href='/file.zip?q=1&amp=2'>Ambiguous</a>`));
  const links = (await collect({ seed: f.origin, maxDepth: 0 }))[0].links;
  assert.deepEqual(links.map(link => link.url), [f.origin + '/file.zip?x=1&y=2', f.origin + '/file.zip?q=1&amp=2']);
});
test('crawler refuses unsupported charset or invalid UTF8 instead of returning altered URL bytes', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': req.url === '/latin' ? 'text/html; charset=iso-8859-1' : 'text/html' });
    res.end(Buffer.concat([Buffer.from('<a href="/caf'), Buffer.from([0xe9]), Buffer.from('.zip">File</a>')]));
  });
  for (const path of ['/latin', '/invalid']) {
    const rows = await collect({ seed: f.origin + path }); assert.ok(rows[0].error); assert.deepEqual(rows[0].links, []);
  }
});
test('crawler follows common dynamic HTML page extensions while leaving binary and unknown extensions for preview', async t => {
  const pages = ['next.php', 'next.php8', 'next.asp', 'next.aspx', 'next.jsp', 'next.cgi', 'next.cfm'];
  const f = await fixture(t, (req, res) => {
    if (req.url === '/') return html(res, [...pages, 'payload.zip', 'other.unknown'].map(name => `<a href='/${name}'>${name}</a>`).join(''));
    html(res, `<a href='/from-${req.url.slice(1)}.zip'>Payload</a>`);
  });
  const rows = await collect({ seed: f.origin, maxDepth: 1 });
  assert.deepEqual(f.requests, ['/', ...pages.map(name => '/' + name)]);
  assert.equal(rows.length, pages.length + 1);
  for (const name of pages) assert.ok(rows.flatMap(row => row.links).some(link => link.url === f.origin + '/from-' + name + '.zip'));
  assert.ok(!f.requests.includes('/payload.zip')); assert.ok(!f.requests.includes('/other.unknown'));
});
