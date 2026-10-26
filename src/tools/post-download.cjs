'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
function validateScanner(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['enabled', 'executable', 'args', 'timeoutMs'].includes(k))) throw Error('Invalid scanner configuration');
  if (typeof input.executable !== 'string' || !path.isAbsolute(input.executable) || /[\x00-\x1f]/.test(input.executable) || (process.platform === 'win32' && path.extname(input.executable).toLowerCase() !== '.exe')) throw Error('Scanner requires an absolute executable path');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 16 || args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) throw Error('Invalid scanner argument array');
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw Error('Scanner timeout must be 100–300000 ms');
  return { enabled: input.enabled === true, executable: input.executable, args: [...args], timeoutMs };
}
async function scanFile(filename, input, { execute = execFile, signal } = {}) {
  const config = validateScanner(input);
  if (!config.enabled) return { status: 'skipped' };
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Scanner target must be a regular file');
  const args = config.args.map(arg => arg.replaceAll('{file}', filename));
  if (!config.args.some(arg => arg.includes('{file}'))) args.push(filename);
  try {
    await new Promise((resolve, reject) => execute(config.executable, args, { shell: false, windowsHide: true, timeout: config.timeoutMs, maxBuffer: 65536, ...(signal ? { signal } : {}) }, error => error ? reject(error) : resolve()));
    return { status: 'passed', at: new Date().toISOString() };
  } catch (error) {
    return { status: 'failed', at: new Date().toISOString(), error: signal?.aborted ? 'Scan cancelled or interrupted' : error.killed ? 'Scanner timed out' : `Scanner failed (${Number.isInteger(error.code) ? error.code : 'execution error'})` };
  }
}
module.exports = { validateScanner, scanFile };
