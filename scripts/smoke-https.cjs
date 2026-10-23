const { DownloadManager } = require('../src/core/download-manager.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-https-'));
  const manager = new DownloadManager({ dataDir: path.join(root, 'state'), downloadDir: path.join(root, 'downloads') });
  try {
    const url = 'https://www.rfc-editor.org/rfc/rfc9110.txt';
    const reference = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
    await manager.init(); const task = await manager.add({ url, connections: 4 });
    const deadline = Date.now() + 60000; let final;
    while (Date.now() < deadline) {
      final = manager.list().find(t => t.id === task.id);
      if (['completed', 'failed'].includes(final.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (final.status !== 'completed') throw new Error(final.error || 'HTTPS smoke timed out');
    const actual = await fs.readFile(final.path);
    if (!actual.equals(reference)) throw new Error('HTTPS byte comparison failed');
    const report = { url, bytes: actual.length, sha256: crypto.createHash('sha256').update(actual).digest('hex'), segments: final.segments.length, status: final.status, platform: process.platform, at: new Date().toISOString() };
    await fs.mkdir('test-results', { recursive: true }); await fs.writeFile('test-results/https-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
