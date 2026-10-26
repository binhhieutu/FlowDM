// Runs only on the real target OS; archive integrity alone never counts as native verification.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { assertNativeArtifact } = require('./native-target.cjs');
const args = process.argv.slice(2);
const platform = args[1];
function blocked(message) { console.error(message); process.exit(2); }
if (args.length !== 2 || args[0] !== '--platform' || !['linux', 'darwin'].includes(platform)) blocked('Usage: --platform linux|darwin');
if (platform !== process.platform) blocked(`Native host required: requested ${platform}, actual platform ${process.platform}`);
if (process.getuid() === 0) blocked('Native host must run as an unprivileged user');
if (platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) blocked('Native GUI display is unavailable');
if (process.env.ELECTRON_DISABLE_SANDBOX || /--no-sandbox|--disable-setuid-sandbox/.test(process.env.NODE_OPTIONS || '')) blocked('Sandbox-disabling environment is forbidden');
const executable = process.env.FLOWDM_EXECUTABLE;
const root = path.resolve(__dirname, '..'); process.chdir(root);
let artifact;
try { artifact = assertNativeArtifact({ root, platform, arch: process.arch, executable }); }
catch (error) { blocked(error.message); }
const sha256 = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const originalExecutableHash = sha256(executable); const originalAsarHash = sha256(artifact.archive);
const out = path.join(root, 'test-results', `native-${platform}-${process.arch}`); fs.mkdirSync(out, { recursive: true });
const target = artifact.target;
const report = { at: new Date().toISOString(), version: require('../package.json').version, platform, arch: process.arch, release: os.release(), wsl2: /microsoft.*wsl2/i.test(os.release()), status: 'running', cases: [] };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'FLOWDM_LIVE_YOUTUBE', 'FLOWDM_TEST_YOUTUBE', 'FLOWDM_COVERAGE_DIR'].includes(key.toUpperCase())));
env.FLOWDM_EXPECTED_ASAR_SHA = originalAsarHash;
const cases = [
  ['integrity', ['scripts/verify-package.cjs', '--platform', target]],
  ['platform-unit', ['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/tools/platform-tools.test.cjs', 'tests/tools/media-tools.test.cjs', 'tests/browser/platform-registration.test.cjs', 'tests/tools/package-platform.test.cjs', 'tests/tools/native-runner.test.cjs']],
  ['sandbox', ['--test', '--test-reporter=tap', 'tests/e2e/platform-smoke.test.cjs']],
  ['http-resume', ['--test', '--test-reporter=tap', 'tests/e2e/desktop.test.cjs']],
  ['media-resume', ['--test', '--test-reporter=tap', 'tests/e2e/media-resume.test.cjs']],
  ['browser-capture', ['--test', '--test-reporter=tap', 'tests/e2e/browser.test.cjs']]
];
for (const [name, command] of cases) {
  const filename = path.join(out, `${name}.txt`); const log = fs.openSync(filename, 'w');
  const started = Date.now(); let result;
  try { result = spawnSync(process.execPath, command, { cwd: root, env, stdio: ['ignore', log, log], timeout: 300000 }); }
  finally { fs.closeSync(log); }
  const text = fs.readFileSync(filename, 'utf8');
  const pass = Number(/^# pass (\d+)$/m.exec(text)?.[1] || 0);
  const skip = Number(/^# skipped (\d+)$/m.exec(text)?.[1] || 0);
  const unchanged = sha256(executable) === originalExecutableHash && sha256(artifact.archive) === originalAsarHash;
  const ok = result.status === 0 && !result.error && unchanged && (name === 'integrity' || pass > 0);
  report.cases.push({ name, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started, pass, skipped: skip, status: ok ? 'passed' : 'failed' });
  console.log(`${name}: ${ok ? 'PASS' : 'FAIL'} (${pass} passed, ${skip} skipped)`);
  if (name === 'integrity' && ok) report.package = JSON.parse(text);
  if (!ok) { report.status = 'failed'; console.error(text.slice(-8000)); break; }
}
if (report.status === 'running') report.status = 'passed';
report.finishedAt = new Date().toISOString();
report.executableSha256 = sha256(executable); report.asarSha256 = sha256(artifact.archive);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
