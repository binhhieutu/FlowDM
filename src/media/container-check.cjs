'use strict';
// Streaming framing checks only: no payload retention, decoding or codec claims.
function createValidator(format, maxBytes) {
  if (format === 'ts') {
    let position = 0;
    return {
      push(chunk) {
        for (let offset = (188 - position % 188) % 188; offset < chunk.length; offset += 188) {
          if (chunk[offset] !== 0x47) throw Error('Unsupported or invalid MPEG-TS packet synchronization');
        }
        position += chunk.length;
      },
      finish() { if (!position || position % 188) throw Error('Truncated or empty MPEG-TS packet stream'); }
    };
  }
  const initialization = format === 'mp4-init';
  const allowed = initialization ? new Set(['ftyp', 'moov', 'free', 'skip']) : new Set(['styp', 'sidx', 'moof', 'mdat', 'emsg', 'prft', 'free', 'skip']);
  const seen = new Set(); const header = Buffer.alloc(16);
  let buffered = 0, headerSize = 8, remaining = 0, boxes = 0;
  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining) { const count = Math.min(remaining, chunk.length - offset); remaining -= count; offset += count; continue; }
        const count = Math.min(headerSize - buffered, chunk.length - offset);
        chunk.copy(header, buffered, offset, offset + count); buffered += count; offset += count;
        if (buffered < headerSize) continue;
        const shortSize = header.readUInt32BE(0);
        if (shortSize === 1 && headerSize === 8) { headerSize = 16; continue; }
        const size = shortSize === 1 ? Number(header.readBigUInt64BE(8)) : shortSize;
        const type = header.toString('latin1', 4, 8);
        if (!Number.isSafeInteger(size) || size < headerSize || size > maxBytes || !allowed.has(type)) throw Error('Unsupported or invalid MP4 box');
        if (!boxes && (initialization ? type !== 'ftyp' : !['styp', 'sidx', 'moof'].includes(type))) throw Error('Invalid MP4 first box');
        if (type === 'mdat' && !seen.has('moof')) throw Error('MP4 fragment data has no preceding moof');
        seen.add(type); boxes++; remaining = size - headerSize; buffered = 0; headerSize = 8;
      }
    },
    finish() {
      if (buffered || remaining || !seen.has(initialization ? 'ftyp' : 'moof') || !seen.has(initialization ? 'moov' : 'mdat')) throw Error('Truncated or incomplete MP4 container');
    }
  };
}
module.exports = { createValidator };
