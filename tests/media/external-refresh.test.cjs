'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateExternalReplacement, downloadExternal } = require('../../src/media/external.cjs');
const cache = require('../../src/media/external-checkpoint.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-refresh-external-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkpointDir = path.join(root, 'cache'); await fs.mkdir(checkpointDir);
  const info = { id: 'AbCdEf12345', duration: 3, format_id: '18', protocol: 'https', ext: 'mp4' };
  const script = path.join(root, 'metadata.cjs');
  await fs.writeFile(script, `process.stdout.write(JSON.stringify(${JSON.stringify(info)}));`);
  await fs.writeFile(path.join(checkpointDir, 'media.mp4.part'), 'valuable');
  const source = 'https://www.youtube.com/watch?v=AbCdEf12345';
  await cache.snapshot(checkpointDir, { sourceHash: cache.hash(source), identity: cache.identity({ ...info, flowdm_hls_identity: cache.hash('[]') }) }, 1024);
  const tools = { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath, aria2c: process.execPath };
  return { root, checkpointDir, info, script, source, tools, input: { url: source, mediaType: 'youtube', checkpointDir, maxBytes: 1024, tools, toolArgsPrefix: [script] } };
}
async function contents(directory) { return Promise.all((await fs.readdir(directory)).sort().map(async name => [name, (await fs.readFile(path.join(directory, name))).toString('hex')])); }

test('YouTube refresh validates canonical identity without changing cache or deleting HTTP bytes', async t => {
  const { input, checkpointDir, source } = await setup(t); const before = await contents(checkpointDir);
  const value = await validateExternalReplacement({ ...input, url: 'https://youtu.be/AbCdEf12345', checkpointSourceUrl: source });
  assert.deepEqual(value, { compatible: true, checkpointSourceHash: cache.hash(source) });
  assert.deepEqual(await contents(checkpointDir), before);
  await assert.rejects(downloadExternal({ ...input, output: path.join(path.dirname(checkpointDir), 'video.mp4'), checkpointSourceHash: value.checkpointSourceHash }), /cannot safely continue/i);
  assert.deepEqual(await contents(checkpointDir), before);
});

test('refresh rejects different canonical video and metadata drift while preserving every file', async t => {
  const { input, script, info, checkpointDir, source } = await setup(t); const before = await contents(checkpointDir);
  await assert.rejects(validateExternalReplacement({ ...input, url: 'https://youtu.be/ZyXwVu98765', checkpointSourceUrl: source }), /identity|source|video/i);
  await fs.writeFile(script, `process.stdout.write(JSON.stringify(${JSON.stringify({ ...info, duration: 4 })}));`);
  await assert.rejects(validateExternalReplacement({ ...input, checkpointSourceHash: cache.hash(source) }), /identity|changed/i);
  assert.deepEqual(await contents(checkpointDir), before);
});

test('refresh does not create a missing checkpoint directory', async t => {
  const { input, root } = await setup(t); const missing = path.join(root, 'missing');
  await assert.rejects(validateExternalReplacement({ ...input, checkpointDir: missing }), /missing|ENOENT|checkpoint/i);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});
const http = require('node:http');
test('DASH refresh refuses unchanged relative manifest moved to another resource base', async t => {
  const { input, checkpointDir, info } = await setup(t);
  const manifest = '<MPD type="static"><Period><BaseURL>segments/</BaseURL></Period></MPD>';
  const server = http.createServer((_req, res) => res.end(manifest));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const oldUrl = `http://127.0.0.1:${server.address().port}/original/manifest.mpd`;
  await cache.snapshot(checkpointDir, { sourceHash: cache.hash(oldUrl), identity: cache.identity(info, Buffer.from(manifest)), manifestBaseHash: cache.hash(oldUrl) }, 1024);
  const before = await contents(checkpointDir);
  await assert.rejects(validateExternalReplacement({ ...input, mediaType: 'dash', url: oldUrl.replace('/original/', '/different/'), checkpointSourceUrl: oldUrl }), /base|origin|location/i);
  await assert.rejects(validateExternalReplacement({ ...input, mediaType: 'dash', url: oldUrl.replace('manifest.mpd', 'other.mpd'), checkpointSourceUrl: oldUrl }), /base|origin|location/i);
  assert.deepEqual(await contents(checkpointDir), before);
});

test('legacy DASH checkpoint without a recorded resource base refuses source refresh', async t => {
  const { input, checkpointDir, info } = await setup(t);
  const manifest = '<MPD type="static"><Period/></MPD>';
  const server = http.createServer((_req, res) => res.end(manifest));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/manifest.mpd`;
  await cache.snapshot(checkpointDir, { sourceHash: cache.hash(url), identity: cache.identity(info, Buffer.from(manifest)) }, 1024);
  const before = await contents(checkpointDir);
  await assert.rejects(validateExternalReplacement({ ...input, mediaType: 'dash', url, checkpointSourceUrl: url }), /base location/);
  assert.deepEqual(await contents(checkpointDir), before);
});

test('legacy DASH continuation refuses retained files before extraction and preserves cache across redirect', async t => {
  const { input, root, checkpointDir, info, script } = await setup(t);
  const manifest = '<MPD type="static"><Period><BaseURL>segments/</BaseURL></Period></MPD>';
  const marker = path.join(root, 'extraction-started');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stdout.write(JSON.stringify(${JSON.stringify(info)}));`);
  let moved = false;
  const server = http.createServer((req, res) => {
    if (moved && req.url === '/original/manifest.mpd') return res.writeHead(302, { location: '/different/manifest.mpd' }).end();
    res.end(manifest);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/original/manifest.mpd`;
  await cache.snapshot(checkpointDir, { sourceHash: cache.hash(url), identity: cache.identity(info, Buffer.from(manifest)), downloadedBytes: 8, completedResources: 1 }, 1024);
  const before = await contents(checkpointDir);
  for (const redirect of [false, true]) {
    moved = redirect;
    await assert.rejects(downloadExternal({ ...input, mediaType: 'dash', url, output: path.join(root, 'video.mp4') }), /resource base.*missing|base location/i);
    assert.deepEqual(await contents(checkpointDir), before, 'rejection must preserve every file including checkpoint metadata');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'no extractor or transfer child may start');
  }
});

test('empty legacy DASH state may establish its first resource base', async t => {
  const { input, root, checkpointDir, info, script } = await setup(t);
  await fs.unlink(path.join(checkpointDir, 'media.mp4.part'));
  const marker = path.join(root, 'extraction-started');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(23);`);
  const manifest = '<MPD type="static"><Period/></MPD>';
  const server = http.createServer((_req, res) => res.end(manifest));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/manifest.mpd`;
  await cache.snapshot(checkpointDir, { sourceHash: cache.hash(url), identity: cache.identity(info, Buffer.from(manifest)), downloadedBytes: 0, completedResources: 0 }, 1024);
  const before = await contents(checkpointDir);
  await assert.rejects(downloadExternal({ ...input, mediaType: 'dash', url, output: path.join(root, 'video.mp4') }), /metadata/i);
  assert.equal(await fs.readFile(marker, 'utf8'), 'started', 'empty state reaches metadata extraction rather than migration refusal');
  assert.deepEqual(await contents(checkpointDir), before);
});
