'use strict';
const crypto = require('node:crypto');
const { checkedUrl } = require('../core/policy.cjs');
const { retryRequest, contentLength } = require('../core/http-client.cjs');
const LIMITS = { maxManifestBytes: 1024 * 1024, maxSegments: 10000, maxVariants: 1000 };
function checkedLimits(limits) {
  const bounds = { ...LIMITS, ...limits };
  for (const [key, maximum] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1 || bounds[key] > maximum) throw Error(`Invalid HLS ${key} limit`);
  }
  return bounds;
}
function resourceUrl(uri, base) {
  if (uri.includes('{$')) throw Error('HLS URI variables are unsupported');
  const url = checkedUrl(new URL(uri, base).href);
  if (new URL(base).protocol === 'https:' && url.protocol !== 'https:') throw Error('HTTPS media downgrade refused');
  return url.href;
}
function parsePlaylist(text, base, limits = {}) {
  const bounds = checkedLimits(limits);
  if (Buffer.byteLength(text) > bounds.maxManifestBytes) throw Error('HLS manifest limit exceeded');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw Error('Invalid HLS manifest header');
  if (lines.some(line => /^#EXT-X-(KEY|SESSION-KEY):/.test(line) && !/^#EXT-X-(KEY|SESSION-KEY):METHOD=NONE$/.test(line))) throw Error('Encrypted HLS and DRM are unsupported');
  if (lines.some(line => /^#EXT-X-(BYTERANGE|DISCONTINUITY|I-FRAMES-ONLY|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|GAP|SKIP|DEFINE)(:|$)/.test(line))) throw Error('HLS byte ranges, discontinuities, gaps, variables and partial segments are unsupported');
  let variantCount = 0, best = null;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    if (++variantCount > bounds.maxVariants) throw Error('HLS variant limit exceeded');
    if (/(?:^|,)\s*(AUDIO|VIDEO)=/.test(line.slice(18))) throw Error('HLS separate audio/video renditions are unsupported');
    const match = /(?:^|,)BANDWIDTH=(\d+)(?:,|$)/.exec(line.slice(18));
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0 || !lines[index + 1] || lines[index + 1].startsWith('#')) throw Error('Invalid HLS variant');
    const candidate = { bandwidth: Number(match[1]), url: resourceUrl(lines[index + 1], base) };
    if (!best || candidate.bandwidth > best.bandwidth) best = candidate;
  }
  if (best) {
    if (lines.some(line => /^#EXT-X-MEDIA:.*TYPE=(AUDIO|VIDEO)/.test(line))) throw Error('HLS separate audio/video renditions are unsupported');
    return { variant: best.url };
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw Error('Live HLS is unsupported; a complete VOD playlist is required');
  const resources = []; let pending = false, map = null, mediaCount = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const match = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
      if (!match || map || mediaCount) throw Error('HLS changing maps or map byte ranges are unsupported');
      map = resourceUrl(match[1], base); resources.push(map);
    } else if (line.startsWith('#EXTINF:')) {
      if (pending || !/^#EXTINF:\d+(?:\.\d+)?,/.test(line)) throw Error('Invalid HLS segment duration');
      pending = true;
    } else if (!line.startsWith('#')) {
      if (!pending) throw Error('Invalid HLS segment URI');
      resources.push(resourceUrl(line, base)); pending = false; mediaCount++;
      if (mediaCount > bounds.maxSegments) throw Error('HLS segment limit exceeded');
    }
  }
  if (pending || !mediaCount) throw Error('Invalid HLS segment list');
  return { resources, extension: map ? '.mp4' : '.ts', segmentCount: mediaCount };
}
function scopedHeaders(headers, from, to) {
  if (new URL(from).origin === new URL(to).origin) return { ...headers };
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie', 'proxy-authorization', 'referer'].includes(key.toLowerCase())));
}
async function getResource(url, context, signal) {
  resourceUrl(url, context.url);
  const result = await retryRequest(url, scopedHeaders(context.headers, context.url, url), signal);
  const { response } = result;
  if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
    response.destroy(); throw Error(`HLS resource requires unencoded HTTP 200 (received ${response.statusCode})`);
  }
  return { ...result, context: { url: result.finalUrl, headers: result.requestHeaders } };
}
async function loadPlaylist(url, headers, signal, limits = {}) {
  const bounds = checkedLimits(limits); let context = { url, headers };
  for (let depth = 0; depth < 4; depth++) {
    const result = await getResource(url, context, signal); const chunks = []; let size = 0;
    try {
      if (contentLength(result.response) > bounds.maxManifestBytes) throw Error('HLS manifest limit exceeded');
      for await (const chunk of result.response) {
        size += chunk.length; if (size > bounds.maxManifestBytes) throw Error('HLS manifest limit exceeded'); chunks.push(chunk);
      }
    } finally { result.response.destroy(); }
    const manifest = Buffer.concat(chunks);
    const playlist = parsePlaylist(manifest.toString('utf8'), result.finalUrl, bounds);
    context = result.context;
    if (!playlist.variant) return { ...playlist, context, finalUrl: result.finalUrl, manifestIdentity: crypto.createHash('sha256').update(manifest).digest('hex') };
    url = playlist.variant;
  }
  throw Error('HLS master nesting limit exceeded');
}
module.exports = { parsePlaylist, loadPlaylist, getResource };
