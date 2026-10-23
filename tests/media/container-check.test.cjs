const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createValidator } = require('../../src/media/container-check.cjs');
function box(type, payload = Buffer.alloc(4)) { const b = Buffer.alloc(8); b.writeUInt32BE(8 + payload.length); b.write(type, 4, 'ascii'); return Buffer.concat([b, payload]); }
function ts(value = 1) { const b = Buffer.alloc(188, value); b[0] = 0x47; return b; }
function check(type, chunks) { const v = createValidator(type, 1024 ** 2); for (const b of chunks) v.push(b); v.finish(); }
test('TS validator checks every packet sync and alignment across arbitrary chunks', () => {
  const bytes = Buffer.concat([ts(1), ts(2)]); check('ts', [bytes.subarray(0, 1), bytes.subarray(1, 190), bytes.subarray(190)]);
  for (const bytes of [Buffer.from('<html>login</html>'), Buffer.from([0xff, 0xf1, 0x50, 0x80]), ts().subarray(0, 187), Buffer.concat([ts(), Buffer.alloc(188)]), Buffer.alloc(0)]) assert.throws(() => check('ts', [bytes]), /MPEG-TS/);
});
test('BMFF validator checks bounded box headers and required initialization or fragment boxes', () => {
  const init = Buffer.concat([box('ftyp'), box('moov')]);
  check('mp4-init', Array.from(init, b => Buffer.from([b])));
  check('mp4-fragment', [Buffer.concat([box('styp'), box('sidx'), box('moof'), box('mdat')])]);
  check('mp4-fragment', [box('moof'), box('mdat')]);
  const extended = Buffer.alloc(16); extended.writeUInt32BE(1); extended.write('mdat', 4); extended.writeBigUInt64BE(20n, 8);
  check('mp4-fragment', [box('moof'), extended.subarray(0, 9), extended.subarray(9), Buffer.alloc(4)]);
  for (const bytes of [Buffer.from('<html>login</html>'), box('ftyp'), box('moov'), init.subarray(0, init.length - 1), box('moof'), Buffer.alloc(8), Buffer.from([0, 0, 0, 7, 109, 111, 111, 118]), Buffer.concat([extended.subarray(0, 8), Buffer.from('ffffffffffffffff', 'hex')])]) assert.throws(() => check('mp4-init', [bytes]), /MP4/);
  for (const bytes of [box('mdat'), box('moof'), box('ftyp'), Buffer.concat([box('moof'), box('mdat')]).subarray(0, 10)]) assert.throws(() => check('mp4-fragment', [bytes]), /MP4/);
});
module.exports = { box, ts };
