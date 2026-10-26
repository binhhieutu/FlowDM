'use strict';
const { Client } = require('basic-ftp');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const MAX_BYTES = 100 * 1024 ** 3;
const COMMON_FIELDS = ['url', 'credentials', 'signal', 'maxBytes', 'tlsOptions', 'proxy'];
function safeFailure(message, code) { const error = new Error(message); error.safeFtp = true; if (code) error.code = code; return error; }
function object(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw safeFailure('Invalid FTP ' + name);
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw safeFailure('Invalid FTP ' + name); return value;
}
function configuration(input, download = false) {
  object(input, [...COMMON_FIELDS, ...(download ? ['partialPath', 'startOffset', 'expectedIdentity', 'speedLimit', 'onProgress'] : [])], 'options');
  if (input.proxy) throw safeFailure('FTP through a proxy is not supported; direct fallback is refused');
  if (typeof input.url !== 'string' || input.url.length > 32768 || /[\x00-\x20\x7f]/.test(input.url)) throw safeFailure('Invalid FTP URL');
  let url; try { url = new URL(input.url); } catch { throw safeFailure('Invalid FTP URL'); }
  if (!['ftp:', 'ftps:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search) throw safeFailure('FTP/FTPS URL without embedded credentials or query is required');
  let remotePath; try { remotePath = decodeURIComponent(url.pathname); } catch { throw safeFailure('Invalid FTP path encoding'); }
  if (!remotePath.startsWith('/') || /[\x00-\x1f\x7f]/.test(remotePath)) throw safeFailure('Invalid FTP path');
  url.hash = '';
  const port = integer(url.port ? Number(url.port) : 21, 1, 65535, 'port');
  const credentials = input.credentials ?? { user: 'anonymous', password: 'guest' };
  object(credentials, ['user', 'password'], 'credentials');
  if (typeof credentials.user !== 'string' || !credentials.user || credentials.user.length > 1024 || typeof credentials.password !== 'string' || credentials.password.length > 4096 || /[\x00-\x1f\x7f]/.test(credentials.user + credentials.password)) throw safeFailure('Invalid FTP credentials');
  const tlsOptions = input.tlsOptions ?? {};
  object(tlsOptions, ['ca', 'servername'], 'TLS options');
  if (tlsOptions.ca !== undefined && typeof tlsOptions.ca !== 'string' && !Buffer.isBuffer(tlsOptions.ca)) throw safeFailure('Invalid FTPS certificate authority');
  if (tlsOptions.servername !== undefined && (typeof tlsOptions.servername !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(tlsOptions.servername))) throw safeFailure('Invalid FTPS server name');
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw safeFailure('Invalid FTP cancellation signal');
  input.signal?.throwIfAborted();
  return { url: url.href, remotePath, host: url.hostname.replace(/^\[|\]$/g, ''), port, secure: url.protocol === 'ftps:', credentials, tlsOptions: { ...tlsOptions, rejectUnauthorized: true }, maxBytes: integer(input.maxBytes ?? MAX_BYTES, 1, Number.MAX_SAFE_INTEGER, 'size limit'), signal: input.signal };
}
function cleanError(error, signal) {
  if (signal?.aborted) return safeFailure('FTP transfer cancelled', 'ABORT_ERR');
  if (error?.safeFtp) return error;
  if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error?.code || '')) return safeFailure('FTPS certificate validation failed', error.code);
  if (error?.code === 530) return safeFailure('FTP login was refused', 'FTP_AUTH');
  if (['EEXIST', 'ENOENT', 'EACCES', 'ENOSPC', 'EPERM'].includes(error?.code)) return safeFailure('FTP partial file operation failed (' + error.code + ')', error.code);
  if (error?.code === 'TimeoutError' || /timed? ?out|timeout/i.test(error?.message || '')) return safeFailure('FTP operation timed out', 'FTP_TIMEOUT');
  return safeFailure('FTP operation failed' + (Number.isInteger(error?.code) ? ' (' + error.code + ')' : ''), 'FTP_ERROR');
}
async function withClient(config, operation) {
  const client = new Client(15000, { allowSeparateTransferHost: false, maxListingBytes: 1024 * 1024 });
  const abort = () => client.close(); config.signal?.addEventListener('abort', abort, { once: true });
  try {
    config.signal?.throwIfAborted();
    await client.access({ host: config.host, port: config.port, user: config.credentials.user, password: config.credentials.password, secure: config.secure, ...(config.secure ? { secureOptions: { ...config.tlsOptions } } : {}) });
    config.signal?.throwIfAborted(); return await operation(client);
  } catch (error) { throw cleanError(error, config.signal); }
  finally { config.signal?.removeEventListener('abort', abort); client.close(); }
}
async function identityFor(client, config) {
  const size = await client.size(config.remotePath);
  if (!Number.isSafeInteger(size) || size < 0 || size > config.maxBytes) throw safeFailure('FTP file exceeds the size limit');
  let modifiedAt = null;
  try { const modified = await client.lastMod(config.remotePath); if (Number.isFinite(modified.getTime())) modifiedAt = modified.toISOString(); } catch {}
  return { sourceHash: ftpSourceHash(config.url, config.credentials.user), size, modifiedAt };
}
function ftpSourceHash(url, user = 'anonymous') { const parsed = new URL(url); parsed.hash = ''; return createHash('sha256').update(JSON.stringify(['FlowDM FTP principal v1', parsed.href, user])).digest('hex'); }
function verifyResume(expected, actual) {
  if (!expected || typeof expected !== 'object' || !actual.modifiedAt || typeof expected.modifiedAt !== 'string' || expected.sourceHash !== actual.sourceHash || expected.size !== actual.size || expected.modifiedAt !== actual.modifiedAt) throw safeFailure('FTP resume identity changed or MDTM identity is unavailable; partial file retained');
}
async function inspectFtp(input) {
  const config = configuration(input);
  return withClient(config, async client => { const identity = await identityFor(client, config); return { totalBytes: identity.size, identity, secure: config.secure }; });
}
async function listFtp(input) {
  const config = configuration(input);
  return withClient(config, async client => {
    const entries = await client.list(config.remotePath);
    if (entries.length > 1000) throw safeFailure('FTP listing exceeds 1000 entries');
    return entries.map(entry => ({ name: String(entry.name).slice(0, 1024), size: entry.size, isDirectory: entry.isDirectory, modifiedAt: entry.modifiedAt?.toISOString() || null }));
  });
}
async function partialHandle(filename, offset, resume) {
  if (!path.isAbsolute(filename)) throw safeFailure('Absolute FTP partial path required');
  if (!resume) return fs.open(filename, 'wx', 0o600);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== offset) throw safeFailure('FTP partial size does not match resume offset');
  const handle = await fs.open(filename, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
  const after = await handle.stat();
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size !== offset) { await handle.close(); throw safeFailure('FTP partial identity or size changed'); }
  return handle;
}
async function downloadFtp(input) {
  const config = configuration(input, true);
  if (typeof input.partialPath !== 'string' || !path.isAbsolute(input.partialPath)) throw safeFailure('Absolute FTP partial path required');
  const offset = integer(input.startOffset ?? 0, 0, config.maxBytes, 'resume offset'), speed = integer(input.speedLimit ?? 0, 0, Number.MAX_SAFE_INTEGER, 'speed limit');
  if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw safeFailure('Invalid FTP progress callback');
  return withClient(config, async client => {
    const identity = await identityFor(client, config);
    const resume = offset > 0 || input.expectedIdentity !== undefined;
    if (resume) verifyResume(input.expectedIdentity, identity);
    if (offset > identity.size) throw safeFailure('FTP resume offset exceeds remote size');
    const handle = await partialHandle(input.partialPath, offset, resume);
    let downloadedBytes = offset, chain = Promise.resolve(); const began = performance.now();
    const progress = () => input.onProgress?.({ downloadedBytes, totalBytes: identity.size, identity: { ...identity }, activeConnections: 1 });
    const sink = new Writable({ write(chunk, _encoding, callback) {
      chain = chain.then(async () => {
        config.signal?.throwIfAborted();
        if (downloadedBytes + chunk.length > identity.size || downloadedBytes + chunk.length > config.maxBytes) throw safeFailure('FTP transfer exceeded expected file size');
        if (speed) { const wait = (downloadedBytes - offset + chunk.length) * 1000 / speed - (performance.now() - began); if (wait > 0) await delay(wait, undefined, { signal: config.signal }); }
        let written = 0;
        while (written < chunk.length) { const result = await handle.write(chunk, written, chunk.length - written, downloadedBytes); if (!result.bytesWritten) throw safeFailure('FTP partial write made no progress'); written += result.bytesWritten; downloadedBytes += result.bytesWritten; }
        progress();
      });
      chain.then(() => callback(), callback);
    } });
    sink.on('error', () => {});
    try {
      progress();
      if (downloadedBytes < identity.size) await client.downloadTo(sink, config.remotePath, offset);
      await chain; config.signal?.throwIfAborted();
      if (downloadedBytes !== identity.size) throw safeFailure('FTP transfer ended before expected file size');
      const after = await identityFor(client, config);
      if (after.size !== identity.size || after.modifiedAt !== identity.modifiedAt) throw safeFailure('FTP source identity changed during transfer; partial file retained');
      return { totalBytes: identity.size, downloadedBytes, identity, secure: config.secure };
    } finally { await chain.catch(() => {}); sink.destroy(); try { await handle.sync(); } finally { await handle.close(); } }
  });
}
module.exports = { inspectFtp, listFtp, downloadFtp, ftpSourceHash };
