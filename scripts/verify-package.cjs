const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const manifest = [];
function walk(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
}
for (const platform of ['win-unpacked', 'linux-unpacked']) {
  const archive = path.join(root, 'dist', platform, 'resources', 'app.asar');
  let verified = 0;
  for (const filename of [...walk('src'), ...walk('assets'), ...walk('extension')]) {
    const actual = asar.extractFile(archive, filename.split('/').join(path.sep)); const expected = fs.readFileSync(path.join(root, filename));
    if (!actual.equals(expected)) throw new Error(`${platform}: stale or corrupted ${filename}`);
    verified++;
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  const source = require('../package.json');
  if (packaged.version !== source.version || packaged.main !== source.main || packaged.name !== source.name) throw new Error('Packaged metadata mismatch');
  manifest.push({ platform, filesVerified: verified, asarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') });
}
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', 'package-verification.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
