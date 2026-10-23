// Explicit build-time preparation only. The application never downloads/updates executables.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const lock = require('../assets/media-tools.json');
async function verifiedBytes(file, expected) {
  const data = await fs.readFile(file);
  if (data.length !== expected.bytes || crypto.createHash('sha256').update(data).digest('hex') !== expected.sha256) throw Error(`Pinned binary mismatch: ${expected.file}`);
  return data;
}
(async () => {
  if (process.platform !== 'win32') throw Error('Windows bundle preparation only; install yt-dlp and FFmpeg on PATH for Linux/macOS.');
  const root = path.resolve(__dirname, '../vendor/media-tools'); await fs.mkdir(path.join(root, 'licenses'), { recursive: true });
  const ytdlp = lock.entries.ytDlp;
  const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/download/${ytdlp.version}/${ytdlp.file}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Tool download HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== ytdlp.bytes || crypto.createHash('sha256').update(data).digest('hex') !== ytdlp.sha256) throw Error('yt-dlp release hash mismatch');
  await fs.writeFile(path.join(root, ytdlp.file), data);
  const aria = lock.entries.aria2c;
  const archiveResponse = await fetch(aria.archiveUrl, { signal: AbortSignal.timeout(60000) });
  if (!archiveResponse.ok) throw Error(`aria2 download HTTP ${archiveResponse.status}`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (crypto.createHash('sha256').update(archive).digest('hex') !== aria.archiveSha256) throw Error('aria2 archive hash mismatch');
  const temporary = await fs.mkdtemp(path.join(root, 'aria2-prepare-'));
  try {
    const zip = path.join(temporary, 'aria2.zip'); await fs.writeFile(zip, archive);
    await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:FLOWDM_PREPARE_ZIP -DestinationPath $env:FLOWDM_PREPARE_OUT -ErrorAction Stop'], { windowsHide: true, env: { ...process.env, FLOWDM_PREPARE_ZIP: zip, FLOWDM_PREPARE_OUT: path.join(temporary, 'extracted') } });
    const directory = path.join(temporary, 'extracted', 'aria2-1.37.0-win-64bit-build1');
    await fs.writeFile(path.join(root, aria.file), await verifiedBytes(path.join(directory, aria.file), aria));
    await fs.copyFile(path.join(directory, 'COPYING'), path.join(root, 'licenses/aria2-GPLv2.txt'));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  const directories = (process.env.PATH || process.env.Path || '').split(';');
  let ffmpeg = process.argv[2];
  if (!ffmpeg) for (const directory of directories) { const candidate = path.join(directory, 'ffmpeg.exe'); try { if ((await fs.stat(candidate)).isFile()) { ffmpeg = candidate; break; } } catch {} }
  if (!ffmpeg || !path.isAbsolute(ffmpeg)) throw Error('Pass an absolute path to the pinned Gyan FFmpeg 8.1 full-build executable.');
  await fs.writeFile(path.join(root, 'ffmpeg.exe'), await verifiedBytes(ffmpeg, lock.entries.ffmpeg));
  const license = path.resolve(ffmpeg, '../../LICENSE'); await fs.copyFile(license, path.join(root, 'licenses/FFmpeg-GPLv3.txt'));
  for (const file of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    const result = await fetch(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytdlp.version}/${file}`, { signal: AbortSignal.timeout(30000) });
    if (!result.ok) throw Error(`License download HTTP ${result.status}`);
    await fs.writeFile(path.join(root, 'licenses', `yt-dlp-${file}.txt`), await result.text());
  }
  await fs.copyFile(path.resolve(__dirname, '../docs/MEDIA_TOOLS.md'), path.join(root, 'licenses/PROVENANCE.md'));
  console.log(`Verified pinned media tools in ${root}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
