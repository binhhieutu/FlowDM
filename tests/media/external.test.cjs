'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { downloadExternal, preflightDash, canonicalYouTubeUrl, validateMediaOutput, mediaToolEnv, aria2Arguments, createDashRelay } = require('../../src/media/external.cjs');
const { youtubeUrl } = require('../../extension/media.js');

test('invalid YouTube URLs create no scratch workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-invalid-youtube-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(downloadExternal({ url: 'https://example.com/not-youtube', mediaType: 'youtube', output: path.join(root, 'job.part'), maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath } }), /canonical/);
  assert.deepEqual(await fs.readdir(root), []);
});

async function server(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-external-'));
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, url: `http://127.0.0.1:${instance.address().port}` };
}

test('DASH preflight accepts static HTTP-only MPD and rejects DRM, live, XML entities and non-HTTP references', async t => {
  const fixture = await server(t, (req, res) => {
    const mode = new URL(req.url, 'http://local').pathname.slice(1);
    const bodies = {
      good: '<?xml version="1.0"?><MPD type="static"><Period><AdaptationSet><Representation><BaseURL>media.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>',
      drm: '<MPD type="static"><ContentProtection schemeIdUri="x"/></MPD>',
      live: '<MPD type="dynamic"></MPD>',
      entity: '<!DOCTYPE MPD [<!ENTITY x "x">]><MPD type="static">&x;</MPD>',
      file: '<MPD type="static"><BaseURL>file:///etc/passwd</BaseURL></MPD>',
      implicit: '<MPD><BaseURL>media.mp4</BaseURL></MPD>',
      cdata: '<MPD type="static"><BaseURL><![CDATA[http://127.0.0.1/private.mp4]]></BaseURL></MPD>',
      namespaced: '<MPD type="static"><x:BaseURL>file:///etc/passwd</x:BaseURL></MPD>'
    };
    res.end(bodies[mode]);
  });
  const ok = await preflightDash(`${fixture.url}/good`, {}, new AbortController().signal);
  assert.equal(ok.finalUrl, `${fixture.url}/good`);
  for (const mode of ['drm', 'live', 'entity', 'file', 'implicit', 'cdata', 'namespaced']) await assert.rejects(preflightDash(`${fixture.url}/${mode}`, {}, new AbortController().signal), /unsupported|DRM|encrypted|references|static/i);
});

test('YouTube URLs are canonicalized and arbitrary extractor URLs are rejected', () => {
  assert.equal(canonicalYouTubeUrl('https://youtu.be/AbCdEf12345?t=3'), 'https://www.youtube.com/watch?v=AbCdEf12345');
  assert.equal(canonicalYouTubeUrl('https://youtube.com/watch?v=AbCdEf12345'), 'https://www.youtube.com/watch?v=AbCdEf12345');
  assert.equal(canonicalYouTubeUrl('https://m.youtube.com/shorts/AbCdEf12345'), 'https://www.youtube.com/watch?v=AbCdEf12345');
  assert.equal(canonicalYouTubeUrl('https://www.youtube.com/watch?v=AbCdEf12345&list=abc'), 'https://www.youtube.com/watch?v=AbCdEf12345');
  assert.equal(canonicalYouTubeUrl('https://www.youtube.com/shorts/AbCdEf12345'), 'https://www.youtube.com/watch?v=AbCdEf12345');
  assert.throws(() => canonicalYouTubeUrl('https://example.com/watch?v=AbCdEf12345'), /YouTube/);
  assert.throws(() => canonicalYouTubeUrl('https://www.youtube.com/watch?v=short'), /video URL/);
});
test('extension and download core accept the same canonical YouTube host forms', () => {
  for (const value of ['https://youtube.com/watch?v=AbCdEf12345', 'https://m.youtube.com/shorts/AbCdEf12345', 'https://youtu.be/AbCdEf12345']) {
    const extensionUrl = youtubeUrl(value); assert.ok(extensionUrl);
    assert.equal(canonicalYouTubeUrl(extensionUrl), 'https://www.youtube.com/watch?v=AbCdEf12345');
  }
});
test('media child environment is a minimal executable environment without inherited application secrets', () => {
  const env = mediaToolEnv({ ytDlp: path.resolve('vendor/media-tools/yt-dlp.exe'), ffmpeg: path.resolve('vendor/media-tools/ffmpeg.exe'), jsRuntime: process.execPath });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false); assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
});

test('external downloader only accepts one through sixteen connections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-external-connections-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { url: 'https://www.youtube.com/watch?v=AbCdEf12345', mediaType: 'youtube', output: path.join(root, 'job.part'), maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath, aria2c: process.execPath } };
  for (const connections of [0, 17, 1.5, '4', null]) await assert.rejects(downloadExternal({ ...input, connections }), /connections/i);
});

test('external downloader accepts each supported connection boundary', async t => {
  const fixture = await server(t, (_req, res) => res.end('<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>'));
  const fake = path.join(fixture.root, 'accept-yt.js');
  await fs.writeFile(fake, "const fs=require('node:fs'),path=require('node:path');const i=process.argv.indexOf('-o'),out=process.argv[i+1].replace('%(ext)s','mp4');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,'muxed-video');process.stdout.write('flowdm-file:'+out);");
  const tools = { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath };
  for (const connections of [1, 2, 4, 8, 16]) {
    const output = path.join(fixture.root, `data-${connections}`, 'job.part'); await fs.mkdir(path.dirname(output), { recursive: true });
    await downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output, maxBytes: 1024, connections, tools, toolArgsPrefix: [fake], validateOutput: async () => {} });
  }
});

test('external DASH uses native fragments and YouTube HTTP uses bounded aria2c connections', async t => {
  const fixture = await server(t, (_req, res) => res.end('<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>'));
  const part = path.join(fixture.root, 'data', 'job.part'); await fs.mkdir(path.dirname(part), { recursive: true });
  const capture = path.join(fixture.root, 'argv.json');
  const fake = path.join(fixture.root, 'capture-yt.js');
  await fs.writeFile(fake, "const fs=require('node:fs'),path=require('node:path');const capture=process.argv[2],args=process.argv.slice(3),i=args.indexOf('-o'),out=args[i+1].replace('%(ext)s','mp4');fs.writeFileSync(capture,JSON.stringify(args));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,'muxed-video');process.stdout.write('flowdm-file:'+out);");
  const tools = { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath, aria2c: process.execPath };
  await downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: part, maxBytes: 1024, tools, toolArgsPrefix: [fake, capture, '--concurrent-fragments', '16'], validateOutput: async () => {} });
  const dashArgs = JSON.parse(await fs.readFile(capture, 'utf8'));
  const dashConcurrency = dashArgs.lastIndexOf('--concurrent-fragments');
  assert.equal(dashArgs[dashConcurrency + 1], '4');
  assert.ok(dashConcurrency > dashArgs.indexOf('--concurrent-fragments'));
  assert.ok(dashArgs.includes('dash,m3u8:native'));
  assert.equal(dashArgs.some(value => String(value).includes('aria2c')), false);

  await downloadExternal({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', mediaType: 'youtube', output: path.join(fixture.root, 'data', 'youtube.part'), maxBytes: 1024, connections: 8, speedLimit: 8000, tools, toolArgsPrefix: [fake, capture], validateOutput: async () => {} });
  const youtubeArgs = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.ok(youtubeArgs.includes(`http:${process.execPath}`));
  const format = youtubeArgs[youtubeArgs.indexOf('--format') + 1];
  assert.match(format, /^bv\*\[vcodec\^=avc1\]\[height<=1080\]\[protocol=m3u8_native\]\+ba\[acodec\^=mp4a\]\[ext=m4a\]\//);
  assert.match(format, /bv\*\[vcodec\^=avc1\]\[height<=1080\]\[ext=mp4\]\+ba\[acodec\^=mp4a\]\[ext=m4a\]/);
  const aria = youtubeArgs[youtubeArgs.indexOf('--downloader-args') + 1];
  assert.match(aria, /^aria2c:/);
  for (const option of ['--max-connection-per-server=8', '--split=8', '--min-split-size=1M', '--no-conf=true', '--no-netrc=true', '--max-concurrent-downloads=1', '--follow-torrent=false', '--follow-metalink=false', '--enable-rpc=false', '--enable-dht=false', '--enable-dht6=false', '--enable-peer-exchange=false', '--bt-enable-lpd=false', '--check-certificate=true', '--file-allocation=none', '--allow-overwrite=false', '--auto-file-renaming=false', '--console-log-level=warn', '--summary-interval=0', '--download-result=hide', '--max-overall-download-limit=8000']) assert.ok(aria.includes(option), option);
  const youtubeConcurrency = youtubeArgs.lastIndexOf('--concurrent-fragments');
  assert.equal(youtubeArgs[youtubeConcurrency + 1], '8');
  assert.ok(youtubeArgs.includes('dash,m3u8:native'));
  assert.equal(youtubeArgs[youtubeArgs.lastIndexOf('--limit-rate') + 1], '1000');

  await downloadExternal({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', mediaType: 'youtube', output: path.join(fixture.root, 'data', 'tiny-rate.part'), maxBytes: 1024, connections: 16, speedLimit: 1, tools, toolArgsPrefix: [fake, capture], validateOutput: async () => {} });
  const tinyRateArgs = JSON.parse(await fs.readFile(capture, 'utf8'));
  const tinyAria = tinyRateArgs[tinyRateArgs.indexOf('--downloader-args') + 1];
  assert.equal(tinyRateArgs[tinyRateArgs.lastIndexOf('--concurrent-fragments') + 1], '1');
  assert.equal(tinyRateArgs[tinyRateArgs.lastIndexOf('--limit-rate') + 1], '1');
  assert.ok(tinyAria.includes('--max-download-limit=1'));
  assert.ok(tinyAria.includes('--max-overall-download-limit=1'));

  await downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: path.join(fixture.root, 'data', 'dash-tiny-rate.part'), maxBytes: 1024, connections: 16, speedLimit: 1, tools, toolArgsPrefix: [fake, capture], validateOutput: async () => {} });
  const tinyDashArgs = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(tinyDashArgs[tinyDashArgs.lastIndexOf('--concurrent-fragments') + 1], '1');
  assert.equal(tinyDashArgs[tinyDashArgs.lastIndexOf('--limit-rate') + 1], '1');
});

test('YouTube requires aria2c while DASH does not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-external-aria-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(downloadExternal({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', mediaType: 'youtube', output: path.join(root, 'job.part'), maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath } }), /aria2c/i);
});

function runAria2(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`aria2c exited ${code}: ${stderr}`)));
  });
}

test('pinned aria2c accepts FlowDM arguments and bounds direct HTTP concurrency', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-aria2-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-aria2-')); return fs.rm(root, { recursive: true, force: true }); });
  const payload = Buffer.alloc(32 * 1024 * 1024, 0x5a);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  let active = 0; let peak = 0;
  const fixture = await server(t, (req, res) => {
    if (req.url !== '/payload.bin') return res.writeHead(404).end();
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
    if (start > end || end >= payload.length) return res.writeHead(416).end();
    active++; peak = Math.max(peak, active);
    res.writeHead(range ? 206 : 200, { 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {}) });
    let offset = start, timer;
    // Count live responses, including early client cancellation. A delayed send
    // timer can otherwise keep a closed prior request in the next run's count.
    res.once('close', () => { active--; clearTimeout(timer); });
    const send = () => {
      if (res.destroyed) return;
      if (offset > end) { res.end(); return; }
      const next = Math.min(offset + 256 * 1024, end + 1);
      res.write(payload.subarray(offset, next)); offset = next;
      timer = setTimeout(send, 8); timer.unref();
    };
    send();
  });
  const aria2c = path.resolve('vendor/media-tools/aria2c.exe');
  for (const [connections, minPeak] of [[1, 1], [4, 2]]) {
    peak = 0;
    const filename = `payload-${connections}.bin`;
    const args = [...aria2Arguments(connections, 0).slice('aria2c:'.length).split(' '), `--dir=${root}`, `--out=${filename}`, `${fixture.url}/payload.bin`];
    await runAria2(aria2c, args);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(root, filename))).digest('hex'), digest);
    if (connections === 1) assert.equal(peak, minPeak);
    else assert.equal(peak >= minPeak && peak <= connections, true, `expected 2-${connections} requests, got ${peak}`);
  }
});

function relayGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let bytes = 0; let ended = false;
      response.on('data', chunk => { bytes += chunk.length; });
      response.once('end', () => { ended = true; resolve({ status: response.statusCode, bytes, ended }); });
      response.once('aborted', () => resolve({ status: response.statusCode, bytes, ended }));
      response.once('error', error => resolve({ status: response.statusCode, bytes, ended, error }));
      response.once('close', () => { if (!ended) resolve({ status: response.statusCode, bytes, ended }); });
    });
    request.once('error', error => resolve({ status: null, bytes: 0, ended: false, error }));
  });
}

test('DASH relay enforces one shared resource budget across concurrent responses', async t => {
  const payload = Buffer.alloc(800, 0x7a);
  const fixture = await server(t, (req, res) => {
    if (!['/first.bin', '/second.bin'].includes(req.url)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': payload.length });
    res.write(payload.subarray(0, 400));
    setTimeout(() => res.end(payload.subarray(400)), 20).unref();
  });
  const relay = await createDashRelay({ finalUrl: `${fixture.url}/manifest.mpd`, manifest: Buffer.from('<MPD type="static"/>'), maxBytes: 1024 });
  t.after(() => relay.close());
  const base = new URL(relay.url);
  const [first, second] = await Promise.all([relayGet(new URL('/first.bin', base).href), relayGet(new URL('/second.bin', base).href)]);
  assert.ok(first.bytes + second.bytes <= 1024, `relay delivered ${first.bytes + second.bytes} bytes despite a 1024-byte shared cap`);
  assert.equal(first.status === 200 && second.status === 200 && first.ended && second.ended, false);
});

test('pinned yt-dlp downloads DASH fragments at the requested native concurrency', async t => {
  const videoDir = path.resolve('tests/fixtures/video');
  const files = Object.fromEntries(await Promise.all(['init.mp4', 'fragment00.m4s', 'fragment01.m4s', 'fragment02.m4s'].map(async name => [name, await fs.readFile(path.join(videoDir, name))])));
  const mpd = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT3S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-main:2011"><Period duration="PT3S"><AdaptationSet mimeType="video/mp4" segmentAlignment="true"><Representation id="muxed" bandwidth="200000" codecs="avc1.64000a" width="320" height="240"><SegmentList timescale="1000000" duration="1000000"><Initialization sourceURL="init.mp4"/><SegmentURL media="fragment00.m4s"/><SegmentURL media="fragment01.m4s"/><SegmentURL media="fragment02.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>';
  let active = 0; let peak = 0;
  const fixture = await server(t, (req, res) => {
    const name = new URL(req.url, 'http://local').pathname.slice(1);
    if (name === 'manifest.mpd') return res.end(mpd);
    if (!Object.hasOwn(files, name)) return res.writeHead(404).end();
    if (!name.startsWith('fragment')) return res.end(files[name]);
    active++; peak = Math.max(peak, active);
    setTimeout(() => { res.end(files[name]); active--; }, 150).unref();
  });
  const tools = { ytDlp: path.resolve('vendor/media-tools/yt-dlp.exe'), ffmpeg: path.resolve('vendor/media-tools/ffmpeg.exe'), jsRuntime: process.execPath };
  for (const [connections, expectedPeak] of [[1, 1], [4, 2]]) {
    peak = 0;
    const output = path.join(fixture.root, `dash-${connections}.mp4`);
    const result = await downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output, maxBytes: 10 * 1024 * 1024, connections, tools, timeoutMs: 30000 });
    assert.ok(result.bytes > 0);
    if (connections === 1) assert.equal(peak, expectedPeak, `expected one serial fragment request, got ${peak}`);
    else assert.equal(peak >= expectedPeak, true, `expected ${connections} connections to reach ${expectedPeak}, got ${peak}`);
  }
});

test('external downloader only publishes finished mux output, reports bytes and never accepts credential headers', async t => {
  const fixture = await server(t, (_req, res) => res.end('<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>'));
  const part = path.join(fixture.root, 'data', 'job.part'); await fs.mkdir(path.dirname(part), { recursive: true });
  const fake = path.join(fixture.root, 'fake-yt.js');
  await fs.writeFile(fake, "const fs=require('node:fs'),path=require('node:path'); const i=process.argv.indexOf('-o'); const out=process.argv[i+1].replace('%(ext)s','mp4'); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,'muxed-video'); process.stdout.write('flowdm-file:'+out);");
  const progress = [];
  const result = await downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: part, signal: new AbortController().signal, maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath }, toolArgsPrefix: [fake], validateOutput: async () => {}, onProgress: value => progress.push(value) });
  assert.equal(result.bytes, 11); assert.equal(await fs.readFile(part, 'utf8'), 'muxed-video'); assert.ok(progress.at(-1).downloadedBytes === 11);
  await assert.rejects(downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: part, headers: { 'User-Agent': 'browser' }, signal: new AbortController().signal, maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath }, toolArgsPrefix: [fake] }), /browser headers/i);
});

test('external downloader abort kills a slow child and leaves no published partial', async t => {
  const fixture = await server(t, (_req, res) => res.end('<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>'));
  const part = path.join(fixture.root, 'data', 'job.part'); await fs.mkdir(path.dirname(part), { recursive: true });
  const fake = path.join(fixture.root, 'slow-yt.js');
  await fs.writeFile(fake, "setTimeout(()=>{}, 10000)");
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50).unref();
  await assert.rejects(downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: part, signal: controller.signal, maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath }, toolArgsPrefix: [fake] }), /Aborted/);
  await assert.rejects(fs.stat(part), { code: 'ENOENT' });
});
test('external downloader rejects oversized scratch output before publication', async t => {
  const fixture = await server(t, (_req, res) => res.end('<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>'));
  const part = path.join(fixture.root, 'data', 'job.part'); await fs.mkdir(path.dirname(part), { recursive: true });
  const fake = path.join(fixture.root, 'large-yt.js');
  await fs.writeFile(fake, "const fs=require('node:fs'),path=require('node:path'); const i=process.argv.indexOf('-o'); const out=process.argv[i+1].replace('%(ext)s','mp4'); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,Buffer.alloc(2048)); process.stdout.write('flowdm-file:'+out);");
  await assert.rejects(downloadExternal({ url: `${fixture.url}/manifest.mpd`, mediaType: 'dash', output: part, signal: new AbortController().signal, maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath }, toolArgsPrefix: [fake] }), /invalid output/);
  await assert.rejects(fs.stat(part), { code: 'ENOENT' });
});
test('DASH tool receives a loopback relay bound to the preflighted manifest bytes', async t => {
  let manifestRequests = 0;
  const fixture = await server(t, (req, res) => {
    if (req.url === '/locked.mpd') { manifestRequests++; return res.end(manifestRequests === 1 ? '<MPD type="static"><BaseURL>media.mp4</BaseURL></MPD>' : '<MPD type="static"><ContentProtection/></MPD>'); }
    res.end('media');
  });
  const part = path.join(fixture.root, 'data', 'job.part'); await fs.mkdir(path.dirname(part), { recursive: true });
  const fake = path.join(fixture.root, 'relay-yt.js');
  await fs.writeFile(fake, "const fs=require('node:fs'),path=require('node:path'),http=require('node:http'); const i=process.argv.indexOf('-o'),out=process.argv[i+1].replace('%(ext)s','mp4'); let u=''; process.stdin.on('data',x=>u+=x).on('end',()=>http.get(u.trim(),r=>{let b='';r.on('data',x=>b+=x).on('end',()=>{if(!/BaseURL/.test(b))process.exit(9);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,'muxed-video');process.stdout.write('flowdm-file:'+out)})}));");
  await downloadExternal({ url: `${fixture.url}/locked.mpd`, mediaType: 'dash', output: part, signal: new AbortController().signal, maxBytes: 1024, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath }, toolArgsPrefix: [fake], validateOutput: async () => {} });
  assert.equal(manifestRequests, 1); assert.equal(await fs.readFile(part, 'utf8'), 'muxed-video');
});
test('FFmpeg validation rejects non-media output before it can be published', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-invalid-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'not-video.mp4'); await fs.writeFile(filename, 'not an MP4');
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [path.resolve('vendor/media-tools', name), ...(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name))];
  let ffmpeg; for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) { ffmpeg = candidate; break; } } catch {} }
  assert.ok(ffmpeg, 'FFmpeg is required by the media validation integration test');
  await assert.rejects(validateMediaOutput(filename, ffmpeg, new AbortController().signal), /valid MP4/);
});
