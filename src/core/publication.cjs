'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const FAT32_MAX_BYTES = 0xffffffff;
function publicationCapabilities(fileSystemType = 'unknown') {
  const type = String(fileSystemType).toUpperCase();
  const unsupported = ['FAT', 'FAT16', 'FAT32', 'EXFAT'].includes(type);
  const knownHardLinks = ['NTFS', 'EXT4', 'APFS', 'BTRFS', 'XFS'].includes(type);
  return { supported: unsupported ? false : knownHardLinks ? true : null, requiresProbe: !unsupported,
    method: unsupported ? null : 'hard-link', maxFileBytes: type === 'FAT32' ? FAT32_MAX_BYTES : null,
    reason: unsupported ? 'Atomic no-overwrite publication is not verified for FAT/exFAT' : 'A successful destination hard-link probe is still required' };
}
function validatePublicationSize(fileSystemType, size) {
  if (size !== undefined && size !== null && (!Number.isSafeInteger(size) || size < 0)) throw Error('Invalid publication size');
  const maximum = publicationCapabilities(fileSystemType).maxFileBytes;
  if (maximum !== null && size > maximum) throw Object.assign(Error('FAT32 files cannot exceed 4294967295 bytes'), { code: 'FILE_TOO_LARGE_FOR_FILESYSTEM' });
}
function requireCapability(options = {}) {
  validatePublicationSize(options.fileSystemType, options.size);
  if (publicationCapabilities(options.fileSystemType).supported === false) throw Object.assign(Error('Destination filesystem does not support verified safe publication (FAT/exFAT are unsupported)'), { code: 'UNSUPPORTED_DESTINATION_FILESYSTEM' });
}
async function preflightPublication(destination, options = {}) {
  requireCapability(options);
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
async function publish(partial, destination, options = {}) {
  requireCapability(options);
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
module.exports = { publicationCapabilities, validatePublicationSize, preflightPublication, publish };
