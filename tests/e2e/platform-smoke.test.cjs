const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { _electron } = require('playwright');
const { resolveTools } = require('../../src/tools/media-tools.cjs');
const { assertNativeArtifact } = require('../../scripts/native-target.cjs');

test('native desktop platform, media executables and sandbox remain enabled', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 90000 }, async t => {
  assert.notEqual(process.getuid(), 0, 'Native desktop tests must run as an unprivileged user');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-native-smoke-'));
  let app;
  t.after(async () => { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const executablePath = process.env.FLOWDM_EXECUTABLE;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  app = await _electron.launch({ chromiumSandbox: true, ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.resolve('.')], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'downloads') } });
  const page = await app.firstWindow(); await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).waitFor();
  const actual = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { platform: process.platform, arch: process.arch, version: app.getVersion(), electron: process.versions.electron, executable: process.execPath, appPath: app.getAppPath(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'), disableSetuidSandbox: app.commandLine.hasSwitch('disable-setuid-sandbox'),
      sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.equal(actual.platform, process.platform); assert.equal(actual.arch, process.arch);
  assert.equal(actual.version, require('../../package.json').version);
  let asarSha256 = null;
  if (executablePath) {
    const artifact = assertNativeArtifact({ root: path.resolve('.'), platform: process.platform, arch: process.arch, executable: actual.executable, appPath: actual.appPath, version: actual.version, expectedVersion: require('../../package.json').version });
    asarSha256 = crypto.createHash('sha256').update(await fs.readFile(artifact.archive)).digest('hex');
    if (process.env.FLOWDM_EXPECTED_ASAR_SHA) assert.equal(asarSha256, process.env.FLOWDM_EXPECTED_ASAR_SHA);
  }
  assert.equal(actual.noSandbox, false, 'Harness must not disable Chromium sandbox');
  assert.equal(actual.disableSetuidSandbox, false);
  assert.equal(actual.sandbox, true); assert.equal(actual.contextIsolation, true); assert.equal(actual.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const tools = await resolveTools({ packaged: false }); const versions = {};
  for (const [name, args] of [['ytDlp', ['--version']], ['ffmpeg', ['-version']], ['aria2c', ['--version']]]) {
    const result = await execFile(tools[name], args, { timeout: 15000, maxBuffer: 65536 });
    versions[name] = { version: result.stdout.split(/\r?\n/)[0], sha256: crypto.createHash('sha256').update(await fs.readFile(tools[name])).digest('hex') };
  }
  const report = { at: new Date().toISOString(), os: { platform: process.platform, arch: process.arch, release: os.release(), wsl2: /microsoft.*wsl2/i.test(os.release()) }, packaged: !!executablePath, ...actual, asarSha256, tools: versions };
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/platform-${process.platform}-${process.arch}.png` });
  await fs.writeFile(`test-results/platform-${process.platform}-${process.arch}.json`, JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
});
