// Combine real Node/main-process and Chromium renderer V8 coverage.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const c8 = require.resolve('c8/bin/c8.js');
const temporary = name => path.join(root, '.tmp', name);
const unit = temporary('coverage-unit'); const desktop = temporary('coverage-desktop'); const merged = temporary('coverage-merged');
for (const directory of [unit, desktop, merged]) {
  if (!directory.startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Unsafe coverage directory');
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true });
}
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const files = ['core', 'bridge'].flatMap(group => fs.readdirSync(path.join(root, 'tests', group)).filter(file => file.endsWith('.test.cjs')).map(file => `tests/${group}/${file}`));
run([c8, `--temp-directory=${unit}`, '--include=src/core/**', '--include=src/bridge/**', '--all', '--reporter=json-summary', process.execPath, '--test', ...files]);
run(['--test', '--test-concurrency=1', 'tests/e2e/desktop.test.cjs'], { ...process.env, FLOWDM_COVERAGE_DIR: desktop });
for (const directory of [unit, desktop]) for (const file of fs.readdirSync(directory)) {
  if (file.startsWith('coverage-') && file.endsWith('.json')) fs.copyFileSync(path.join(directory, file), path.join(merged, file));
}
run([c8, 'report', `--temp-directory=${merged}`, '--include=src/**', '--all', '--reporter=text', '--reporter=json-summary', '--reporter=lcov', '--check-coverage', '--lines=80', '--statements=80', '--branches=80', '--functions=80']);
