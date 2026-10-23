const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const BRANDS = { chrome: ['Google\\Chrome', 'google-chrome', 'Google/Chrome'], edge: ['Microsoft\\Edge', 'microsoft-edge', 'Microsoft Edge'], chromium: ['Chromium', 'chromium', 'Chromium'], testing: ['Google\\ChromeForTesting', 'google-chrome-for-testing', 'Google/ChromeForTesting'] };
function registrationTarget(browser, platform = process.platform, homeDir = os.homedir()) {
  if (!Object.hasOwn(BRANDS, browser)) throw new Error('Trình duyệt không được hỗ trợ.');
  const brand = BRANDS[browser];
  if (platform === 'win32') return `HKCU\\Software\\${brand[0]}\\NativeMessagingHosts\\local.flowdm.bridge`;
  return platform === 'darwin' ? path.join(homeDir, 'Library', 'Application Support', brand[2], 'NativeMessagingHosts', 'local.flowdm.bridge.json') : path.join(homeDir, '.config', brand[1], 'NativeMessagingHosts', 'local.flowdm.bridge.json');
}
function createRegistration({ platform = process.platform, homeDir = os.homedir(), exec = execFile } = {}) {
  const target = browser => registrationTarget(browser, platform, homeDir);
  return {
    async read(browser) {
      const location = target(browser);
      if (platform === 'win32') {
        let result;
        try { result = await exec('reg.exe', ['query', location, '/ve', '/reg:64'], { windowsHide: true, timeout: 5000 }); }
        catch (error) { if (error.code === 1) return { exists: false }; throw error; }
        // `/ve` prints a synthetic '(value not set)' REG_SZ for an empty key.
        // Compare the actual enumerated values rather than localized wording.
        const label = /^\s*(.*?)\s+REG_\w+/m.exec(result.stdout)?.[1];
        const all = await exec('reg.exe', ['query', location, '/reg:64'], { windowsHide: true, timeout: 5000 });
        if (label && !all.stdout.split(/\r?\n/).some(line => /^\s*(.*?)\s+REG_\w+/.exec(line)?.[1] === label)) return { exists: false };
        const match = /REG_SZ\s+([^\r\n]+)/.exec(result.stdout);
        if (!match) throw new Error('Đăng ký host hiện có không phải đường dẫn REG_SZ.');
        return { exists: true, value: match[1].trim() };
      }
      try { const stat = await fs.lstat(location); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Unsafe existing host manifest'); return { exists: true, value: await fs.readFile(location, 'utf8') }; }
      catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
    },
    async set(browser, value) {
      const location = target(browser);
      if (typeof value !== 'string' || value.length > 65536 || value.includes('\0')) throw new Error('Invalid registration');
      if (platform === 'win32') { await exec('reg.exe', ['add', location, '/ve', '/t', 'REG_SZ', '/d', value, '/f', '/reg:64'], { windowsHide: true, timeout: 5000 }); return; }
      await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      const temporary = `${location}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, location); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async remove(browser) {
      const location = target(browser);
      if (platform === 'win32') { try { await exec('reg.exe', ['delete', location, '/ve', '/f', '/reg:64'], { windowsHide: true, timeout: 5000 }); } catch (error) { if (error.code !== 1) throw error; } }
      else await fs.unlink(location).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
}
module.exports = { createRegistration, registrationTarget };
