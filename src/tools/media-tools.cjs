const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const pinned = require('../../assets/media-tools.json');
const verified = new Map();

async function resolveTools({ env = process.env, platform = process.platform, resourcesPath = process.resourcesPath, appDir = path.resolve(__dirname, '../..'), executablePath = process.execPath, packaged = Boolean(process.resourcesPath && !process.defaultApp), lockManifest = pinned } = {}) {
  const windows = platform === 'win32';
  if (packaged && windows && (env.FLOWDM_YTDLP || env.FLOWDM_FFMPEG || env.FLOWDM_ARIA2C)) throw new Error('Packaged media tools cannot be overridden');
  const directories = [resourcesPath && path.join(resourcesPath, 'media-tools'), windows && path.join(appDir, 'vendor', 'media-tools'), ...(env.PATH || env.Path || '').split(windows ? ';' : ':')].filter(Boolean);
  async function find(name, override) {
    if (override && !path.isAbsolute(override)) throw new Error(`${name}: configured tool path must be absolute`);
    const candidates = packaged && windows ? [path.join(resourcesPath, 'media-tools', name + '.exe')] : override ? [override] : directories.map(directory => path.join(directory, name + (windows ? '.exe' : '')));
    for (const filename of candidates) {
      if (!path.isAbsolute(filename)) continue;
      try { if ((await fs.stat(filename)).isFile()) return filename; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    throw new Error(`${name}: không tìm thấy executable file. Cài yt-dlp và FFmpeg hoặc dùng bản Windows có kèm công cụ media.`);
  }
  const tools = { ytDlp: await find('yt-dlp', env.FLOWDM_YTDLP), ffmpeg: await find('ffmpeg', env.FLOWDM_FFMPEG), aria2c: await find('aria2c', env.FLOWDM_ARIA2C), jsRuntime: executablePath };
  if (packaged && windows) {
    for (const key of ['ytDlp', 'ffmpeg', 'aria2c']) {
      const stat = await fs.stat(tools[key]); const expected = lockManifest.entries[key];
      const cacheKey = `${tools[key]}:${stat.mtimeMs}:${stat.size}:${expected.sha256}`;
      if (!verified.has(cacheKey)) {
        const hash = crypto.createHash('sha256'); for await (const chunk of createReadStream(tools[key])) hash.update(chunk);
        if (hash.digest('hex') !== expected.sha256 || stat.size !== expected.bytes) throw new Error(`${key}: bundled media tool integrity check failed`);
        verified.set(cacheKey, true);
      }
    }
  }
  return tools;
}
async function mediaToolStatus(options) {
  try { await resolveTools(options); return { ready: true }; }
  catch (error) { return { ready: false, error: error.message }; }
}
module.exports = { resolveTools, mediaToolStatus };
