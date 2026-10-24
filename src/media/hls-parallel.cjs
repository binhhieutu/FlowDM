'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { getResource, contentLength } = (() => ({ ...require('./hls.cjs'), ...require('../core/http-client.cjs') }))();
const { createValidator } = require('./container-check.cjs');
const { openCheckpoint } = require('./hls-checkpoint.cjs');

async function transferHlsParallel({ playlist, connections, tempRoot, checkpointDir, maxBytes, speedLimit, signal, append, onProgress = () => {}, get = getResource }) {
  const count = Math.max(1, Math.min(connections, playlist.resources.length));
  const directory = checkpointDir || path.join(tempRoot, `hls-${crypto.randomUUID()}`); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkpoint = checkpointDir ? await openCheckpoint(directory, playlist, maxBytes) : null;
  const controller = new AbortController(); const workerSignal = AbortSignal.any([signal, controller.signal]);
  let next = 0, nextCommit = 0, reserved = checkpoint?.bytes || 0, network = 0, peak = 0, stopped = false, rootFailure = null;
  const ready = checkpoint?.ready || new Map(); const reusedResources = ready.size;
  let completedResources = ready.size, cumulativeBytes = 0;
  const started = Date.now(); let commitChain = Promise.resolve();
  const gateWaiters = new Set();
  const wakeGate = () => { for (const resolve of gateWaiters) resolve(); gateWaiters.clear(); };
  const waitGate = () => new Promise(resolve => gateWaiters.add(resolve));
  const progress = committedBytes => onProgress({ committedBytes, cumulativeBytes, completedResources, reusedResources, networkBytes: network, peakWorkers: peak });
  async function commitReady() {
    while (ready.has(nextCommit) && !workerSignal.aborted) {
      const item = ready.get(nextCommit); ready.delete(nextCommit++);
      const input = await fs.open(item.filename, 'r');
      try { for await (const chunk of input.createReadStream()) await append(chunk); } finally { await input.close(); }
      if (!checkpoint) await fs.unlink(item.filename);
      cumulativeBytes += item.bytes; progress(item.bytes);
    }
    wakeGate();
  }
  async function fetchOne(index) {
    const filename = path.join(directory, checkpoint ? `index-${index}.partial` : `${index}.part`); let response;
    try {
      if (checkpoint) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const result = await get(playlist.resources[index], playlist.context, workerSignal); response = result.response;
      const length = contentLength(response); if (length !== null && (length < 1 || length > maxBytes - reserved)) throw Error('HLS resource exceeds size limit or is empty');
      const validator = createValidator(playlist.extension === '.ts' ? 'ts' : index === 0 ? 'mp4-init' : 'mp4-fragment', maxBytes);
      const handle = await fs.open(filename, 'wx', 0o600); let bytes = 0;
      try {
        for await (const chunk of response) {
          if (workerSignal.aborted || stopped) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
          if (chunk.length > maxBytes - reserved) throw Error('HLS combined output exceeds size limit');
          reserved += chunk.length; network += chunk.length; peak = Math.max(peak, count); bytes += chunk.length; validator.push(chunk);
          if (speedLimit) await delay(Math.max(0, network * 1000 / speedLimit - (Date.now() - started)), undefined, { signal: workerSignal });
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, bytes - chunk.length + written);
            if (!result.bytesWritten) throw Error('HLS scratch disk write made no progress');
            written += result.bytesWritten;
          }
          await handle.sync();
        }
      } finally { await handle.close(); }
      if (!bytes || (length !== null && bytes !== length)) throw Error('Truncated or empty HLS resource'); validator.finish();
      const saved = checkpoint ? await checkpoint.save(index, filename, bytes) : filename;
      ready.set(index, { filename: saved, bytes }); completedResources++;
      // Expose durable out-of-order completions even while the ordered writer
      // waits for an earlier resource. Committed/output bytes remain unchanged.
      if (checkpoint) progress(0);
      commitChain = commitChain.then(commitReady);
      await commitChain;
    } finally { response?.destroy(); }
  }
  async function worker() {
    try {
      while (!stopped && !workerSignal.aborted) {
        if (next >= playlist.resources.length) return;
        if (next >= nextCommit + count) { await waitGate(); continue; }
        const index = next++; if (index < nextCommit || ready.has(index)) continue;
        await fetchOne(index);
      }
    } catch (error) { if (error.name !== 'AbortError') rootFailure ||= error; stopped = true; controller.abort(); wakeGate(); throw error; }
  }
  progress(0); await commitReady();
  const workers = Array.from({ length: count }, worker);
  try {
    const results = await Promise.allSettled(workers); const failure = results.find(result => result.status === 'rejected' && result.reason.name !== 'AbortError') || results.find(result => result.status === 'rejected'); if (failure) throw rootFailure || failure.reason;
    if (signal.aborted || nextCommit !== playlist.resources.length) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
    return { networkBytes: network, peakWorkers: peak, completedResources, reusedResources, bytes: cumulativeBytes };
  } finally { stopped = true; controller.abort(); wakeGate(); await Promise.allSettled(workers); if (!checkpoint) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
module.exports = { transferHlsParallel };
