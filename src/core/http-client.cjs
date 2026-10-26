'use strict';
const http = require('node:http');
const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');
const { checkedUrl } = require('./policy.cjs');
const { isStrongEtag, identityEncoding } = require('./http-resume.cjs');
const { requestViaProxy } = require('./proxy.cjs');

async function request(url, headers, signal, redirects = 0) {
  const parsed = checkedUrl(url);
  const response = await new Promise((resolve, reject) => {
    const req = requestViaProxy(parsed, { headers: { ...headers, 'accept-encoding': 'identity' }, signal }, resolve);
    req.setTimeout(15000, () => req.destroy(Error('Network timeout')));
    req.on('error', reject);
    req.end();
  });
  // A response may be destroyed before its caller starts consuming it.
  response.on('error', () => {});
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 5 || !response.headers.location) throw Error('Redirect limit reached or missing Location');
    const next = checkedUrl(new URL(response.headers.location, parsed).href);
    if (parsed.protocol === 'https:' && next.protocol !== 'https:') throw Error('HTTPS redirect downgrade refused');
    const safeHeaders = next.origin === parsed.origin ? headers : Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie', 'proxy-authorization', 'referer'].includes(key.toLowerCase())));
    return request(next.href, safeHeaders, signal, redirects + 1);
  }
  return { response, finalUrl: parsed.href, requestHeaders: { ...headers } };
}
async function retryRequest(url, headers, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await request(url, headers, signal);
      if (![429, 500, 502, 503, 504].includes(result.response.statusCode) || attempt >= 2) return result;
      result.response.destroy();
    } catch (error) {
      if (signal.aborted || attempt >= 2 || /redirect|credentials|HTTP\/HTTPS/i.test(error.message)) throw error;
    }
    await delay(100 * 2 ** attempt + Math.floor(Math.random() * 40), undefined, { signal });
  }
}
function rangeInfo(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
  if (!match) throw Error('Invalid Content-Range');
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) throw Error('Invalid Content-Range bounds');
  return { start, end, total };
}
function contentLength(response) {
  const raw = response.headers['content-length'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw Error('Invalid Content-Length');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid Content-Length');
  return length;
}
async function probe(url, headers, signal, maxBytes) {
  const result = await retryRequest(url, { ...headers, range: 'bytes=0-0' }, signal);
  const { response } = result;
  try {
    if (![200, 206].includes(response.statusCode)) throw Error(`HTTP ${response.statusCode}`);
    if (!identityEncoding(response.headers['content-encoding'])) throw Error('Encoded responses are unsupported for byte-safe downloads');
    const ranges = response.statusCode === 206;
    if (!ranges && response.headers['content-range'] !== undefined) throw Error('Unexpected Content-Range on HTTP 200');
    const info = ranges ? rangeInfo(response) : null;
    if (info && (info.start !== 0 || info.end !== 0)) throw Error('Invalid probe Content-Range');
    if (ranges) {
      const length = contentLength(response);
      if (length !== null && length !== 1) throw Error('Invalid probe Content-Length');
      let received = 0;
      for await (const chunk of response) {
        received += chunk.length;
        if (received > 1) throw Error('Invalid probe response length');
      }
      if (received !== 1) throw Error('Truncated probe response');
    }
    const total = info ? info.total : contentLength(response);
    if (total !== null && total > maxBytes) throw Error('Download exceeds size limit');
    const etag = response.headers.etag;
    const candidate = { type: 'etag', value: etag };
    return { finalUrl: result.finalUrl, ranges, total, validator: isStrongEtag(candidate) ? candidate : response.headers['last-modified'] ? { type: 'modified', value: response.headers['last-modified'] } : null, contentEncoding: 'identity', contentType: response.headers['content-type'] || '' };
  } finally { response.destroy(); }
}
module.exports = { retryRequest, probe, rangeInfo, contentLength };
