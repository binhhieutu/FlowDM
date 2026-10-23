'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, constants } = require('node:fs');

async function atomicJournal(filename, tasks) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 1, tasks })); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, filename); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
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
async function preflightPublication(destination) {
  const source = path.join(path.dirname(destination), `.flowdm-preflight-${crypto.randomUUID()}.tmp`);
  const target = `${source}.link`;
  try {
    const handle = await fs.open(source, 'wx', 0o600);
    try { await handle.writeFile('FlowDM'); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(source, target); }
    catch (error) {
      if (['EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EXDEV', 'EINVAL'].includes(error.code)) throw Object.assign(Error('Destination filesystem does not support safe hard-link publication (FAT/exFAT are unsupported)'), { code: 'UNSUPPORTED_DESTINATION_FILESYSTEM' });
      throw error;
    }
  } finally {
    await Promise.all([source, target].map(filename => fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  }
}
async function publish(partial, destination) {
  // Copy into the destination filesystem, then publish an already flushed inode.
  // link() refuses any preexisting final entry, including symbolic links.
  const staging = path.join(path.dirname(destination), `.flowdm-${crypto.randomUUID()}.tmp`);
  try {
    await fs.copyFile(partial, staging, constants.COPYFILE_EXCL);
    const handle = await fs.open(staging, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.link(staging, destination);
    await fs.unlink(partial);
  } finally { await fs.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
module.exports = { atomicJournal, uniqueDestination, openPartial, hashFile, publish, recoverPublished, preflightPublication };
