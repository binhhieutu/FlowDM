const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveTools, mediaToolStatus } = require('../../src/tools/media-tools.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-tools-unix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "Công cụ ' có khoảng trắng");
  await fs.mkdir(bin);
  for (const name of ['yt-dlp', 'ffmpeg', 'aria2c']) await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, bin, options: { appDir: root, resourcesPath: undefined, packaged: false, env: { PATH: bin } } };
}

test('native Unix refuses an explicit non-executable media tool before admission', { skip: process.platform === 'win32' }, async t => {
  const { bin, options } = await fixture(t);
  const filename = path.join(bin, 'yt-dlp'); await fs.chmod(filename, 0o600);
  const configured = { ...options, env: { ...options.env, FLOWDM_YTDLP: filename } };
  assert.equal((await mediaToolStatus(configured)).ready, false);
  await assert.rejects(resolveTools(configured), /execut|thực thi/i);
  await fs.chmod(filename, 0o700);
  assert.equal((await resolveTools(configured)).ytDlp, filename);
});

test('native Unix PATH skips non-executable files and relative directories', { skip: process.platform === 'win32' }, async t => {
  const { root, bin, options } = await fixture(t);
  const bad = path.join(root, 'blocked'); await fs.mkdir(bad);
  await fs.writeFile(path.join(bad, 'yt-dlp'), 'not executable', { mode: 0o600 });
  const tools = await resolveTools({ ...options, env: { PATH: ['.', bad, bin].join(':') } });
  assert.equal(tools.ytDlp, path.join(bin, 'yt-dlp'));
  assert.equal(tools.ffmpeg, path.join(bin, 'ffmpeg'));
});

test('native Unix follows executable symlinks and refuses dangling or non-executable targets', { skip: process.platform === 'win32' }, async t => {
  const { root, bin, options } = await fixture(t);
  const link = path.join(root, 'tool-link'); const filename = path.join(bin, 'yt-dlp');
  await fs.symlink(filename, link);
  const configured = { ...options, env: { ...options.env, FLOWDM_YTDLP: link } };
  assert.equal((await resolveTools(configured)).ytDlp, link);
  await fs.chmod(filename, 0o600);
  await assert.rejects(resolveTools(configured), /execut|thực thi/i);
  await fs.unlink(filename);
  await assert.rejects(resolveTools(configured), /file|tìm thấy/i);
});
