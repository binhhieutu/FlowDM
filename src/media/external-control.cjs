'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const native = format => ['http_dash_segments', 'm3u8_native', 'dash'].includes(format.protocol);
const http = format => ['http', 'https'].includes(format.protocol);
const hasVideo = format => !!format.vcodec && format.vcodec !== 'none';
const hasAudio = format => !!format.acodec && format.acodec !== 'none';
function externalResizeControl(metadata, directory) {
  const formats = metadata?.requested_formats || (metadata ? [metadata] : []);
  const allNative = formats.length > 0 && formats.every(native);
  const safeMixed = formats.length === 2 && formats.some(format => native(format) && hasVideo(format) && format.ext === 'mp4') && formats.some(format => http(format) && !hasVideo(format) && hasAudio(format) && format.ext === 'm4a');
  const eligible = !!directory && (allNative || safeMixed);
  const reason = eligible ? '' : 'This format cannot safely change connections while downloading';
  return { eligible, reason, canResize: async () => {
    if (!eligible) return { allowed: false, reason };
    try {
      const names = await fs.readdir(directory);
      let completedVideo = false, ready = false;
      for (const name of names) {
        const stat = await fs.lstat(path.join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Unsafe active media workspace');
        if (name.endsWith('.mp4') && stat.size > 0) completedVideo = true;
      }
      for (const name of names) {
        if (!name.endsWith('.part') || /-Frag\d+\.part$/.test(name)) continue;
        const journal = name.slice(0, -5) + '.ytdl';
        if (!names.includes(journal)) {
          if (safeMixed && name.endsWith('.m4a.part') && completedVideo) { ready = true; continue; }
          throw Error('The current resource has not committed a resumable checkpoint yet');
        }
        const filename = path.join(directory, journal);
        if ((await fs.stat(filename)).size > 4 * 1024 * 1024) throw Error('Invalid native journal');
        const state = JSON.parse(await fs.readFile(filename, 'utf8'));
        const index = state.downloader?.current_fragment?.index;
        if (!Number.isSafeInteger(index) || index < 0 || index > 10000) throw Error('Incomplete native journal');
        ready = true;
      }
      if (!ready) throw Error('Wait until an active media checkpoint is ready');
      return { allowed: true, reason: '' };
    } catch { return { allowed: false, reason: 'Wait for a complete native checkpoint before changing connections' }; }
  } };
}
module.exports = { externalResizeControl };
