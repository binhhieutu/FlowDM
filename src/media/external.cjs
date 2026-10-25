'use strict';
// This adapter deliberately delegates muxing/extractor maintenance to pinned yt-dlp
// and FFmpeg binaries.  It never evaluates site JavaScript or imports browser cookies.
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const { retryRequest, contentLength } = require('../core/http-client.cjs');
const { checkedUrl } = require('../core/policy.cjs');
const checkpoint = require('./external-checkpoint.cjs');
const { pinHlsMetadata } = require('./external-metadata.cjs');
const { normalizeCatalog, validateSelection, selectionFormat } = require('./catalog.cjs');
const { embedSubtitles } = require('./external-selection.cjs');
const { externalResizeControl } = require('./external-control.cjs');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STDIO_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_SCRATCH_BYTES = 300 * 1024 ** 3;
const DEFAULT_CONNECTIONS = 4;
const MIN_CONNECTIONS = 1;
const MAX_CONNECTIONS = 16;

function abortError() { return Object.assign(Error('Aborted'), { name: 'AbortError' }); }
function safeTool(tools, requireAria2c = false) {
  if (!tools || !['ytDlp', 'ffmpeg', 'jsRuntime'].every(key => typeof tools[key] === 'string' && path.isAbsolute(tools[key]))) throw Error('Media tools are unavailable. Install the bundled yt-dlp and FFmpeg tools.');
  if (requireAria2c && (typeof tools.aria2c !== 'string' || !path.isAbsolute(tools.aria2c))) throw Error('Media tools are unavailable. Install the bundled aria2c tool for YouTube downloads.');
  return tools;
}
function validatedConnections(value) {
  if (!Number.isSafeInteger(value) || value < MIN_CONNECTIONS || value > MAX_CONNECTIONS) throw Error(`Connections must be an integer from ${MIN_CONNECTIONS} to ${MAX_CONNECTIONS}`);
  return value;
}
function canonicalYouTubeUrl(value) {
  const url = checkedUrl(value);
  let id;
  if (url.hostname.toLowerCase() === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2];
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw Error('A canonical public YouTube video URL is required');
  return `https://www.youtube.com/watch?v=${id}`;
}
function rejectCredentialHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw Error('Headers must be an object');
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(key) || /[\r\n]/.test(value)) throw Error('Invalid external media header');
    if (key) throw Error('External media downloads do not accept browser headers');
  }
}
function mpdReferences(text, base) {
  const candidates = [];
  for (const match of text.matchAll(/<BaseURL(?:\s[^>]*)?>([^<]+)<\/BaseURL>|\b(?:media|initialization|sourceURL|href|index)\s*=\s*(["'])(.*?)\2/gi)) candidates.push(match[1] || match[3]);
  for (const candidate of candidates) {
    const resolved = new URL(candidate.trim(), base);
    if (!['http:', 'https:'].includes(resolved.protocol)) throw Error('DASH manifest references must use HTTP/HTTPS');
    if (new URL(base).protocol === 'https:' && resolved.protocol !== 'https:') throw Error('HTTPS media downgrade refused');
  }
}
async function preflightDash(value, headers = {}, signal) {
  const url = checkedUrl(value);
  const result = await retryRequest(url.href, headers, signal);
  const chunks = []; let bytes = 0;
  try {
    if (result.response.statusCode !== 200) throw Error(`DASH manifest requires HTTP 200 (received ${result.response.statusCode})`);
    if (contentLength(result.response) > MAX_MANIFEST_BYTES) throw Error('DASH manifest limit exceeded');
    for await (const chunk of result.response) {
      bytes += chunk.length; if (bytes > MAX_MANIFEST_BYTES) throw Error('DASH manifest limit exceeded');
      chunks.push(chunk);
    }
  } finally { result.response.destroy(); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!/<MPD(?:\s|>)/i.test(text)) throw Error('Invalid DASH MPD manifest');
  if (/<!\[CDATA\[/i.test(text) || /<[A-Za-z_][\w.-]*:(?:BaseURL|SegmentTemplate|SegmentURL|ContentProtection)\b/i.test(text)) throw Error('Unsupported DASH XML feature');
  if (/<!DOCTYPE|<!ENTITY|<(?:[A-Za-z_][\w.-]*:)?ContentProtection\b|cenc:|widevine|playready/i.test(text)) throw Error('Encrypted DASH and DRM are unsupported');
  for (const entity of text.matchAll(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]*);/gi)) if (!['amp', 'apos', 'gt', 'lt', 'quot'].includes(entity[1].toLowerCase())) throw Error('DASH entity references are unsupported');
  const root = /<MPD\b([^>]*)>/i.exec(text);
  if (!root || !/\btype\s*=\s*["']static["']/i.test(root[1]) || /availabilityStartTime|minimumUpdatePeriod/i.test(text)) throw Error('Live DASH is unsupported; a complete static MPD is required');
  if (/<Location\b|\b(?:xlink:href|remoteLocation)\s*=/i.test(text)) throw Error('Remote DASH manifest references are unsupported');
  mpdReferences(text, result.finalUrl);
  return { finalUrl: result.finalUrl, manifestBytes: bytes, manifest: Buffer.concat(chunks) };
}
async function createDashRelay({ finalUrl, manifest, signal, maxBytes }) {
  const origin = new URL(finalUrl).origin;
  const manifestPath = new URL(finalUrl).pathname + new URL(finalUrl).search;
  let receivedBytes = 0;
  let budgetError = null;
  const upstreams = new Set();
  const responses = new Set();
  const abortRelay = error => {
    budgetError ||= error;
    for (const upstream of upstreams) upstream.destroy(budgetError);
    for (const response of responses) response.destroy(budgetError);
  };
  const server = http.createServer(async (request, response) => {
    let upstream;
    responses.add(response);
    try {
      if (budgetError) throw budgetError;
      if (!['GET', 'HEAD'].includes(request.method || '') || typeof request.url !== 'string') throw Error('Unsupported relay request');
      if (request.url === manifestPath) {
        response.writeHead(200, { 'content-type': 'application/dash+xml', 'content-length': manifest.length });
        if (request.method === 'GET') response.end(manifest); else response.end();
        return;
      }
      const range = request.headers.range;
      if (range && (typeof range !== 'string' || !/^bytes=\d*-\d*$/.test(range))) throw Error('Invalid relay byte range');
      const targetUrl = new URL(request.url, origin);
      if (targetUrl.origin !== origin) throw Error('Relay origin mismatch');
      const target = checkedUrl(targetUrl.href);
      const result = await retryRequest(target.href, range ? { range } : {}, signal);
      upstream = result.response; upstreams.add(upstream);
      const responseHeaders = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (result.response.headers[name]) responseHeaders[name] = result.response.headers[name];
      if (contentLength(upstream) > maxBytes - receivedBytes) { abortRelay(Error('DASH relay resource budget exceeded')); throw budgetError; }
      response.writeHead(upstream.statusCode || 502, responseHeaders);
      if (request.method === 'HEAD') { upstream.destroy(); response.end(); return; }
      for await (const chunk of upstream) {
        if (budgetError) throw budgetError;
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) { abortRelay(Error('DASH relay resource budget exceeded')); throw budgetError; }
        if (!response.write(chunk)) await new Promise(resolve => response.once('drain', resolve));
      }
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      if (!response.headersSent) { response.writeHead(502); response.end(); }
      else response.destroy(error);
    } finally {
      if (upstream) upstreams.delete(upstream);
      responses.delete(response);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}${manifestPath}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); } };
}
function boundedAppend(current, chunk) { return Buffer.concat([current, chunk]).subarray(-MAX_STDIO_BYTES); }
function processOutputPath(scratch, filename) {
  const resolved = path.resolve(filename);
  const prefix = `${path.resolve(scratch)}${path.sep}`;
  if (!resolved.startsWith(prefix) || path.dirname(resolved) !== path.resolve(scratch)) throw Error('External tool produced an unsafe output path');
  return resolved;
}
function terminate(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500).unref();
  }
}
function mediaToolEnv(tools) {
  const runtimePaths = [...new Set([tools.ytDlp, tools.ffmpeg, tools.jsRuntime, tools.aria2c].filter(value => typeof value === 'string' && path.isAbsolute(value)).map(path.dirname))];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return { ELECTRON_RUN_AS_NODE: '1', SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP || path.join(systemRoot, 'Temp'), TMP: process.env.TMP || process.env.TEMP || path.join(systemRoot, 'Temp'), PATH: [...runtimePaths, path.join(systemRoot, 'System32')].join(';') };
  }
  return { ELECTRON_RUN_AS_NODE: '1', PATH: [...runtimePaths, '/usr/bin', '/bin'].join(':') };
}
async function scratchBytes(directory, limit) {
  let total = 0;
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw Error('External media scratch contains an unsafe entry');
      if (entry.isDirectory()) await walk(filename);
      else {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('External media scratch contains an unsafe file');
        total += stat.size;
        if (total > limit) throw Error('External media output exceeds size limit');
      }
    }
  }
  await walk(directory); return total;
}
async function copyVerifiedFile(source, destination, maxBytes, signal) {
  if (signal?.aborted) throw abortError();
  const input = await fs.open(source, fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0));
  let output; let failed = false;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw Error('External media tool produced an invalid output file');
    output = await fs.open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw Error('External media disk write made no progress');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== stat.size) throw Error('External media output changed during publication');
    if (signal?.aborted) throw abortError();
    await output.sync(); return stat.size;
  } catch (error) {
    failed = true; throw error;
  } finally {
    await output?.close().catch(() => {}); await input.close().catch(() => {});
    if (failed) await fs.unlink(destination).catch(() => {});
  }
}
async function validateMediaOutput(filename, ffmpeg, signal, selection) {
  if (signal?.aborted) throw abortError();
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, ...(selection?.mode === 'audio' ? ['-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0']), '-t', '1', '-f', 'null', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: mediaToolEnv({ ytDlp: ffmpeg, ffmpeg, jsRuntime: process.execPath }) });
    let timer; let stopReason = null; let stderr = Buffer.alloc(0);
    const stop = reason => { stopReason ||= reason; terminate(child); };
    const abort = () => stop('abort');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop('timeout'), 30000); timer.unref();
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stopReason === 'abort' || signal?.aborted) return reject(abortError());
      if (stopReason === 'timeout') return reject(Error('FFmpeg media validation timed out'));
      if (code !== 0) return reject(Object.assign(Error(selection ? 'External media output does not contain the selected valid tracks' : 'External media output is not a valid MP4 with video and audio'), { code: 'INVALID_EXTERNAL_MEDIA' }));
      resolve();
    });
  });
}
async function defaultTools() { return require('../tools/media-tools.cjs').resolveTools(); }
function aria2Arguments(connections, speedLimit) {
  const options = [
    `--max-connection-per-server=${connections}`, `--split=${connections}`, '--min-split-size=1M', '--no-conf=true', '--no-netrc=true', '--max-concurrent-downloads=1', '--follow-torrent=false', '--follow-metalink=false',
    '--enable-rpc=false', '--enable-dht=false', '--enable-dht6=false', '--enable-peer-exchange=false', '--bt-enable-lpd=false', '--check-certificate=true',
    '--file-allocation=none', '--allow-overwrite=false', '--auto-file-renaming=false', '--console-log-level=warn', '--summary-interval=0', '--download-result=hide'
  ];
  if (speedLimit) options.push(`--max-download-limit=${speedLimit}`, `--max-overall-download-limit=${speedLimit}`);
  return `aria2c:${options.join(' ')}`;
}
async function extractMetadata(tools, prefix, args, source, signal) {
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ytDlp, [...prefix, ...args, '--dump-single-json', '--skip-download', '--batch-file', '-'], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'], env: mediaToolEnv(tools) });
    let bytes = 0; const chunks = []; let reason;
    const stop = error => { reason ||= error; terminate(child); };
    const abort = () => stop(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(Error('External metadata extraction timed out')), 60000); timer.unref();
    child.stdin.on('error', () => {}); child.stdin.end(`${source}\n`);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(Error('External metadata size limit exceeded')); else chunks.push(chunk); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reason || signal?.aborted) return reject(reason || abortError());
      if (code !== 0) return reject(Error('External metadata extraction failed'));
      try { const info = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!info || typeof info !== 'object' || Array.isArray(info) || info.is_live || info.has_drm || info._has_drm) throw Error('Unsupported external media metadata'); resolve(info); } catch { reject(Error('Invalid or unsupported external media metadata')); }
    });
  });
}
function selectedFormat(mediaType) {
  return mediaType === 'youtube' ? 'bv*[vcodec^=avc1][height<=1080][protocol=m3u8_native]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[ext=mp4]' : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]';
}
function sourceBinding({ url, mediaType, checkpointSourceUrl, checkpointSourceHash }) {
  const candidate = mediaType === 'youtube' ? canonicalYouTubeUrl(url) : checkedUrl(url).href;
  const prior = checkpointSourceUrl === undefined ? candidate : mediaType === 'youtube' ? canonicalYouTubeUrl(checkpointSourceUrl) : checkedUrl(checkpointSourceUrl).href;
  if (checkpointSourceHash !== undefined && !/^[a-f0-9]{64}$/.test(checkpointSourceHash)) throw Error('Invalid external checkpoint source hash');
  const sourceHash = checkpointSourceHash || checkpoint.hash(prior);
  if (mediaType === 'youtube' && sourceHash !== checkpoint.hash(candidate)) throw Error('Replacement must identify the same canonical YouTube video');
  return sourceHash;
}
function checkpointLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid external media size limit');
  return Math.min(MAX_SCRATCH_BYTES, maxBytes > Math.floor(MAX_SCRATCH_BYTES / 3) ? MAX_SCRATCH_BYTES : maxBytes * 3);
}
function manifestBaseHash(url) {
  const base = checkedUrl(url); base.search = ''; base.hash = '';
  return checkpoint.hash(base.href);
}
function validateDashBase(saved, finalUrl) {
  const expected = saved.manifestBaseHash;
  if (!expected || expected !== manifestBaseHash(finalUrl)) throw Error('DASH resource base location changed; retained fragments were preserved');
}
function canonicalInspectionUrl(value) {
  const url = checkedUrl(value);
  if (['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname.toLowerCase()) && url.pathname === '/playlist') {
    const id = url.searchParams.get('list');
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(id || '')) throw Error('A canonical public YouTube playlist URL is required');
    return { source: 'https://www.youtube.com/playlist?list=' + id, playlist: true };
  }
  return { source: canonicalYouTubeUrl(value), playlist: false };
}
async function inspectMedia({ url, mediaType, signal, tools, toolArgsPrefix = [] }) {
  if (!['dash', 'youtube'].includes(mediaType)) throw Error('External media type must be dash or youtube');
  if (signal?.aborted) throw abortError();
  const actualTools = safeTool(tools || await defaultTools());
  const canonical = mediaType === 'youtube' ? canonicalInspectionUrl(url) : null;
  const preflight = mediaType === 'dash' ? await preflightDash(url, {}, signal) : null;
  let relay;
  try {
    relay = preflight ? await createDashRelay({ ...preflight, signal, maxBytes: MAX_MANIFEST_BYTES }) : null;
    const args = ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-cache-dir', '--js-runtimes', 'node:' + actualTools.jsRuntime, ...(canonical?.playlist ? ['--flat-playlist', '--playlist-end', '100', '--yes-playlist'] : ['--no-playlist'])];
    const metadata = await extractMetadata(actualTools, toolArgsPrefix, args, relay?.url || canonical.source, signal);
    return normalizeCatalog(metadata, { sourceUrl: mediaType === 'youtube' ? canonical.source : checkedUrl(url).href, mediaType });
  } finally { await relay?.close(); }
}
async function selectedMetadata(actualTools, toolArgsPrefix, mediaType, source, signal, selection, expectedExtension) {
  const args = ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist', '--no-cache-dir', '--js-runtimes', `node:${actualTools.jsRuntime}`, '--format', selection ? [selection.videoFormatId, selection.audioFormatId].filter(Boolean).join('+') : selectedFormat(mediaType)];
  const metadata = await extractMetadata(actualTools, toolArgsPrefix, args, source, signal);
  if (selection) {
    const picked = selectionFormat(selection, normalizeCatalog(metadata, { mediaType }));
    const expected = [picked.selection.videoFormatId, picked.selection.audioFormatId].filter(Boolean).sort();
    const actual = (Array.isArray(metadata.requested_formats) ? metadata.requested_formats : [metadata]).map(format => format.format_id).sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) throw Error('Selected format IDs do not match the extracted tracks');
    if (expectedExtension !== undefined && picked.extension !== expectedExtension) throw Error('Selected media container extension changed');
  }
  if (mediaType === 'youtube') metadata.flowdm_hls_identity = await pinHlsMetadata(metadata, signal);
  return metadata;
}
// Refresh is read-only: the manager commits the URL plus stable hash together in
// its journal, while subsequent transfer repeats identity verification using the
// same extracted metadata it supplies to yt-dlp. No cache rebinding is needed.
async function validateExternalReplacement({ url, mediaType, checkpointDir, maxBytes, checkpointSourceUrl, checkpointSourceHash, headers = {}, signal, tools, toolArgsPrefix = [], selection, expectedExtension }) {
  if (!['dash', 'youtube'].includes(mediaType)) throw Error('External media type must be dash or youtube');
  if (typeof checkpointDir !== 'string' || !path.isAbsolute(checkpointDir)) throw Error('External checkpoint path must be absolute');
  if (signal?.aborted) throw abortError();
  rejectCredentialHeaders(headers);
  if (selection !== undefined) selection = validateSelection(selection);
  const limit = checkpointLimit(maxBytes);
  const sourceHash = sourceBinding({ url, mediaType, checkpointSourceUrl, checkpointSourceHash });
  const saved = await checkpoint.readState(checkpointDir, sourceHash, limit, { create: false });
  if (!saved) throw Error('External checkpoint state is missing');
  const actualTools = safeTool(tools || await defaultTools(), mediaType === 'youtube');
  const preflight = mediaType === 'dash' ? await preflightDash(url, headers, signal) : null;
  if (preflight) validateDashBase(saved, preflight.finalUrl);
  let relay;
  try {
    relay = preflight ? await createDashRelay({ ...preflight, signal, maxBytes }) : null;
    const metadata = await selectedMetadata(actualTools, toolArgsPrefix, mediaType, relay?.url || canonicalYouTubeUrl(url), signal, selection, expectedExtension);
    if (selection && expectedExtension !== undefined && selectionFormat(selection, normalizeCatalog(metadata, { mediaType })).extension !== expectedExtension) throw Error('Selected media container extension changed');
    if (saved.identity !== checkpoint.identity(metadata, preflight?.manifest, selection)) throw Error('External media identity changed; retained fragments cannot be mixed');
    if (signal?.aborted) throw abortError();
    return { compatible: true, checkpointSourceHash: sourceHash };
  } finally { await relay?.close(); }
}
async function downloadExternalOperation({ url, mediaType, headers = {}, output, signal, maxBytes, connections = DEFAULT_CONNECTIONS, speedLimit = 0, onProgress = () => {}, timeoutMs = 30 * 60 * 1000, tools, toolArgsPrefix = [], validateOutput = validateMediaOutput, checkpointDir, checkpointSourceHash, selection, expectedExtension, onControlReady = () => {} }) {
  if (!['dash', 'youtube'].includes(mediaType)) throw Error('External media type must be dash or youtube');
  if (typeof output !== 'string' || !path.isAbsolute(output) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid external media output or size limit');
  if (!Number.isSafeInteger(speedLimit) || speedLimit < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw Error('Invalid external media limits');
  const actualConnections = validatedConnections(connections);
  if (signal?.aborted) throw abortError();
  rejectCredentialHeaders(headers);
  if (selection !== undefined) selection = validateSelection(selection);
  const youtubeSource = mediaType === 'youtube' ? canonicalYouTubeUrl(url) : null;
  const sourceHash = sourceBinding({ url, mediaType, checkpointSourceHash });
  const actualTools = safeTool(tools || await defaultTools(), mediaType === 'youtube');
  const preflight = mediaType === 'dash' ? await preflightDash(url, headers, signal) : null;
  let relay;
  if (checkpointDir !== undefined && (typeof checkpointDir !== 'string' || !path.isAbsolute(checkpointDir))) throw Error('External checkpoint path must be absolute');
  const scratch = checkpointDir || path.join(path.dirname(output), `.flowdm-external-${crypto.randomUUID()}`);
  const scratchLimit = checkpointLimit(maxBytes);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  try { relay = preflight ? await createDashRelay({ ...preflight, signal, maxBytes }) : null; }
  catch (error) { if (!checkpointDir) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); throw error; }
  const source = relay ? relay.url : youtubeSource;
  const finalSource = preflight?.finalUrl || source;
  const template = path.join(scratch, 'media.%(ext)s');
  const nativeConnections = speedLimit ? Math.min(actualConnections, speedLimit) : actualConnections;
  const nativeRate = speedLimit ? Math.max(1, Math.floor(speedLimit / nativeConnections)) : 0;
  let format = selectedFormat(mediaType); let extension = 'mp4';
  let resumeState = null; let metadata; let pinnedIdentity; let reused = { downloadedBytes: 0, completedResources: 0 };
  try {
    if (selection && !checkpointDir) metadata = await selectedMetadata(actualTools, toolArgsPrefix, mediaType, source, signal, selection, expectedExtension);
    if (checkpointDir) {
      resumeState = await checkpoint.readState(scratch, sourceHash, scratchLimit);
      if (preflight && resumeState && !resumeState.manifestBaseHash && (resumeState.files.length || resumeState.downloadedBytes > 0 || resumeState.completedResources > 0)) throw Error('DASH checkpoint resource base is missing; retained fragments were preserved. Start a new task to download safely.');
      if (resumeState?.manifestBaseHash && preflight) validateDashBase(resumeState, preflight.finalUrl);
      metadata = await selectedMetadata(actualTools, toolArgsPrefix, mediaType, source, signal, selection, expectedExtension);
      pinnedIdentity = checkpoint.identity(metadata, preflight?.manifest, selection);
      if (resumeState && resumeState.identity !== pinnedIdentity) throw Error('External media identity changed; retained fragments cannot be mixed');
      // Do not re-extract the source between validation and transfer. Only this
      // in-memory metadata carries ephemeral signed URLs into the native tool.
      delete metadata.requested_downloads;
      await checkpoint.reconcileNative(scratch, scratchLimit);
      await checkpoint.discardUnsafeHttpPartials(scratch);
      reused = await checkpoint.resumableProgress(scratch);
      await checkpoint.snapshot(scratch, { sourceHash, identity: pinnedIdentity, ...(preflight ? { manifestBaseHash: manifestBaseHash(preflight.finalUrl) } : {}), ...reused }, scratchLimit);
      onProgress({ ...reused, totalBytes: null, reusedResources: reused.completedResources, reusedBytes: reused.downloadedBytes });
    }
    if (selection) {
      const picked = selectionFormat(selection, normalizeCatalog(metadata, { sourceUrl: url, mediaType }));
      selection = picked.selection; format = picked.format; extension = picked.extension;
      if (expectedExtension !== undefined && expectedExtension !== extension) throw Error('Selected media container extension changed');
    }
  } catch (error) { await relay?.close().catch(() => {}); if (!checkpointDir) await fs.rm(scratch,{recursive:true,force:true}).catch(()=>{}); throw error; }
  const args = [
    ...toolArgsPrefix, '--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist', '--no-overwrites', ...(checkpointDir ? ['--part', '--continue', '--keep-fragments', '--abort-on-unavailable-fragments'] : ['--no-part']), '--no-cache-dir', '--no-mtime', '--no-simulate',
    '--newline', '--progress', '--progress-template', 'download:flowdm-progress:%(progress.downloaded_bytes)s:%(progress.total_bytes_estimate)s:%(progress.fragment_index)s',
    '--print', 'after_move:flowdm-file:%(filepath)s', '--ffmpeg-location', actualTools.ffmpeg, '--js-runtimes', `node:${actualTools.jsRuntime}`,
    '--merge-output-format', ['mp4', 'webm', 'mkv'].includes(extension) ? extension : 'mp4', '--format', format, '--max-filesize', String(maxBytes), '-o', template
  ];
  if (selection) args.push('--remux-video', extension);
  if (mediaType === 'youtube') {
    args.push('--match-filter', "live_status != 'is_live' & live_status != 'is_upcoming' & live_status != 'post_live'", '--downloader', `http:${actualTools.aria2c}`, '--downloader-args', aria2Arguments(actualConnections, speedLimit), '--downloader', 'dash,m3u8:native', '--concurrent-fragments', String(nativeConnections));
  } else {
    args.push('--downloader', 'dash,m3u8:native', '--concurrent-fragments', String(nativeConnections));
    // yt-dlp applies limit-rate per native fragment, so divide it to retain the job-wide cap.
    if (speedLimit) args.push('--limit-rate', String(nativeRate));
  }
  if (mediaType === 'youtube' && speedLimit) args.push('--limit-rate', String(nativeRate));
  args.push(metadata ? '--load-info-json' : '--batch-file', '-');
  let child; let stopReason = null; let resultPath; let stderr = Buffer.alloc(0); let stdout = Buffer.alloc(0); let stdoutTail = '';
  let timer; let sizeTimer; let scratchError = null; let checkingScratch = false; let polling = Promise.resolve();
  try {
    onControlReady(externalResizeControl(metadata, checkpointDir));
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      child = spawn(actualTools.ytDlp, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: mediaToolEnv(actualTools) });
      child.stdin?.on('error', () => {});
      child.stdin?.end(metadata ? JSON.stringify(metadata) : `${source}\n`);
      const stop = reason => { stopReason ||= reason; terminate(child); };
      const abort = () => stop('abort');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
      sizeTimer = setInterval(() => {
        if (checkingScratch) return;
        checkingScratch = true;
        polling = (async () => {
          await scratchBytes(scratch, scratchLimit);
          if (checkpointDir) {
            const progress = await checkpoint.resumableProgress(scratch);
            onProgress({ ...progress, totalBytes: null, reusedResources: reused.completedResources, reusedBytes: reused.downloadedBytes });
          }
        })().catch(error => { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { scratchError ||= error; stop('size'); } }).finally(() => { checkingScratch = false; });
      }, 100); sizeTimer.unref();
      child.stdout.on('data', chunk => {
        stdout = boundedAppend(stdout, chunk);
        const lines = `${stdoutTail}${chunk.toString('utf8')}`.split(/\r?\n/); stdoutTail = lines.pop().slice(-MAX_STDIO_BYTES);
        for (const line of lines) {
          const file = /^flowdm-file:(.+)$/.exec(line); if (file) resultPath = file[1];
          const progress = /^flowdm-progress:(\d+|NA):(?:\d+|NA)(?::(\d+|NA))?$/.exec(line);
          if (progress) onProgress({ downloadedBytes: progress[1] === 'NA' ? 0 : Number(progress[1]), totalBytes: null, ...(checkpointDir ? { completedResources: progress[2] && progress[2] !== 'NA' ? Number(progress[2]) : reused.completedResources, reusedResources: reused.completedResources, reusedBytes: reused.downloadedBytes } : {}) });
        }
      });
      child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
      child.once('error', reject);
      child.once('close', code => {
        signal?.removeEventListener('abort', abort);
        const file = /^flowdm-file:(.+)$/.exec(stdoutTail); if (file) resultPath = file[1];
        if (stopReason === 'abort' || signal?.aborted) return reject(abortError());
        if (stopReason === 'size') return reject(scratchError || Error('External media output exceeds size limit'));
        if (stopReason === 'timeout') return reject(Error('External media tool timed out'));
        if (code !== 0) return reject(Object.assign(Error('External media tool failed'), { code: 'EXTERNAL_MEDIA_TOOL' })); resolve();
      });
    });
    await scratchBytes(scratch, scratchLimit);
    let produced = processOutputPath(scratch, resultPath || '');
    if (selection?.subtitleIds.length) produced = await embedSubtitles({ metadata, selection, produced, scratch, tools: actualTools, signal, maxBytes, env: mediaToolEnv(actualTools) });
    await validateOutput(produced, actualTools.ffmpeg, signal, selection);
    const bytes = await copyVerifiedFile(produced, output, maxBytes, signal);
    onProgress({ downloadedBytes: bytes, totalBytes: bytes });
    return { bytes, finalUrl: finalSource, metadata: { mediaType, tool: 'yt-dlp', ...(checkpointDir ? { resumable: true, reusedResources: reused.completedResources, reusedBytes: reused.downloadedBytes } : {}) } };
  } finally {
    onControlReady(null);
    if (timer) clearTimeout(timer);
    if (sizeTimer) clearInterval(sizeTimer);
    await polling;
    await relay?.close().catch(() => {});
    if (checkpointDir && pinnedIdentity) {
      await checkpoint.reconcileNative(scratch, scratchLimit);
      const savedProgress = await checkpoint.resumableProgress(scratch);
      await checkpoint.snapshot(scratch, { sourceHash, identity: pinnedIdentity, ...(preflight ? { manifestBaseHash: manifestBaseHash(preflight.finalUrl) } : {}), ...savedProgress }, scratchLimit);
      onProgress({ ...savedProgress, totalBytes: null, reusedResources: reused.completedResources, reusedBytes: reused.downloadedBytes });
    }
    if (!checkpointDir) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
async function downloadExternal(options) {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw Error('Invalid external media limits');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  // One deadline covers preflight/extraction, transfer, subtitle HTTP/remux,
  // validation and the private output copy. Cleanup still waits for child exit
  // and checkpoints retained resources before returning the timeout.
  const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, timeoutMs);
  timer.unref();
  try {
    const result = await downloadExternalOperation({ ...options, timeoutMs, signal: controller.signal });
    if (controller.signal.aborted) {
      await fs.unlink(options.output).catch(error => { if (error.code !== 'ENOENT') throw error; });
      throw abortError();
    }
    return result;
  } catch (error) {
    if (timedOut) throw Object.assign(Error('External media operation timed out'), { code: 'EXTERNAL_MEDIA_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
module.exports = { inspectMedia, canonicalInspectionUrl, canonicalYouTubeUrl, preflightDash, downloadExternal, rejectCredentialHeaders, createDashRelay, validateMediaOutput, mediaToolEnv, aria2Arguments, validateExternalReplacement };
