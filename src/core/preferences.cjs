'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateScanner } = require('../tools/post-download.cjs');
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Invalid preferences'); }
class Preferences {
  constructor(dataDir, downloadDir) {
    this.filename = path.join(dataDir, 'preferences.json');
    this.value = { categories: { enabled: false, root: downloadDir }, scanner: { enabled: false, executable: null, args: [], timeoutMs: 60000 }, clipboard: { enabled: false }, duplicateWarnings: true };
  }
  validate(input) {
    exact(input, ['categories', 'scanner', 'clipboard', 'duplicateWarnings']);
    exact(input.categories, ['enabled', 'root']); exact(input.clipboard, ['enabled']);
    if (typeof input.categories.enabled !== 'boolean' || typeof input.categories.root !== 'string' || !path.isAbsolute(input.categories.root) || typeof input.clipboard.enabled !== 'boolean' || typeof input.duplicateWarnings !== 'boolean') throw Error('Invalid preference values');
    exact(input.scanner, ['enabled', 'executable', 'args', 'timeoutMs']);
    if (typeof input.scanner.enabled !== 'boolean') throw Error('Invalid scanner opt-in');
    const scanner = !input.scanner.enabled && input.scanner.executable === null ? { enabled: false, executable: null, args: [], timeoutMs: 60000 } : validateScanner(input.scanner);
    return { categories: { enabled: input.categories.enabled, root: path.resolve(input.categories.root) }, scanner, clipboard: { enabled: input.clipboard.enabled }, duplicateWarnings: input.duplicateWarnings };
  }
  async init() {
    try { const saved = JSON.parse(await fs.readFile(this.filename, 'utf8')); if (saved.version !== 1) throw Error('Unsupported preferences'); this.value = this.validate(saved.settings); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() { return structuredClone(this.value); }
  async update(input) {
    const next = this.validate(input), temporary = this.filename + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, settings: next })); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filename); this.value = next;
    } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return this.snapshot();
  }
}
module.exports = { Preferences };
