// Deterministic own-brand icon; no external fonts, images or dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]); const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data)); return Buffer.concat([len, data, crc]);
}
const size = 256; const rgba = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const at = y * (1 + size * 4) + 1 + x * 4;
  const cx = Math.max(34 - x, x - 221, 0); const cy = Math.max(34 - y, y - 221, 0);
  const inside = cx * cx + cy * cy < 34 * 34;
  const arrow = (x >= 111 && x <= 145 && y >= 51 && y <= 144) || (y >= 120 && y <= 185 && Math.abs(x - 128) <= 185 - y);
  const line = x >= 69 && x <= 187 && y >= 198 && y <= 209;
  const color = arrow || line ? [129, 227, 216] : [22, 50, 79];
  rgba.set([...color, inside ? 255 : 0], at);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rgba)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
const dir = path.join(__dirname, '../assets'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png); fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([ico, png]));
