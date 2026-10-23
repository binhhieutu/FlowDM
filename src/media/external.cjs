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

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STDIO_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_SCRATCH_BYTES = 300 * 1024 ** 3;

function abortError() { return Object.assign(Error('Aborted'), { name: 'AbortError' }); }
function safeTool(tools) {
  if (!tools || !['ytDlp', 'ffmpeg', 'jsRuntime'].every(key => typeof tools[key] === 'string' && path.isAbsolute(tools[key]))) throw Error('Media tools are unavailable. Install the bundled yt-dlp and FFmpeg tools.');
  return tools;
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
  const server = http.createServer(async (request, response) => {
    try {
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
      const responseHeaders = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (result.response.headers[name]) responseHeaders[name] = result.response.headers[name];
      response.writeHead(result.response.statusCode || 502, responseHeaders);
      if (request.method === 'HEAD') { result.response.destroy(); response.end(); return; }
      let bytes = 0;
      if (contentLength(result.response) > maxBytes) throw Error('DASH relay resource exceeds size limit');
      for await (const chunk of result.response) { bytes += chunk.length; if (bytes > maxBytes) throw Error('DASH relay resource exceeds size limit'); if (!response.write(chunk)) await new Promise(resolve => response.once('drain', resolve)); }
      response.end();
    } catch (error) { if (!response.headersSent) response.writeHead(502); response.end(); }
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
  const runtimePaths = [path.dirname(tools.ytDlp), path.dirname(tools.ffmpeg), path.dirname(tools.jsRuntime)];
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
async function validateMediaOutput(filename, ffmpeg, signal) {
  if (signal?.aborted) throw abortError();
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-t', '1', '-f', 'null', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: mediaToolEnv({ ytDlp: ffmpeg, ffmpeg, jsRuntime: process.execPath }) });
    let timer; let stopReason = null; let stderr = Buffer.alloc(0);
    const stop = reason => { stopReason ||= reason; terminate(child); };
    const abort = () => stop('abort');
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), 30000); timer.unref();
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stopReason === 'abort' || signal?.aborted) return reject(abortError());
      if (stopReason === 'timeout') return reject(Error('FFmpeg media validation timed out'));
      if (code !== 0) return reject(Object.assign(Error('External media output is not a valid MP4 with video and audio'), { code: 'INVALID_EXTERNAL_MEDIA' }));
      resolve();
    });
  });
}
async function defaultTools() { return require('../tools/media-tools.cjs').resolveTools(); }
async function downloadExternal({ url, mediaType, headers = {}, output, signal, maxBytes, speedLimit = 0, onProgress = () => {}, timeoutMs = 30 * 60 * 1000, tools, toolArgsPrefix = [], validateOutput = validateMediaOutput }) {
  if (!['dash', 'youtube'].includes(mediaType)) throw Error('External media type must be dash or youtube');
  if (typeof output !== 'string' || !path.isAbsolute(output) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid external media output or size limit');
  if (!Number.isSafeInteger(speedLimit) || speedLimit < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw Error('Invalid external media limits');
  if (signal?.aborted) throw abortError();
  rejectCredentialHeaders(headers);
  const actualTools = safeTool(tools || await defaultTools());
  const youtubeSource = mediaType === 'youtube' ? canonicalYouTubeUrl(url) : null;
  const preflight = mediaType === 'dash' ? await preflightDash(url, headers, signal) : null;
  let relay;
  const scratch = path.join(path.dirname(output), `.flowdm-external-${crypto.randomUUID()}`);
  const scratchLimit = Math.min(MAX_SCRATCH_BYTES, maxBytes > Math.floor(MAX_SCRATCH_BYTES / 3) ? MAX_SCRATCH_BYTES : maxBytes * 3);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  try { relay = preflight ? await createDashRelay({ ...preflight, signal, maxBytes }) : null; }
  catch (error) { await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); throw error; }
  const source = relay ? relay.url : youtubeSource;
  const finalSource = preflight?.finalUrl || source;
  const template = path.join(scratch, 'media.%(ext)s');
  const args = [
    ...toolArgsPrefix, '--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist', '--no-overwrites', '--no-part', '--no-cache-dir', '--no-mtime', '--no-simulate',
    '--newline', '--progress', '--progress-template', 'download:flowdm-progress:%(progress.downloaded_bytes)s:%(progress.total_bytes_estimate)s',
    '--print', 'after_move:flowdm-file:%(filepath)s', '--ffmpeg-location', actualTools.ffmpeg, '--js-runtimes', `node:${actualTools.jsRuntime}`,
    '--merge-output-format', 'mp4', '--format', mediaType === 'youtube' ? 'bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[ext=mp4]' : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]', '--max-filesize', String(maxBytes), '-o', template
  ];
  if (mediaType === 'youtube') args.push('--match-filter', "live_status != 'is_live' & live_status != 'is_upcoming' & live_status != 'post_live'");
  if (speedLimit) args.push('--limit-rate', String(speedLimit));
  args.push('--batch-file', '-');
  let child; let stopReason = null; let resultPath; let stderr = Buffer.alloc(0); let stdout = Buffer.alloc(0); let stdoutTail = '';
  let timer; let sizeTimer; let scratchError = null; let checkingScratch = false;
  try {
    await new Promise((resolve, reject) => {
      child = spawn(actualTools.ytDlp, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: mediaToolEnv(actualTools) });
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${source}\n`);
      const stop = reason => { stopReason ||= reason; terminate(child); };
      const abort = () => stop('abort');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
      sizeTimer = setInterval(() => {
        if (checkingScratch) return;
        checkingScratch = true;
        void scratchBytes(scratch, scratchLimit).catch(error => { if (error.code !== 'ENOENT') { scratchError ||= error; stop('size'); } }).finally(() => { checkingScratch = false; });
      }, 100); sizeTimer.unref();
      child.stdout.on('data', chunk => {
        stdout = boundedAppend(stdout, chunk);
        const lines = `${stdoutTail}${chunk.toString('utf8')}`.split(/\r?\n/); stdoutTail = lines.pop().slice(-MAX_STDIO_BYTES);
        for (const line of lines) {
          const file = /^flowdm-file:(.+)$/.exec(line); if (file) resultPath = file[1];
          const progress = /^flowdm-progress:(\d+|NA):(?:\d+|NA)$/.exec(line);
          if (progress) onProgress({ downloadedBytes: progress[1] === 'NA' ? 0 : Number(progress[1]), totalBytes: null });
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
    const produced = processOutputPath(scratch, resultPath || '');
    await validateOutput(produced, actualTools.ffmpeg, signal);
    const bytes = await copyVerifiedFile(produced, output, maxBytes, signal);
    onProgress({ downloadedBytes: bytes, totalBytes: bytes });
    return { bytes, finalUrl: finalSource, metadata: { mediaType, tool: 'yt-dlp' } };
  } finally {
    if (timer) clearTimeout(timer);
    if (sizeTimer) clearInterval(sizeTimer);
    await relay?.close().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { canonicalYouTubeUrl, preflightDash, downloadExternal, rejectCredentialHeaders, createDashRelay, validateMediaOutput, mediaToolEnv };
