'use strict';
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const STATE = 'checkpoint.json';
const MAX_STATE = 4 * 1024 * 1024;

async function fileDigest(filename, limit) {
  const input = await fs.open(filename, fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0));
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw Error('External checkpoint integrity check failed');
    const digest = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; offset += bytesRead; digest.update(buffer.subarray(0, bytesRead)); }
    if (offset !== stat.size) throw Error('External checkpoint changed during integrity check');
    return { bytes: stat.size, sha256: digest.digest('hex') };
  } finally { await input.close(); }
}

async function entries(directory) {
  const dirStat = await fs.lstat(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Error('External checkpoint must be a private directory');
  const files = await fs.readdir(directory, { withFileTypes: true });
  if (files.length > 20000) throw Error('External checkpoint contains too many files');
  for (const file of files) {
    const stat = await fs.lstat(path.join(directory, file.name));
    if (!file.isFile() || file.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !/^(?:checkpoint\.json(?:\.tmp)?|media[.\w-]*)$/.test(file.name)) throw Error('External checkpoint contains an unsafe entry');
  }
  return files.filter(file => file.name !== STATE && file.name !== `${STATE}.tmp`);
}

async function readState(directory, sourceHash, limit, { create = true } = {}) {
  if (!path.isAbsolute(directory)) throw Error('External checkpoint path must be absolute');
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await entries(directory);
  let data;
  try {
    const input = await fs.open(path.join(directory, STATE), fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0));
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATE) throw Error('External checkpoint state is invalid');
      data = JSON.parse(await input.readFile('utf8'));
    } finally { await input.close(); }
  } catch (error) { if (error.code === 'ENOENT' && files.length === 0) return null; throw Error(`External checkpoint integrity check failed: ${error.code === 'ENOENT' ? 'state missing' : 'invalid state'}`); }
  if (data.version !== 1 || data.sourceHash !== sourceHash || !Array.isArray(data.files) || data.files.length !== files.length || typeof data.identity !== 'string') throw Error('External checkpoint source or integrity changed');
  let total = 0;
  for (const file of files) {
    const saved = data.files.find(value => value.name === file.name);
    if (!saved || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0 || typeof saved.sha256 !== 'string') throw Error('External checkpoint integrity check failed');
    total += saved.bytes; if (total > limit) throw Error('External checkpoint exceeds size limit');
    const actual = await fileDigest(path.join(directory, file.name), limit);
    if (actual.bytes !== saved.bytes || actual.sha256 !== saved.sha256) throw Error('External checkpoint integrity check failed: corrupt cached file');
  }
  return data;
}

async function snapshot(directory, value, limit) {
  const files = []; let total = 0;
  for (const file of await entries(directory)) {
    const digest = await fileDigest(path.join(directory, file.name), limit);
    total += digest.bytes; if (total > limit) throw Error('External checkpoint exceeds size limit');
    files.push({ name: file.name, ...digest });
  }
  const data = { version: 1, ...value, files };
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_STATE) throw Error('External checkpoint state limit exceeded');
  const handle = await fs.open(path.join(directory, `${STATE}.tmp`), 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(path.join(directory, `${STATE}.tmp`), path.join(directory, STATE));
  return data;
}

function identity(info, manifest, selection) {
  const formats = info.requested_formats || [info];
  const selected = formats.map(format => Object.fromEntries(['format_id', 'ext', 'protocol', 'vcodec', 'acodec', 'width', 'height', 'fps', 'asr', 'audio_channels', 'filesize', 'fragment_count'].map(key => [key, format[key] ?? null])));
  return hash(JSON.stringify({ id: manifest ? null : info.id, duration: info.duration ?? null, formats: selected, manifest: manifest ? hash(manifest) : null, hls: info.flowdm_hls_identity ?? null, ...(selection ? { selection } : {}) }));
}

async function resumableProgress(directory) {
  let completedResources = 0; let keptFragments = 0; let bytes = 0;
  for (const entry of await entries(directory)) {
    if (/-Frag\d+$/.test(entry.name)) { keptFragments++; continue; } // Kept fragments duplicate the assembled partial.
    if (/\.ytdl$/.test(entry.name)) {
      const stat = await fs.stat(path.join(directory, entry.name));
      if (stat.size > MAX_STATE) throw Error('External fragment state limit exceeded');
      const state = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
      const index = state.downloader?.current_fragment?.index;
      if (Number.isSafeInteger(index) && index >= 0) completedResources += index;
    } else if (/\.(?:part|mp4|m4a|webm|ts)$/.test(entry.name)) bytes += (await fs.stat(path.join(directory, entry.name))).size;
  }
  return { downloadedBytes: bytes, completedResources: Math.max(completedResources, keptFragments) };
}

async function reconcileNative(directory, limit) {
  const names = (await entries(directory)).map(entry => entry.name);
  for (const name of names) {
    if (/-Frag\d+\.part(?:\.aria2)?$/.test(name)) { await fs.unlink(path.join(directory, name)); continue; }
    if (!name.endsWith('.ytdl')) continue;
    const filename = path.join(directory, name);
    if ((await fs.stat(filename)).size > MAX_STATE) throw Error('External fragment state limit exceeded');
    let state;
    try { state = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw Error('External fragment state is corrupt; retained bytes were preserved'); }
    const count = state.downloader?.current_fragment?.index;
    if (!Number.isSafeInteger(count) || count < 0 || count > 10000) throw Error('External fragment state is invalid');
    const partial = `${name.slice(0, -5)}.part`;
    const fragments = []; let bytes = 0;
    for (let index = 1; index <= count; index++) {
      const fragment = `${partial}-Frag${index}`;
      if (!names.includes(fragment)) throw Error('External fragment checkpoint is incomplete; retained bytes were preserved');
      bytes += (await fs.stat(path.join(directory, fragment))).size;
      if (bytes > limit) throw Error('External checkpoint exceeds size limit');
      fragments.push(fragment);
    }
    // A forced child stop can land between appending a fragment and updating
    // .ytdl. Rebuild the committed prefix from retained complete fragments.
    const current = await fs.stat(path.join(directory, partial)).catch(error => { if (error.code !== 'ENOENT') throw error; return { size: -1 }; });
    if (current.size === bytes) continue;
    const output = await fs.open(path.join(directory, partial), 'w', 0o600);
    try {
      for (const fragment of fragments) {
        const input = await fs.open(path.join(directory, fragment), 'r');
        try { for await (const chunk of input.createReadStream({ autoClose: false })) { let written = 0; while (written < chunk.length) { const result = await output.write(chunk, written, chunk.length - written); if (!result.bytesWritten) throw Error('External checkpoint write made no progress'); written += result.bytesWritten; } } } finally { await input.close(); }
      }
      await output.sync();
    } finally { await output.close(); }
  }
}

// Native fragment partials have a matching .ytdl journal. A plain HTTP video
// without one has no durable entity validator, so retain it and refuse unsafe
// continuation. Only unfinished M4A audio may restart after video is complete.
async function discardUnsafeHttpPartials(directory) {
  const names = (await entries(directory)).map(entry => entry.name);
  const partials = names.filter(name => name.endsWith('.part') && !names.includes(`${name.slice(0, -5)}.ytdl`));
  if (!partials.length) return;
  const videoSizes = await Promise.all(names.filter(name => name.endsWith('.mp4')).map(async name => (await fs.stat(path.join(directory, name))).size));
  if (partials.some(name => !name.endsWith('.m4a.part')) || !videoSizes.some(bytes => bytes > 0)) throw Error('Cannot safely continue this unfinished HTTP media resource without a validator; retained bytes were preserved');
  for (const name of partials) {
    await fs.unlink(path.join(directory, name));
    await fs.unlink(path.join(directory, `${name}.aria2`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
module.exports = { hash, readState, snapshot, identity, resumableProgress, discardUnsafeHttpPartials, reconcileNative };
