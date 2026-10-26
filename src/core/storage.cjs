'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { publish, preflightPublication } = require('./publication.cjs');

async function replaceJournal(temporary, filename) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, filename); return; }
    catch (error) {
      // Windows readers/indexers can briefly hold a destination sharing lock.
      // Retry only the same already-synced file; never copy or truncate in place.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
async function atomicJournal(filename, tasks, version = 2, metadata = {}) {
  if (![2, 3, 4, 5, 6, 7, 8].includes(version)) throw Error('Unsupported download journal version');
  if (version >= 7 && !Array.isArray(metadata.queues)) throw Error('Queue journal metadata is required');
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600); created = true;
    try { await handle.writeFile(JSON.stringify({ version, tasks, ...(version >= 7 ? { queues: metadata.queues } : {}) })); await handle.sync(); } finally { await handle.close(); }
    await replaceJournal(temporary, filename);
  } catch (error) {
    if (created) await fs.unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') error.cleanupCode = cleanup.code || 'CLEANUP_FAILED'; });
    throw error;
  }
}
async function backupJournal(filename, version) {
  const backup = path.join(path.dirname(filename), `downloads.v${version}.${crypto.randomUUID()}.backup.json`);
  const handle = await fs.open(backup, 'wx', 0o600);
  try { await handle.writeFile(await fs.readFile(filename)); await handle.sync(); } finally { await handle.close(); }
  return backup;
}
async function uniqueDestination(directory, filename, reserved) {
  await fs.mkdir(directory, { recursive: true });
  const actual = await fs.realpath(directory);
  const ext = path.extname(filename), stem = filename.slice(0, filename.length - ext.length);
  for (let index = 0; index < 10000; index++) {
    const name = index ? `${stem} (${index})${ext}` : filename;
    const destination = path.join(actual, name);
    if (reserved.has(destination.toLowerCase())) continue;
    try { await fs.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return { path: destination, filename: name }; throw error; }
  }
  throw Error('Cannot allocate a unique filename');
}
async function openPartial(filename, resume) {
  if (resume) {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe partial file');
  }
  return fs.open(filename, resume ? 'r+' : 'wx', 0o600);
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function recoverPublished(task) {
  if (!/^[a-f0-9]{64}$/i.test(task.sha256 || '') || !Number.isSafeInteger(task.downloadedBytes) || task.downloadedBytes < 0) return false;
  if (task.totalBytes !== null && task.totalBytes !== task.downloadedBytes) return false;
  try {
    const stat = await fs.lstat(task.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== task.downloadedBytes) return false;
    return (await hashFile(task.path)) === task.sha256.toLowerCase();
  } catch { return false; }
}
module.exports = { atomicJournal, backupJournal, uniqueDestination, openPartial, hashFile, publish, recoverPublished, preflightPublication };
