'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createValidator } = require('./container-check.cjs');
const formatFor = (playlist, index) => playlist.extension === '.ts' ? 'ts' : index === 0 ? 'mp4-init' : 'mp4-fragment';
const checkpointError = message => Error(`HLS checkpoint: ${message}`);
async function renameDurably(source, destination) {
  // Windows readers/antivirus can briefly deny replacement. Preserve atomic rename:
  // never unlink the old metadata to work around a sharing violation.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await delay(Math.min(80, 10 * 2 ** attempt));
    }
  }
}
async function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node; individual files are flushed above.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function regularFile(filename, maxBytes) {
  const stat = await fs.lstat(filename).catch(() => { throw checkpointError('missing saved resource'); });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw checkpointError('invalid saved file or size limit');
  return stat;
}
async function inspectResource(filename, playlist, index, maxBytes) {
  const stat = await regularFile(filename, maxBytes); const validator = createValidator(formatFor(playlist, index), maxBytes); const hash = crypto.createHash('sha256');
  const handle = await fs.open(filename, 'r');
  try { for await (const chunk of handle.createReadStream()) { hash.update(chunk); validator.push(chunk); } } finally { await handle.close(); }
  validator.finish(); return { bytes: stat.size, sha256: hash.digest('hex') };
}
async function openCheckpoint(directory, playlist, maxBytes) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw checkpointError('invalid directory');
  if (playlist.manifestIdentity !== undefined && !/^[a-f0-9]{64}$/.test(playlist.manifestIdentity)) throw checkpointError('invalid manifest identity');
  const identity = crypto.createHash('sha256').update(JSON.stringify({
    extension: playlist.extension, resources: playlist.resources,
    manifestIdentity: playlist.manifestIdentity || null,
    semantic: playlist.manifestIdentity ? null : {
      segmentCount: playlist.segmentCount ?? null, mediaSequence: playlist.mediaSequence ?? null,
      durations: playlist.durations ?? null, initialization: playlist.initialization ?? null
    }
  })).digest('hex');
  const filename = path.join(directory, 'checkpoint.json'); const names = await fs.readdir(directory);
  let state = { version: 1, identity, count: playlist.resources.length, resources: [] };
  if (names.includes('checkpoint.json')) {
    await regularFile(filename, 4 * 1024 * 1024);
    try { state = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw checkpointError('invalid metadata'); }
    if (state.version !== 1 || state.identity !== identity || state.count !== playlist.resources.length || !Array.isArray(state.resources) || state.resources.length > playlist.resources.length) throw checkpointError('playlist identity changed or invalid metadata');
  } else if (names.some(name => !/^index-\d+\.partial$/.test(name) && name !== 'checkpoint.tmp')) throw checkpointError('saved metadata missing');
  const ready = new Map(); let bytes = 0;
  for (const item of state.resources) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= playlist.resources.length || ready.has(item.index) || !Number.isSafeInteger(item.bytes) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw checkpointError('invalid resource metadata');
    const resource = path.join(directory, `index-${item.index}.bin`); let actual;
    try { actual = await inspectResource(resource, playlist, item.index, maxBytes); } catch (error) { throw checkpointError(`saved resource failed validation: ${error.message}`); }
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw checkpointError('saved resource integrity changed');
    bytes += actual.bytes; if (bytes > maxBytes) throw checkpointError('combined size limit'); ready.set(item.index, { filename: resource, bytes: actual.bytes });
  }
  const referenced = new Set(state.resources.map(item => `index-${item.index}.bin`));
  for (const name of names) {
    if (name === 'checkpoint.json' || name === 'checkpoint.tmp' || referenced.has(name)) continue;
    const partial = /^index-(0|[1-9]\d*)\.partial$/.exec(name);
    if (!partial || Number(partial[1]) >= playlist.resources.length) throw checkpointError('unreferenced resource or unexpected file; retain checkpoint for inspection');
    const partialPath = path.join(directory, name); const partialStat = await fs.lstat(partialPath);
    if (!partialStat.isFile() || partialStat.isSymbolicLink() || partialStat.nlink !== 1) throw checkpointError('invalid partial resource');
    await fs.unlink(partialPath);
  }
  let saves = Promise.resolve();
  async function writeState() {
    const temporary = path.join(directory, 'checkpoint.tmp'); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await renameDurably(temporary, filename); await syncDirectory(directory);
  }
  if (!names.includes('checkpoint.json')) await writeState();
  return {
    ready, bytes,
    save(index, source, size) {
      const operation = saves.then(async () => {
        const actual = await inspectResource(source, playlist, index, maxBytes);
        if (actual.bytes !== size) throw checkpointError('resource size changed before commit');
        const destination = path.join(directory, `index-${index}.bin`); await renameDurably(source, destination); await syncDirectory(directory);
        state = { ...state, resources: [...state.resources, { index, ...actual }].sort((a, b) => a.index - b.index) };
        await writeState(); return destination;
      });
      saves = operation.catch(() => {}); return operation;
    }
  };
}
module.exports = { openCheckpoint };
