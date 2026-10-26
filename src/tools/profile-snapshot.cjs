'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = '.flowdm-restore-incomplete';
const MAX_FILES = 100000;
const MAX_BYTES = 1024 ** 4;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = value => typeof value === 'string' && value.length <= 4096 && !/[\\\u0000-\u001f:]/.test(value) && value.split('/').every(part => part && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function assertProfileReady(directory) { if (await exists(path.join(directory, MARKER))) throw Error('Khôi phục profile chưa hoàn tất; dùng một bản khôi phục đã hoàn tất.'); }
async function closed(directory) {
  await assertProfileReady(directory);
  if (await exists(path.join(directory, 'browser-bridge.json'))) throw Error('Close FlowDM before backing up the profile; after a crash reopen and close it first');
}
async function locations(source, destination) {
  if (![source, destination].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('Expected absolute profile paths');
  const stat = await fs.lstat(source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Expected a regular profile directory, not a link');
  const from = await fs.realpath(source);
  const to = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  if (to === from || to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) throw Error('Backup destination must be outside the source; nested profiles are refused');
  return { from, to };
}
async function walk(directory, prefix = '') {
  const parent = await fs.lstat(path.join(directory, prefix));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Expected a regular profile directory, not a link');
  const entries = [];
  for (const name of (await fs.readdir(path.join(directory, prefix))).sort()) {
    const item = prefix ? `${prefix}/${name}` : name;
    if (!relative(item)) throw Error('Unsafe profile filename');
    const stat = await fs.lstat(path.join(directory, item));
    if (stat.isSymbolicLink()) throw Error('Profile links are refused');
    if (stat.isDirectory()) entries.push(...await walk(directory, item));
    else if (stat.isFile() && stat.nlink === 1) entries.push({ path: item, bytes: stat.size });
    else throw Error('Profile must contain regular single-link files');
    if (entries.length > MAX_FILES) throw Error('Too many profile files');
  }
  return entries;
}
async function stableFile(filename, destination, signal) {
  signal?.throwIfAborted();
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('Expected regular profile file, not a link');
  const input = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output; let bytes = 0; const hash = crypto.createHash('sha256');
  try {
    const opened = await input.stat(); if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Profile file changed during open');
    if (destination) { await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); output = await fs.open(destination, 'wx', 0o600); }
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      signal?.throwIfAborted(); const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      bytes += bytesRead; if (bytes > before.size || bytes > MAX_BYTES) throw Error('Profile file size changed');
      hash.update(buffer.subarray(0, bytesRead));
      for (let at = 0; output && at < bytesRead;) { const result = await output.write(buffer, at, bytesRead - at, null); if (!result.bytesWritten) throw Error('Backup write made no progress'); at += result.bytesWritten; }
    }
    const after = await input.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Profile file changed during backup');
    if (output) await output.sync();
    return { bytes, sha256: hash.digest('hex') };
  } finally { await input.close(); if (output) await output.close(); }
}
async function readSmall(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2) throw Error('Invalid profile manifest size or file');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw Error('Profile manifest changed');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('Profile manifest changed');
    return bytes;
  } finally { await handle.close(); }
}
async function journal(directory) {
  const value = JSON.parse((await readSmall(path.join(directory, 'downloads.json'))).toString('utf8'));
  if (!Number.isInteger(value.version) || value.version < 1 || value.version > 8 || !Array.isArray(value.tasks)) throw Error('Unsupported journal schema version');
  if (value.tasks.some(task => task.status === 'downloading' || ['pending', 'running'].includes(task.postScan?.status))) throw Error('Active downloads/scans must be paused and the app closed');
  return value;
}
async function writeJson(filename, value) { const handle = await fs.open(filename, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); } }
async function verifyFiles(directory, files, signal) {
  const actual = await walk(directory);
  if (JSON.stringify(actual.map(item => item.path).sort()) !== JSON.stringify(files.map(item => item.path).sort())) throw Error('Profile files differ from snapshot manifest');
  for (const file of files) { const actual = await stableFile(path.join(directory, file.path), undefined, signal); if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw Error('Profile integrity hash/size changed'); }
}
async function copyFiles(source, destination, files, { signal, onProgress } = {}) {
  const results = [];
  // Journal last: an interrupted restore never exposes an authoritative old journal early.
  for (const file of [...files].sort((a, b) => Number(a.path === 'downloads.json') - Number(b.path === 'downloads.json'))) {
    signal?.throwIfAborted(); const result = await stableFile(path.join(source, file.path), path.join(destination, file.path), signal);
    if (result.bytes !== file.bytes || file.sha256 && result.sha256 !== file.sha256) throw Error('Profile integrity hash/size changed during copy');
    results.push({ path: file.path, ...result }); await onProgress?.({ copiedFiles: results.length, totalFiles: files.length });
  }
  signal?.throwIfAborted(); return results;
}
async function createProfileSnapshot({ source, destination, appVersion, signal, onProgress }) {
  const { from, to } = await locations(source, destination);
  if (!/^\d+\.\d+\.\d+$/.test(appVersion || '')) throw Error('Invalid application version');
  await closed(from); const state = await journal(from); const files = await walk(from);
  if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES) throw Error('Profile backup exceeds size limit');
  await fs.mkdir(to, { mode: 0o700 }); await fs.mkdir(path.join(to, 'data'), { mode: 0o700 });
  const copied = await copyFiles(from, path.join(to, 'data'), files, { signal, onProgress });
  await closed(from); await verifyFiles(from, copied, signal);
  const manifest = { format: 1, appVersion, journalVersion: state.version, createdAt: new Date().toISOString(), files: copied };
  if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) > 16 * 1024 ** 2) throw Error('Snapshot manifest exceeds size limit');
  await writeJson(path.join(to, 'manifest.json'), manifest); signal?.throwIfAborted();
  await writeJson(path.join(to, 'complete.json'), { manifestSha256: digest(await fs.readFile(path.join(to, 'manifest.json'))) });
  return manifest;
}
async function restoreProfileSnapshot({ snapshot, destination, compatibleSchemas, signal, onProgress }) {
  const { from, to } = await locations(snapshot, destination);
  const bytes = await readSmall(path.join(from, 'manifest.json'));
  const complete = JSON.parse((await readSmall(path.join(from, 'complete.json'))).toString('utf8'));
  if (complete.manifestSha256 !== digest(bytes)) throw Error('Incomplete or corrupted snapshot manifest');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || manifest.files.some(file => !relative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) || manifest.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES) throw Error('Invalid snapshot manifest files');
  if (!Array.isArray(compatibleSchemas) || !compatibleSchemas.length || compatibleSchemas.some(v => !Number.isInteger(v) || v < 1 || v > 8) || !compatibleSchemas.includes(manifest.journalVersion)) throw Error('Snapshot schema is not compatible with the selected application');
  await verifyFiles(path.join(from, 'data'), manifest.files, signal);
  if ((await journal(path.join(from, 'data'))).version !== manifest.journalVersion) throw Error('Snapshot journal schema mismatch');
  await fs.mkdir(to, { mode: 0o700 }); await writeJson(path.join(to, MARKER), { restoring: true });
  await copyFiles(path.join(from, 'data'), to, manifest.files, { signal, onProgress });
  signal?.throwIfAborted(); await fs.unlink(path.join(to, MARKER));
  return { directory: to, journalVersion: manifest.journalVersion, files: manifest.files.length };
}
module.exports = { createProfileSnapshot, restoreProfileSnapshot, assertProfileReady };
