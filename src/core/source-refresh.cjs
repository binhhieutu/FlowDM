'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkedUrl, checkedHeaders } = require('./policy.cjs');
const { probe } = require('./http-client.cjs');
const { assessHttpResume } = require('./http-resume.cjs');
const { loadPlaylist } = require('../media/hls.cjs');
const { playlistIdentity } = require('../media/hls-checkpoint.cjs');

function validateReplacement({ taskIdentity, candidateIdentity }) {
  if (taskIdentity.kind !== candidateIdentity.kind) return { compatible: false, reason: 'Source type changed' };
  if (taskIdentity.kind === 'direct') {
    const result = assessHttpResume({ saved: taskIdentity, probed: candidateIdentity });
    return { compatible: result.allowed, reason: result.reason };
  }
  const compatible = typeof taskIdentity.digest === 'string' && taskIdentity.digest === candidateIdentity.digest;
  return { compatible, reason: compatible ? null : 'Media identity changed; retained bytes were preserved' };
}

async function hlsSavedIdentity(directory) {
  const dir = await fs.lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('Unsafe HLS checkpoint directory');
  const filename = path.join(directory, 'checkpoint.json'); const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat(); const link = await fs.lstat(filename);
    if (!stat.isFile() || link.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw Error('Invalid HLS checkpoint metadata');
    const state = JSON.parse(await handle.readFile('utf8'));
    if (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.identity)) throw Error('Invalid HLS checkpoint identity');
    return state.identity;
  } finally { await handle.close(); }
}

async function prepareSourceReplacement({ task, input, previousHeaders, checkpointDir, maxBytes, signal, externalValidator }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'headers'].includes(key))) throw Error('Invalid source refresh options');
  const url = checkedUrl(input.url).href;
  if (new URL(url).origin !== new URL(task.url).origin) throw Error('Replacement source must use the same origin');
  const headers = checkedHeaders(input.headers === undefined ? previousHeaders : input.headers);
  if (task.requiresHeaders && input.headers === undefined && previousHeaders === undefined) throw Error('Request headers are unavailable. Reconnect the authorized browser session before refreshing.');
  const mediaType = task.mediaType || 'direct'; let extra = {};
  if (['dash', 'youtube'].includes(mediaType)) {
    if (Object.keys(headers).length) throw Error('External media downloads do not accept browser headers');
    if (task.media?.resumePolicy === 'checkpoint') {
      extra = await externalValidator({ url, mediaType, checkpointDir, maxBytes, signal, checkpointSourceUrl: task.url, checkpointSourceHash: task.media.checkpointSourceHash, selection: task.selection, expectedExtension: task.media.selectionExtension });
    }
  } else if (mediaType === 'hls') {
    const playlist = await loadPlaylist(url, headers, signal);
    if (task.media?.resumePolicy === 'checkpoint') {
      const result = validateReplacement({ taskIdentity: { kind: 'hls', digest: await hlsSavedIdentity(checkpointDir) }, candidateIdentity: { kind: 'hls', digest: playlistIdentity(playlist) } });
      if (!result.compatible) throw Error(result.reason);
    }
  } else {
    const metadata = await probe(url, headers, signal, maxBytes);
    if (task.downloadedBytes > 0 || task.validator) {
      const result = validateReplacement({ taskIdentity: { ...task, kind: 'direct' }, candidateIdentity: { ...metadata, kind: 'direct' } });
      if (!result.compatible) throw Error(result.reason);
    }
  }
  return { url, headers, checkpointSourceHash: extra.checkpointSourceHash };
}
module.exports = { validateReplacement, prepareSourceReplacement };
