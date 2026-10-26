'use strict';
const path = require('node:path');
const GROUPS = {
  Programs: /\.(exe|msi|com|bat|cmd|ps1|sh|appimage|deb|rpm|dmg|pkg)$/i,
  Archives: /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i,
  Videos: /\.(mp4|mkv|webm|mov|avi|ts|m3u8|mpd)$/i,
  Music: /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i,
  Images: /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i,
  Documents: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub|odt|rtf)$/i
};
function categoryFor({ filename, mime = '' }) {
  if (typeof filename !== 'string' || !filename || /[<>:"/\\|?*\x00-\x1f]/.test(filename) || filename === '..' || filename === '.') throw Error('Unsafe category filename');
  const type = String(mime).split(';')[0].trim().toLowerCase();
  if (GROUPS.Programs.test(filename) || /(?:x-msdownload|x-msdos-program|x-executable|x-sh|x-powershell)/.test(type)) return 'Programs';
  for (const [name, pattern] of Object.entries(GROUPS)) if (pattern.test(filename)) return name;
  if (type.startsWith('video/')) return 'Videos';
  if (type.startsWith('audio/')) return 'Music';
  if (type.startsWith('image/')) return 'Images';
  if (type === 'application/pdf' || type.startsWith('text/')) return 'Documents';
  return 'Other';
}
function categoryDestination({ filename, mime, root, enabled, directory }) {
  if (!enabled) return {};
  const category = categoryFor({ filename, mime });
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('Absolute category root required');
  if (directory !== undefined) return { category, directory };
  const destination = path.resolve(root, category);
  if (path.dirname(destination) !== path.resolve(root)) throw Error('Category escaped root');
  return { category, directory: destination };
}
module.exports = { categoryFor, categoryDestination };
