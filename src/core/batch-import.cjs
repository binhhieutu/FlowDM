'use strict';
const { checkedUrl } = require('./policy.cjs');
const MAX_URLS = 1000;
const MAX_TEXT_BYTES = 512 * 1024;
function canonicalUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw Error('URL must be text without control characters');
  const url = checkedUrl(value);
  url.hash = '';
  return url.href;
}
function parseUrlList(text) {
  if (typeof text !== 'string') throw Error('URL list must be text');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw Error('URL list exceeds the 512 KiB size limit');
  const lines = text.split(/\r?\n/);
  if (lines.filter(line => line.trim()).length > MAX_URLS) throw Error('URL list exceeds the 1000 line limit');
  const urls = [], errors = [], seen = new Set(); let duplicates = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const url = canonicalUrl(line.trim());
      if (seen.has(url)) { duplicates++; continue; }
      seen.add(url); urls.push(url);
    } catch { errors.push({ line: index + 1, message: 'Invalid HTTP/HTTPS URL or embedded credentials' }); }
  }
  if (Buffer.byteLength(urls.join('\n'), 'utf8') > MAX_TEXT_BYTES) throw Error('Canonical URL list exceeds the 512 KiB size limit');
  return { urls, errors, duplicates };
}
module.exports = { parseUrlList, canonicalUrl, MAX_URLS, MAX_TEXT_BYTES };
