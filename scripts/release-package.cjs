const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { zipSync, unzipSync } = require('fflate');
const MAX_BYTES = 64 * 1024 ** 2;
const rootFiles = ['README.md', 'LICENSE', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes'];
const safe = name => typeof name === 'string' && !/[\\\u0000-\u001f:]/.test(name) && name.split('/').every(part => part && !/[. ]$/.test(part) && part !== '..');
function allowSource(name) {
  if (!safe(name)) return false;
  if (rootFiles.includes(name)) return true;
  if (/^(?:src|assets|extension|scripts|tests|docs|\.github\/workflows)\//.test(name) && !name.startsWith('docs/evidence/')) return /\.(?:cjs|js|json|md|html|css|ico|png|ya?ml|m3u8|mpd)$/.test(name);
  return false;
}
async function sourceMaps(root) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(allowSource).sort();
  const source = Object.create(null); const extension = Object.create(null); let total = 0;
  for (const name of names) {
    const filename = path.join(root, name);
    for (let current = filename; current !== root; current = path.dirname(current)) if ((await fs.lstat(current)).isSymbolicLink()) throw Error('Release source links are refused');
    const stat = await fs.lstat(filename); if (!stat.isFile() || stat.size > MAX_BYTES || (total += stat.size) > MAX_BYTES) throw Error('Release source size/type limit');
    const bytes = await fs.readFile(filename); source[name] = bytes;
    if (name.startsWith('extension/')) extension[name.slice('extension/'.length)] = bytes;
  }
  for (const name of ['README.md', 'LICENSE', 'package.json', 'package-lock.json', 'src/main.cjs', 'extension/manifest.json']) if (!source[name]) throw Error(`Required source missing: ${name}`);
  const version = JSON.parse(source['package.json'].toString('utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || JSON.parse(extension['manifest.json'].toString('utf8')).version !== version) throw Error('Extension/application version mismatch');
  return { source, extension, version };
}
function verifyBundle(bytes, expected) {
  if (bytes.length > MAX_BYTES) throw Error('Release bundle size limit');
  const seen = new Set(); let total = 0;
  const entries = unzipSync(bytes, { filter(file) {
    if (!safe(file.name) || !Object.hasOwn(expected, file.name) || seen.has(file.name)) throw Error('Release bundle entry violates allowlist');
    seen.add(file.name); total += file.originalSize;
    if (file.originalSize > MAX_BYTES || total > MAX_BYTES) throw Error('Release bundle expanded size limit');
    return true;
  } });
  if (Object.keys(entries).length !== Object.keys(expected).length) throw Error('Release bundle content differs from source');
  for (const [name, data] of Object.entries(entries)) if (!Buffer.from(data).equals(expected[name])) throw Error(`Release bundle bytes differ: ${name}`);
  return { files: Object.keys(entries).length, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function createReleaseBundles({ root, outDir }) {
  root = await fs.realpath(root); const maps = await sourceMaps(root); await fs.mkdir(outDir, { recursive: true }); const results = [];
  const bundles = ['source', 'extension'].map(kind => { const bytes = zipSync(maps[kind], { level: 6, mtime: new Date(1980, 0, 1) }); return { name: `FlowDM-${maps.version}-${kind}.zip`, bytes, verified: verifyBundle(bytes, maps[kind]) }; });
  for (const bundle of bundles) { await fs.writeFile(path.join(outDir, bundle.name), bundle.bytes, { flag: 'wx' }); results.push({ name: bundle.name, ...bundle.verified }); }
  return results;
}
async function verifyReleaseBundles({ root, outDir }) {
  root = await fs.realpath(root); const maps = await sourceMaps(root); const results = [];
  for (const kind of ['source', 'extension']) { const name = `FlowDM-${maps.version}-${kind}.zip`; results.push({ name, ...verifyBundle(await fs.readFile(path.join(outDir, name)), maps[kind]) }); }
  return results;
}
module.exports = { createReleaseBundles, verifyReleaseBundles };
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const operation = process.argv[2] === '--verify' ? verifyReleaseBundles : createReleaseBundles;
  operation({ root, outDir: path.join(root, 'dist') }).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
