const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// Generate checksums only after all three release artifacts have been created.
(async () => {
  const root = path.resolve(__dirname, '..'); const names = ['FlowDM 0.1.0.exe', 'flowdm-0.1.0.tar.gz', 'FlowDM-0.1.0-source.zip'];
  const rows = [];
  for (const name of names) { const file = await fs.readFile(path.join(root, 'dist', name)); rows.push({ name, bytes: file.length, sha256: crypto.createHash('sha256').update(file).digest('hex') }); }
  await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS.txt'), rows.map(row => `${row.sha256}  ${row.name}`).join('\n') + '\n');
  console.log(JSON.stringify(rows, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
