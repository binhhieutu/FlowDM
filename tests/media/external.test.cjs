'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { downloadExternal, preflightDash, canonicalYouTubeUrl, validateMediaOutput, mediaToolEnv } = require('../../src/media/external.cjs');
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
