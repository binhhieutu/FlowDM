const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
function api() { const file = path.resolve('src/tools/update-manifest.cjs'); assert.ok(require('node:fs').existsSync(file), 'Update trust policy is required'); return require(file); }
function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const payload = Buffer.from('verified update fixture');
  const manifest = { schema: 1, version: '0.15.0', platform: 'win32', arch: 'x64', url: 'https://github.com/binhhieutu/FlowDM/releases/download/v0.15.0/FlowDM%200.15.0.exe', bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const options = { currentVersion: '0.14.0', platform: 'win32', arch: 'x64', publicKey };
  return { payload, options, sign: patch => { const value = { ...manifest, ...patch }; return { ...value, signature: crypto.sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString('base64') }; } };
}
test('manual updates disclose no authenticated endpoint and never install automatically', () => {
  const info = api().manualUpdateInfo('0.14.0'); assert.equal(info.mode, 'manual'); assert.equal(info.automaticInstall, false);
  assert.equal(info.signedEndpointConfigured, false); assert.equal(info.releasePage, 'https://github.com/binhhieutu/FlowDM/releases');
});
test('future update policy accepts only signed newer payload for the exact OS and architecture', () => {
  const { validateUpdateManifest, verifyUpdatePayload } = api(); const f = fixture(); const signed = f.sign();
  const valid = validateUpdateManifest(signed, f.options); assert.equal(valid.version, '0.15.0');
  assert.equal(verifyUpdatePayload(valid, f.payload), true);
  assert.throws(() => verifyUpdatePayload(valid, Buffer.from('wrong package')), /hash|size/i);
  assert.throws(() => validateUpdateManifest(signed, { ...f.options, platform: 'linux' }), /platform/i);
  assert.throws(() => validateUpdateManifest(signed, { ...f.options, arch: 'arm64' }), /architecture/i);
});
test('future updater refuses downgrade, tampering, unknown keys and untrusted release URLs', () => {
  const { validateUpdateManifest } = api(); const f = fixture();
  for (const version of ['0.14.0', '0.13.9', '0.15.0-beta', '01.15.0']) assert.throws(() => validateUpdateManifest(f.sign({ version }), f.options), /version|newer/i);
  for (const url of ['http://github.com/binhhieutu/FlowDM/releases/download/v0.15.0/a.exe', 'https://evil.example/a.exe', 'https://github.com/other/repo/releases/download/v0.15.0/a.exe', 'https://github.com/binhhieutu/FlowDM/releases/download/v0.15.0/a.exe?token=fixture']) assert.throws(() => validateUpdateManifest(f.sign({ url }), f.options), /URL|release/i);
  assert.throws(() => validateUpdateManifest({ ...f.sign(), bytes: 2 }, f.options), /signature/i);
  assert.throws(() => validateUpdateManifest({ ...f.sign(), extra: 'unexpected' }, f.options), /fields/i);
  assert.throws(() => validateUpdateManifest(f.sign(), { ...f.options, publicKey: crypto.generateKeyPairSync('ed25519').publicKey }), /signature/i);
});
