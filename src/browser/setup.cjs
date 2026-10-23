const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { createHostBundle } = require('../bridge/install.cjs');
const { createRegistration, registrationTarget } = require('./registration.cjs');
async function verifyRuntime(executable) {
  const result = await execFile(executable, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15000 });
  const versions = JSON.parse(result.stdout.trim());
  if (Number(versions.node.split('.')[0]) < 22) throw new Error('Native host cần Node 22 trở lên.');
  return versions;
}
async function prepareHostRuntime({ executablePath, directory, platform = process.platform }) {
  const versions = await verifyRuntime(executablePath);
  if (platform !== 'win32' || !versions.electron) return { nodePath: executablePath, electron: !!versions.electron };
  const parent = path.dirname(executablePath);
  const digest = crypto.createHash('sha256').update(await fs.readFile(executablePath)).digest('hex').slice(0, 16);
  const destination = path.join(directory, `runtime-${digest}`);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [source, target] of [[path.basename(executablePath), 'FlowDMHost.exe'], ['icudtl.dat', 'icudtl.dat'], ['snapshot_blob.bin', 'snapshot_blob.bin'], ['v8_context_snapshot.bin', 'v8_context_snapshot.bin']]) {
    const from = path.join(parent, source); const to = path.join(destination, target);
    const expected = await fs.readFile(from);
    let same = false; try { same = (await fs.readFile(to)).equals(expected); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!same) await fs.writeFile(to, expected, { mode: 0o700 });
  }
  for (const name of ['LICENSE.electron.txt', 'LICENSE', 'LICENSES.chromium.html']) {
    try { await fs.copyFile(path.join(parent, name), path.join(destination, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const nodePath = path.join(destination, 'FlowDMHost.exe'); await verifyRuntime(nodePath);
  return { nodePath, electron: true };
}
function createBrowserSetup({ appDir, dataDir, userDataDir, executablePath, platform = process.platform, registration = createRegistration({ platform }) }) {
  const extensionPath = path.join(userDataDir, 'browser-extension');
  const statePath = path.join(userDataDir, 'browser-setup.json');
  let mutation = Promise.resolve();
  const serialize = operation => { const result = mutation.catch(() => {}).then(operation); mutation = result; return result; };
  const load = async () => { try { return JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { browsers: {} }; throw error; } };
  const save = async state => {
    await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 }); const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, statePath); } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  const equal = (left, right) => left.exists === right.exists && (!left.exists || left.value === right.value);
  async function recover() {
    const state = await load(); const pending = state.pending;
    if (!pending) return state;
    registrationTarget(pending.browser, platform);
    const current = await registration.read(pending.browser);
    if (!equal(current, pending.before) && !equal(current, pending.after)) throw new Error('Đăng ký host thay đổi bên ngoài trong lúc khôi phục. Không ghi đè thay đổi đó.');
    const browsers = equal(current, pending.after) ? pending.nextBrowsers : state.browsers;
    const recovered = { browsers }; await save(recovered); return recovered;
  }
  async function info() {
    const state = await recover();
    const browsers = await Promise.all(Object.entries(state.browsers).map(async ([browser, item]) => {
      const current = await registration.read(browser);
      return { browser, extensionId: item.extensionId, connected: current.exists && current.value === item.current };
    }));
    return { extensionPath, connected: browsers.some(item => item.connected), browsers, platform };
  }
  async function prepareExtension() {
    await fs.mkdir(extensionPath, { recursive: true, mode: 0o700 });
    const source = path.join(appDir, 'extension');
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:json|js|css|html|png)$/.test(entry.name)) throw new Error('Unexpected extension asset');
      await fs.copyFile(path.join(source, entry.name), path.join(extensionPath, entry.name));
    }
    return extensionPath;
  }
  async function connect({ extensionId, browser }) {
    return serialize(async () => {
      if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('ID tiện ích phải có 32 ký tự a–p.');
      registrationTarget(browser, platform);
      const state = await recover(); const original = state.browsers[browser];
      const previous = original ? original.previous : await registration.read(browser);
      if (original && JSON.stringify(await registration.read(browser)) !== JSON.stringify({ exists: true, value: original.current })) throw new Error('Đăng ký host đã thay đổi ngoài FlowDM.');
      await prepareExtension();
      const runtime = await prepareHostRuntime({ executablePath, directory: path.join(userDataDir, 'browser-host-runtime'), platform });
      const output = path.join(userDataDir, 'browser-host', crypto.randomUUID());
      const bundle = await createHostBundle({ output, dataDir, extensionId, ...runtime });
      const current = platform === 'win32' ? bundle.manifestPath : await fs.readFile(bundle.manifestPath, 'utf8');
      const nextBrowsers = { ...state.browsers, [browser]: { extensionId, previous, current } };
      await save({ ...state, pending: { browser, before: original ? { exists: true, value: original.current } : previous, after: { exists: true, value: current }, nextBrowsers } });
      await registration.set(browser, current);
      try { await save({ browsers: nextBrowsers }); }
      catch (error) { const rollback = original ? { exists: true, value: original.current } : previous; if (rollback.exists) await registration.set(browser, rollback.value); else await registration.remove(browser); throw error; }
      return { ...(await info()), manifestPath: bundle.manifestPath };
    });
  }
  async function disconnect(browser) {
    return serialize(async () => {
      registrationTarget(browser, platform); const state = await recover(); const existing = state.browsers[browser]; if (!existing) return info();
      const current = await registration.read(browser);
      if (!current.exists || current.value !== existing.current) throw new Error('Đăng ký host đã thay đổi ngoài FlowDM. Không ghi đè thay đổi đó.');
      const browsers = { ...state.browsers }; delete browsers[browser];
      await save({ ...state, pending: { browser, before: current, after: existing.previous, nextBrowsers: browsers } });
      if (existing.previous.exists) await registration.set(browser, existing.previous.value); else await registration.remove(browser);
      try { await save({ browsers }); } catch (error) { await registration.set(browser, existing.current); throw error; }
      return info();
    });
  }
  return { info: () => serialize(info), prepareExtension: () => serialize(prepareExtension), connect, disconnect, waitForIdle: () => mutation.catch(() => {}) };
}
module.exports = { createBrowserSetup, prepareHostRuntime };
