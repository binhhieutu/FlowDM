'use strict';
const { resolveTools } = require('../../src/tools/media-tools.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { downloadExternal, validateExternalReplacement } = require('../../src/media/external.cjs');
const cache = require('../../src/media/external-checkpoint.cjs');
const { hlsIdentity, pinHlsMetadata } = require('../../src/media/external-metadata.cjs');

async function privateDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-native-checkpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('native checkpoint reconciliation trims append bytes past committed index without refetch', async t => {
  const root = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.mp4.part-Frag1'), 'init');
  await fs.writeFile(path.join(root, 'media.mp4.part-Frag2'), 'video');
  await fs.writeFile(path.join(root, 'media.mp4.part-Frag3.part'), 'unfinished');
  await fs.writeFile(path.join(root, 'media.mp4.part'), 'initvideouncommitted');
  await fs.writeFile(path.join(root, 'media.mp4.ytdl'), JSON.stringify({ downloader: { current_fragment: { index: 2 } } }));
  await cache.reconcileNative(root, 1024);
  assert.equal(await fs.readFile(path.join(root, 'media.mp4.part'), 'utf8'), 'initvideo');
  await assert.rejects(fs.stat(path.join(root, 'media.mp4.part-Frag3.part')), { code: 'ENOENT' });
  assert.deepEqual(await cache.resumableProgress(root), { downloadedBytes: 9, completedResources: 2 });
  await cache.snapshot(root, { sourceHash: 'source', identity: 'identity' }, 1024);
  assert.ok(await cache.readState(root, 'source', 1024));
  await fs.unlink(path.join(root, 'media.mp4.part-Frag1'));
  await assert.rejects(cache.reconcileNative(root, 1024), /incomplete/);
});

test('checkpoint refuses missing state, missing files, changed source and unsafe entries', async t => {
  const root = await privateDirectory(t);
  assert.equal(await cache.readState(root, 'source', 1024), null);
  await fs.writeFile(path.join(root, 'media.mp4.part'), 'bytes');
  await assert.rejects(cache.readState(root, 'source', 1024), /state missing/);
  await cache.snapshot(root, { sourceHash: 'source', identity: 'identity' }, 1024);
  await assert.rejects(cache.readState(root, 'other', 1024), /source|integrity/);
  await fs.mkdir(path.join(root, 'media.directory'));
  await assert.rejects(cache.readState(root, 'source', 1024), /unsafe/);
  await fs.rmdir(path.join(root, 'media.directory'));
  await fs.unlink(path.join(root, 'media.mp4.part'));
  await assert.rejects(cache.readState(root, 'source', 1024), /integrity/);
});

test('unfinished unvalidated HTTP resource restarts alone while completed native video remains', async t => {
  const root = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.f312.mp4'), 'complete-video');
  await fs.writeFile(path.join(root, 'media.f258.m4a.part'), 'incomplete-audio');
  await fs.writeFile(path.join(root, 'media.f258.m4a.part.aria2'), 'control');
  await cache.discardUnsafeHttpPartials(root);
  assert.deepEqual(await fs.readdir(root), ['media.f312.mp4']);
});

test('unvalidated HTTP video partial is retained and continuation is refused', async t => {
  const root = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.f299.mp4.part'), 'valuable-video-bytes');
  await fs.writeFile(path.join(root, 'media.f299.mp4.part.aria2'), 'control');
  await assert.rejects(cache.discardUnsafeHttpPartials(root), /cannot safely continue|unsupported continuation/i);
  assert.equal(await fs.readFile(path.join(root, 'media.f299.mp4.part'), 'utf8'), 'valuable-video-bytes');
  assert.equal(await fs.readFile(path.join(root, 'media.f299.mp4.part.aria2'), 'utf8'), 'control');
});

test('unfinished HTTP audio without completed video is retained and continuation is refused', async t => {
  const root = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.f258.m4a.part'), 'valuable-audio-bytes');
  await assert.rejects(cache.discardUnsafeHttpPartials(root), /cannot safely continue|unsupported continuation/i);
  assert.equal(await fs.readFile(path.join(root, 'media.f258.m4a.part'), 'utf8'), 'valuable-audio-bytes');
});

test('external identity pins format selection and manifest but contains no signed URL', () => {
  const first = { id: 'public-video', duration: 3, requested_formats: [{ format_id: '312', protocol: 'm3u8_native', url: 'https://video.example/private?signature=one', vcodec: 'avc1', width: 1920 }] };
  const changedToken = { ...first, requested_formats: first.requested_formats.map(format => ({ ...format, url: 'https://video.example/private?signature=two' })) };
  assert.equal(cache.identity(first), cache.identity(changedToken));
  assert.notEqual(cache.identity(first), cache.identity({ ...first, duration: 4 }));
  assert.notEqual(cache.identity(first), cache.identity({ ...first, requested_formats: [{ ...first.requested_formats[0], format_id: '299' }] }));
  assert.notEqual(cache.identity(first, Buffer.from('a')), cache.identity(first, Buffer.from('b')));
});

test('YouTube HLS identity ignores refreshed signatures but pins fragment boundaries and order', () => {
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:5.0,\nhttps://video.test/expire/1/sq/0?sig=one\n#EXTINF:3.0,\nhttps://video.test/expire/1/sq/1?sig=one\n#EXT-X-ENDLIST\n';
  assert.equal(hlsIdentity(playlist), hlsIdentity(playlist.replaceAll('expire/1', 'expire/2').replaceAll('sig=one', 'sig=two')));
  assert.notEqual(hlsIdentity(playlist), hlsIdentity(playlist.replace('#EXTINF:3.0', '#EXTINF:4.0')));
  assert.notEqual(hlsIdentity(playlist), hlsIdentity(playlist.replace('/sq/1?', '/sq/2?')));
  assert.throws(() => hlsIdentity(playlist.replace('#EXT-X-ENDLIST', '')), /finite|VOD/);
  assert.throws(() => hlsIdentity(playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"')), /Encrypted/);
});

test('YouTube identity preflight bounds manifests and does not forward credential headers', async t => {
  let mode = 'good'; let received;
  const server = http.createServer((req, res) => {
    received = req.headers;
    if (mode === 'status') return res.writeHead(404).end();
    if (mode === 'length') return res.writeHead(200, { 'content-length': 2 * 1024 * 1024 }).end();
    if (mode === 'chunked') return res.end(Buffer.alloc(1024 * 1024 + 1, 'x'));
    res.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3.0,\nhttps://video.test/sq/0\n#EXT-X-ENDLIST\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const info = { requested_formats: [{ format_id: '312', protocol: 'm3u8_native', url: `http://127.0.0.1:${server.address().port}/playlist.m3u8`, http_headers: { 'User-Agent': 'FlowDM-test', Cookie: 'secret', Authorization: 'secret' } }] };
  assert.match(await pinHlsMetadata(info), /^[a-f0-9]{64}$/);
  assert.equal(received['user-agent'], 'FlowDM-test'); assert.equal(received.cookie, undefined); assert.equal(received.authorization, undefined);
  for (mode of ['status', 'length', 'chunked']) await assert.rejects(pinHlsMetadata(info), /unavailable|oversized|limit/);
});

test('checkpoint rejects invalid native journal and aggregate oversized cache', async t => {
  const root = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.mp4.ytdl'), '{');
  await assert.rejects(cache.reconcileNative(root, 1024), /corrupt/);
  await fs.writeFile(path.join(root, 'media.mp4.ytdl'), JSON.stringify({ downloader: { current_fragment: { index: -1 } } }));
  await assert.rejects(cache.reconcileNative(root, 1024), /invalid/);
  await fs.unlink(path.join(root, 'media.mp4.ytdl'));
  await fs.writeFile(path.join(root, 'media.one'), Buffer.alloc(800));
  await fs.writeFile(path.join(root, 'media.two'), Buffer.alloc(800));
  await assert.rejects(cache.snapshot(root, { sourceHash: 'source', identity: 'identity' }, 1024), /size limit/);
  await assert.rejects(cache.readState('relative', 'source', 1024), /absolute/);
});

test('checkpoint refuses hard-linked cached files and metadata', async t => {
  const root = await privateDirectory(t);
  const sibling = await privateDirectory(t);
  await fs.writeFile(path.join(root, 'media.mp4.part'), 'bytes');
  await cache.snapshot(root, { sourceHash: 'source', identity: 'identity' }, 1024);
  await fs.link(path.join(root, 'media.mp4.part'), path.join(sibling, 'alias'));
  await assert.rejects(cache.readState(root, 'source', 1024), /unsafe|integrity/);
  await fs.unlink(path.join(sibling, 'alias'));
  await fs.link(path.join(root, 'checkpoint.json'), path.join(sibling, 'state-alias'));
  await assert.rejects(cache.readState(root, 'source', 1024), /unsafe|integrity/);
});

test('aborting from initial cached-progress notification never starts a transfer child', async t => {
  const root = await privateDirectory(t);
  const marker = path.join(root, 'transfer-started');
  const fake = path.join(root, 'metadata-tool.cjs');
  await fs.writeFile(fake, `const fs=require('node:fs'); if(process.argv.includes('--dump-single-json')) process.stdout.write(JSON.stringify({id:'AbCdEf12345',duration:3,format_id:'18',protocol:'https',ext:'mp4'})); else {fs.writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},10000);}`);
  const controller = new AbortController();
  await assert.rejects(downloadExternal({ url: 'https://www.youtube.com/watch?v=AbCdEf12345', mediaType: 'youtube', output: path.join(root, 'video.mp4'), checkpointDir: path.join(root, 'cache'), maxBytes: 1024, signal: controller.signal, tools: { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath, aria2c: process.execPath }, toolArgsPrefix: [fake], onProgress: () => controller.abort(), timeoutMs: 1000 }), /Aborted/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('native tool DASH resumes retained fragments after child exit and a fresh invocation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-dash-resume-'));
  const names = ['init.mp4', 'fragment00.m4s', 'fragment01.m4s', 'fragment02.m4s'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.resolve('tests/fixtures/video', name))])));
  const requests = {};
  let changed = false;
  const mpd = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT3S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-main:2011"><Period duration="PT3S"><AdaptationSet mimeType="video/mp4" segmentAlignment="true"><Representation id="muxed" bandwidth="200000" codecs="avc1.64000a" width="320" height="240"><SegmentList timescale="1000000" duration="1000000"><Initialization sourceURL="init.mp4"/><SegmentURL media="fragment00.m4s"/><SegmentURL media="fragment01.m4s"/><SegmentURL media="fragment02.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>';
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://local').pathname.slice(1);
    if (name === 'manifest.mpd') return res.end(changed ? mpd.replace('200000', '200001') : mpd);
    if (!files[name]) return res.writeHead(404).end();
    requests[name] = (requests[name] || 0) + 1;
    const timer = setTimeout(() => res.end(files[name]), name === 'init.mp4' ? 0 : 250);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const tools = await resolveTools({ packaged: false });
  const input = { url: `http://127.0.0.1:${server.address().port}/manifest.mpd`, mediaType: 'dash', output: path.join(root, 'video.mp4'), checkpointDir: path.join(root, 'checkpoint'), maxBytes: 10 * 1024 * 1024, connections: 1, tools, timeoutMs: 30000 };
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(downloadExternal({ ...input, signal: controller.signal, onProgress: p => { progress.push(p); if (p.completedResources >= 2) controller.abort(); } }), /Aborted/);
  await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
  const before = { ...requests };
  assert.equal(before['init.mp4'], 1);
  assert.equal(before['fragment00.m4s'], 1);
  const checkpoint = JSON.parse(await fs.readFile(path.join(input.checkpointDir, 'checkpoint.json'), 'utf8'));
  assert.ok(checkpoint.files.length > 0);
  assert.ok(progress.at(-1).downloadedBytes > 0);
  const cacheBeforeRefresh = await fs.readFile(path.join(input.checkpointDir, 'checkpoint.json'));
  changed = true;
  await assert.rejects(validateExternalReplacement({ ...input, url: `${input.url}?token=new`, checkpointSourceUrl: input.url }), /identity|changed/i);
  assert.deepEqual(await fs.readFile(path.join(input.checkpointDir, 'checkpoint.json')), cacheBeforeRefresh);
  await assert.rejects(downloadExternal(input), /identity|changed/i);
  assert.deepEqual(requests, before);
  changed = false;
  const reusable = checkpoint.files.find(file => /\.part$/.test(file.name));
  assert.ok(reusable, 'native partial retained');
  const filename = path.join(input.checkpointDir, reusable.name);
  const bytes = await fs.readFile(filename); const damaged = Buffer.from(bytes); damaged[0] ^= 1;
  await fs.writeFile(filename, damaged);
  await assert.rejects(downloadExternal(input), /integrity|corrupt/i);
  await fs.writeFile(filename, bytes);
  const replacementUrl = `${input.url}?token=new`;
  const replacement = await validateExternalReplacement({ ...input, url: replacementUrl, checkpointSourceUrl: input.url });
  assert.deepEqual(await fs.readFile(path.join(input.checkpointDir, 'checkpoint.json')), cacheBeforeRefresh);
  assert.deepEqual(requests, before, 'preflight never requests already committed media resources');
  const result = await downloadExternal({ ...input, url: replacementUrl, checkpointSourceHash: replacement.checkpointSourceHash });
  assert.equal(requests['init.mp4'], before['init.mp4']);
  assert.equal(requests['fragment00.m4s'], before['fragment00.m4s']);
  assert.ok(result.metadata.reusedResources >= 2);
  assert.ok(result.metadata.reusedBytes > 0);
  assert.ok(result.bytes > 0);
});
