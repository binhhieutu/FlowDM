'use strict';
const { retryRequest, contentLength } = require('../core/http-client.cjs');
const { checkedUrl } = require('../core/policy.cjs');
const { hash } = require('./external-checkpoint.cjs');
const LIMIT = 1024 * 1024;

function hlsIdentity(text) {
  if (!text.startsWith('#EXTM3U') || !/^#EXT-X-ENDLIST\s*$/m.test(text)) throw Error('A finite YouTube HLS VOD playlist is required for continuation');
  const identity = []; let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^#EXT-X-KEY:/i.test(line) && !/\bMETHOD=NONE(?:,|$)/.test(line)) throw Error('Encrypted YouTube HLS is unsupported');
    if (line.startsWith('#')) identity.push(line.replace(/URI="[^"]*"/g, 'URI="resource"'));
    else {
      const url = checkedUrl(line);
      const index = /(?:\/sq\/|[?&]sq=)(\d+)(?:[/?&]|$)/.exec(`${url.pathname}${url.search}`)?.[1];
      identity.push(`fragment:${count++}:${index ?? ''}`);
    }
  }
  if (count < 1 || count > 10000) throw Error('YouTube HLS fragment limit exceeded');
  return hash(JSON.stringify(identity));
}

async function pinHlsMetadata(info, signal) {
  const fingerprints = [];
  for (const format of info.requested_formats || [info]) {
    if (format.protocol !== 'm3u8_native') continue;
    const headers = {};
    const agent = format.http_headers?.['User-Agent'];
    if (typeof agent === 'string' && !/[\r\n]/.test(agent)) headers['User-Agent'] = agent;
    const result = await retryRequest(checkedUrl(format.url).href, headers, signal);
    const chunks = []; let bytes = 0;
    try {
      if (result.response.statusCode !== 200 || contentLength(result.response) > LIMIT) throw Error('YouTube HLS identity manifest is unavailable or oversized');
      for await (const chunk of result.response) { bytes += chunk.length; if (bytes > LIMIT) throw Error('YouTube HLS identity manifest limit exceeded'); chunks.push(chunk); }
    } finally { result.response.destroy(); }
    fingerprints.push({ id: format.format_id, digest: hlsIdentity(Buffer.concat(chunks).toString('utf8')) });
  }
  return hash(JSON.stringify(fingerprints));
}
module.exports = { hlsIdentity, pinHlsMetadata };
