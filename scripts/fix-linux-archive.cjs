// Windows tar packagers lose POSIX executable bits. Repair only tar metadata,
// preserving payload bytes; native Linux builds are checked by the same hook.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
async function fixArchive(filename) {
  let pending = Buffer.alloc(0); let payloadBlocks = 0; let fixed = 0;
  const patch = new Transform({ transform(chunk, _encoding, callback) {
    try {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 512) {
        const block = Buffer.from(pending.subarray(0, 512)); pending = pending.subarray(512);
        if (payloadBlocks) payloadBlocks--;
        else if (block.some(byte => byte !== 0)) {
          const name = block.toString('utf8', 0, 100).split('\0')[0];
          const size = parseInt(block.toString('ascii', 124, 136).replace(/\0/g, '').trim(), 8) || 0;
          payloadBlocks = Math.ceil(size / 512);
          const base = name.split('/').pop();
          if (['flowdm', 'chrome-sandbox', 'chrome_crashpad_handler'].includes(base)) {
            block.write('0000755\0', 100, 8, 'ascii'); block.fill(32, 148, 156);
            const sum = block.reduce((total, byte) => total + byte, 0);
            block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); fixed++;
          }
        }
        this.push(block);
      }
      callback();
    } catch (error) { callback(error); }
  }, flush(callback) { callback(pending.length ? new Error('Incomplete tar block') : null); } });
  const temporary = `${filename}.modes.tmp`;
  try {
    await pipeline(fs.createReadStream(filename), zlib.createGunzip(), patch, zlib.createGzip({ level: 6 }), fs.createWriteStream(temporary, { flags: 'wx' }));
    if (fixed !== 3) throw new Error(`Expected 3 Linux executables, found ${fixed}`);
    fs.renameSync(temporary, filename);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  console.log(`Verified executable modes in ${path.basename(filename)}`);
}
module.exports = async context => { for (const filename of context.artifactPaths) if (filename.endsWith('.tar.gz')) await fixArchive(filename); return []; };
module.exports.fixArchive = fixArchive;
if (require.main === module) fixArchive(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
