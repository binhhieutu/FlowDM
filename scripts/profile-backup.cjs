const { createProfileSnapshot, restoreProfileSnapshot } = require('../src/tools/profile-snapshot.cjs');
const args = process.argv.slice(2);
async function main() {
  const [action, ...pairs] = args; const options = {};
  if (!['create', 'restore'].includes(action) || pairs.length % 2) throw Error('Usage: create --data-dir ABS --output NEW_ABS [--app-version X.Y.Z] | restore --snapshot ABS --output NEW_ABS --max-schema 1..8');
  const allowed = action === 'create' ? ['--data-dir', '--output', '--app-version'] : ['--snapshot', '--output', '--max-schema'];
  for (let index = 0; index < pairs.length; index += 2) { const key = pairs[index]; if (!allowed.includes(key) || Object.hasOwn(options, key)) throw Error('Invalid or repeated backup argument'); options[key] = pairs[index + 1]; }
  if (action === 'create') {
    const result = await createProfileSnapshot({ source: options['--data-dir'], destination: options['--output'], appVersion: options['--app-version'] || require('../package.json').version });
    console.log(JSON.stringify({ status: 'complete', journalVersion: result.journalVersion, files: result.files.length }));
  } else {
    const max = Number(options['--max-schema']); if (!Number.isInteger(max) || max < 1 || max > 8) throw Error('An explicit compatible maximum journal schema 1..8 is required');
    const result = await restoreProfileSnapshot({ snapshot: options['--snapshot'], destination: options['--output'], compatibleSchemas: Array.from({ length: max }, (_, index) => index + 1) });
    console.log(JSON.stringify({ status: 'complete', journalVersion: result.journalVersion, files: result.files }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
