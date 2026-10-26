'use strict';
const crypto = require('node:crypto');
const RELEASE_PAGE = 'https://github.com/binhhieutu/FlowDM/releases';
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value)) throw Error('Invalid update version');
  return value.split('.').map(Number);
}
function manualUpdateInfo(currentVersion) {
  versionParts(currentVersion);
  return { mode: 'manual', currentVersion, automaticInstall: false, signedEndpointConfigured: false, releasePage: RELEASE_PAGE,
    message: 'Cập nhật thủ công qua GitHub. Chưa cấu hình máy chủ và khóa ký tin cậy để tự tải/cài bản cập nhật. Sao lưu profile khi ứng dụng đã đóng trước khi thay phiên bản.' };
}
function validateUpdateManifest(manifest, { currentVersion, platform, arch, publicKey }) {
  const keys = ['schema', 'version', 'platform', 'arch', 'url', 'bytes', 'sha256', 'signature'];
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== [...keys].sort().join(',')) throw Error('Invalid update manifest fields');
  const current = versionParts(currentVersion); const next = versionParts(manifest.version);
  const firstDifferent = next.findIndex((part, index) => part !== current[index]);
  if (firstDifferent < 0 || next[firstDifferent] < current[firstDifferent]) throw Error('Update version must be newer; downgrade refused');
  if (manifest.schema !== 1 || !['win32', 'linux'].includes(manifest.platform) || manifest.platform !== platform) throw Error('Update platform mismatch');
  if (!['x64', 'arm64'].includes(manifest.arch) || manifest.arch !== arch) throw Error('Update architecture mismatch');
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw Error('Invalid update size/hash');
  if (typeof manifest.url !== 'string' || manifest.url.length > 2048) throw Error('Invalid release URL');
  const url = new URL(manifest.url);
  const filename = manifest.platform === 'win32' ? `FlowDM ${manifest.version}.exe` : `flowdm-${manifest.version}.tar.gz`;
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash || decodeURIComponent(url.pathname) !== `/binhhieutu/FlowDM/releases/download/v${manifest.version}/${filename}`) throw Error('Untrusted release URL');
  const payload = { schema: manifest.schema, version: manifest.version, platform: manifest.platform, arch: manifest.arch, url: manifest.url, bytes: manifest.bytes, sha256: manifest.sha256 };
  const signature = typeof manifest.signature === 'string' ? Buffer.from(manifest.signature, 'base64') : Buffer.alloc(0);
  if (signature.length !== 64 || signature.toString('base64') !== manifest.signature) throw Error('Invalid update signature');
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(JSON.stringify(payload)), key, signature)) throw Error('Update signature verification failed');
  return { ...payload, signature: manifest.signature };
}
function verifyUpdatePayload(manifest, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== manifest.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('Update payload hash/size mismatch');
  return true;
}
module.exports = { manualUpdateInfo, validateUpdateManifest, verifyUpdatePayload };
