const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePlaylist } = require('../../src/media/hls.cjs');
const base = 'https://media.example/a/list.m3u8';
const vod = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\none.ts\n#EXTINF:2,\n../two.ts\n#EXT-X-ENDLIST';
test('parses VOD ordered relative segments and chooses highest muxed master', () => {
  assert.deepEqual(parsePlaylist(vod, base).resources, ['https://media.example/a/one.ts', 'https://media.example/two.ts']);
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,CODECS="avc1,mp4a"\nhigh.m3u8';
  assert.equal(parsePlaylist(master, base).variant, 'https://media.example/a/high.m3u8');
});
test('fMP4 prepends one initialization map and identifies output format', () => {
  const parsed = parsePlaylist(vod.replace('#EXTINF:2,', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,'), base);
  assert.equal(parsed.extension, '.mp4'); assert.equal(parsed.resources[0], 'https://media.example/a/init.mp4');
});
test('rejects unsupported or malformed playlists explicitly and enforces limits', () => {
  for (const text of ['bad', vod.replace('#EXT-X-ENDLIST', ''), vod.replace('one.ts', '#EXT-X-KEY:METHOD=AES-128,URI="key"\none.ts'), vod.replace('one.ts', '#EXT-X-BYTERANGE:10@0\none.ts'), vod.replace('one.ts', '#EXT-X-DISCONTINUITY\none.ts'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="aud"\none.m3u8', '#EXTM3U\n#EXT-X-ENDLIST', vod.replace('one.ts','file:///bad')]) assert.throws(() => parsePlaylist(text, base));
  assert.throws(() => parsePlaylist(vod, base, { maxSegments: 1 }), /segment limit/);
  assert.throws(() => parsePlaylist(vod, base, { maxManifestBytes: 10 }), /manifest limit/);
  for (const marker of ['#EXT-X-GAP', '#EXT-X-SKIP:SKIPPED-SEGMENTS=2', '#EXT-X-DEFINE:NAME="host",VALUE="example"']) assert.throws(() => parsePlaylist(vod.replace('one.ts', `${marker}\none.ts`), base), /unsupported/);
  assert.throws(() => parsePlaylist(vod.replace('one.ts', 'http://media.example/one.ts'), base), /downgrade/);
  assert.throws(() => parsePlaylist(vod.replace('one.ts', '{$host}/one.ts'), base), /variables/);
});
test('bounds master variants and resolves duplicate tags at their actual line positions', () => {
  const oversized = '#EXTM3U\n' + Array.from({ length: 18000 }, (_, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${i + 1}\nv${i}.m3u8`).join('\n');
  assert.ok(Buffer.byteLength(oversized) < 1024 * 1024);
  const start = performance.now();
  assert.throws(() => parsePlaylist(oversized, base), /variant limit/);
  assert.ok(performance.now() - start < 1000, 'oversized master must reject without a quadratic scan');
  const tag = '#EXT-X-STREAM-INF:BANDWIDTH=900';
  assert.throws(() => parsePlaylist(`#EXTM3U\n${tag}\none.m3u8\n${tag}`, base), /Invalid HLS variant/);
  const exact = '#EXTM3U\n' + Array.from({ length: 1000 }, (_, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${i + 1}\nv${i}.m3u8`).join('\n');
  assert.equal(parsePlaylist(exact, base).variant, 'https://media.example/a/v999.m3u8');
});
test('rejects invalid or raised public parser limits', () => {
  for (const limits of [{ maxVariants: 1001 }, { maxVariants: NaN }, { maxSegments: -1 }, { maxSegments: 10001 }, { maxManifestBytes: Infinity }, { maxManifestBytes: 2 ** 21 }]) assert.throws(() => parsePlaylist(vod, base, limits), /limit/);
});
