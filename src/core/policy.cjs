'use strict';
const path = require('node:path');
const http = require('node:http');
const { validateSelection } = require('../media/catalog.cjs');

function checkedUrl(value) {
  if (typeof value !== 'string' || value.length > 32768) throw Error('URL must be a string of at most 32768 characters');
  if (/[\r\n]/.test(value)) throw Error('URL must not contain line breaks');
  const url = new URL(value);
  if (url.href.length > 32768) throw Error('Encoded URL exceeds 32768 characters');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP/HTTPS URLs without embedded credentials are supported');
  return url;
}
function checkedHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw Error('Headers must be an object');
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    http.validateHeaderName(key); http.validateHeaderValue(key, value);
    if (typeof value !== 'string') throw Error('Header values must be strings');
    if (['host', 'content-length', 'range', 'if-range', 'accept-encoding', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) throw Error(`Header ${key} is managed by the download engine`);
    result[key.toLowerCase()] = value;
  }
  return result;
}
function filenameFor(url, value) {
  let name = value;
  if (name === undefined) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download.bin'; } catch { name = 'download.bin'; }
    name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download.bin';
  }
  if (typeof name !== 'string' || name.length > 180 || !name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || path.basename(name) !== name) throw Error('Filename must be a safe single filename');
  return name;
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function inputOptions(input, defaultDirectory) {
  if (!input || typeof input !== 'object') throw Error('Download options are required');
  const url = checkedUrl(input.url).href;
  if (input.mediaType !== undefined && !['direct', 'hls', 'dash', 'youtube'].includes(input.mediaType)) throw Error('Media type must be direct, hls, dash or youtube');
  const parsedUrl = new URL(url);
  const isYouTube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsedUrl.hostname.toLowerCase());
  const mediaType = input.mediaType ?? (/\.m3u8$/i.test(parsedUrl.pathname) ? 'hls' : /\.mpd$/i.test(parsedUrl.pathname) ? 'dash' : isYouTube ? 'youtube' : 'direct');
  const directory = input.directory === undefined ? defaultDirectory : input.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('Download directory must be absolute');
  let startAt = input.startAt ?? null;
  if (typeof startAt === 'string') startAt = Date.parse(startAt);
  if (startAt !== null) integer(startAt, 0, 8640000000000000, 'Start time');
  const filename = filenameFor(url, input.filename);
  const headers = checkedHeaders(input.headers);
  if (['dash', 'youtube'].includes(mediaType) && Object.keys(headers).length) throw Error('External media downloads do not accept browser headers');
  const mediaFilename = mediaType === 'hls' ? `${path.parse(filename).name}.ts` : ['dash', 'youtube'].includes(mediaType) ? `${path.parse(filename).name || 'video'}.mp4` : filename;
  if (input.selection !== undefined && !['dash', 'youtube'].includes(mediaType)) throw Error('Format selection requires YouTube or DASH');
  const selection = input.selection === undefined ? undefined : validateSelection(input.selection);
  return { url, mediaType, filename: mediaFilename, directory, connections: integer(input.connections ?? 4, 1, 16, 'Connections'), speedLimit: integer(input.speedLimit ?? 0, 0, Number.MAX_SAFE_INTEGER, 'Speed limit'), startAt, headers, selection };
}
module.exports = { checkedUrl, checkedHeaders, inputOptions, integer };
