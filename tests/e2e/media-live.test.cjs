const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('real public YouTube downloads through desktop and contains playable video and audio', { skip: !process.env.FLOWDM_LIVE_YOUTUBE, timeout: 900000 }, async t => {
  const root = path.resolve('.tmp', `live-youtube-${Date.now()}`); const output = path.resolve('downloads/verification-v3');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const executablePath = process.env.FLOWDM_EXECUTABLE || require('electron');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath, args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: output } });
  t.after(() => app.close()); const page = await app.firstWindow(); await page.waitForFunction(() => !!window.flow);
  const info = await page.evaluate(() => window.flow.info()); assert.equal(info.data.mediaTools.ready, true, JSON.stringify(info));
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
  await page.locator('#url').fill(process.env.FLOWDM_LIVE_YOUTUBE);
  await page.locator('#filename').fill('YouTube-BigBuckBunny.mp4');
  await page.locator('#add-form').evaluate(form => form.requestSubmit());
  let task; const end = Date.now() + 750000;
  while (Date.now() < end) {
    task = (await page.evaluate(() => window.flow.list())).data.at(-1);
    if (task && ['completed', 'failed'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(task?.status, 'completed', JSON.stringify(task)); assert.equal(task.mediaType, 'youtube');
  const probe = spawnSync(process.env.FLOWDM_FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.path], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(probe.status, 0, probe.stderr); const metadata = JSON.parse(probe.stdout);
  assert.ok(metadata.streams.some(stream => stream.codec_type === 'video')); assert.ok(metadata.streams.some(stream => stream.codec_type === 'audio'));
  const duration = Number(metadata.format.duration); assert.ok(duration > 600 && duration < 660, duration);
  for (const start of ['0', String(Math.max(0, duration - 10))]) {
    const decode = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-ss', start, '-i', task.path, '-t', '5', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(decode.status, 0, decode.stderr); assert.equal(decode.stderr, '');
  }
  const fullDecode = spawnSync(process.env.FLOWDM_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', task.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(fullDecode.status, 0, fullDecode.stderr); assert.equal(fullDecode.stderr, '');
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/youtube-v3.png' });
  const report = { at: new Date().toISOString(), source: process.env.FLOWDM_LIVE_YOUTUBE, appVersion: info.data.version, packaged: !!process.env.FLOWDM_EXECUTABLE, path: task.path, bytes: task.totalBytes, sha256: task.sha256, duration, streams: metadata.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })), decodedBeginningAndEnd: true, wholeFileDecoded: true };
  await fs.writeFile('test-results/youtube-v3.json', JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
});
