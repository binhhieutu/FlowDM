'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { getResource, contentLength } = (() => ({ ...require('./hls.cjs'), ...require('../core/http-client.cjs') }))();
const { createValidator } = require('./container-check.cjs');

async function transferHlsParallel({ playlist, connections, tempRoot, maxBytes, speedLimit, signal, append, onProgress = () => {}, get = getResource }) {
  const count = Math.max(1, Math.min(connections, playlist.resources.length));
  const directory = path.join(tempRoot, `hls-${crypto.randomUUID()}`); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const controller = new AbortController(); const workerSignal = AbortSignal.any([signal, controller.signal]);
  let next = 0, nextCommit = 0, reserved = 0, network = 0, peak = 0, stopped = false, rootFailure = null;
  const ready = new Map(); const started = Date.now(); let commitChain = Promise.resolve();
  const gateWaiters = new Set();
  const wakeGate = () => { for (const resolve of gateWaiters) resolve(); gateWaiters.clear(); };
  const waitGate = () => new Promise(resolve => gateWaiters.add(resolve));
  const abort = error => { stopped = true; if (!signal.aborted) throw error; };
  async function fetchOne(index) {
    const filename = path.join(directory, `${index}.part`); let response;
    try {
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
      ready.set(index, { filename, bytes });
      commitChain = commitChain.then(async () => {
        while (ready.has(nextCommit)) {
          const item = ready.get(nextCommit); ready.delete(nextCommit++);
          const input = await fs.open(item.filename, 'r');
          try { for await (const chunk of input.createReadStream()) await append(chunk); } finally { await input.close(); }
          await fs.unlink(item.filename); onProgress({ committedBytes: item.bytes, networkBytes: network, peakWorkers: peak });
        }
        wakeGate();
      });
      await commitChain;
    } finally { response?.destroy(); }
  }
  async function worker() {
    try {
      while (!stopped && !workerSignal.aborted) {
        if (next >= playlist.resources.length) return;
        if (next >= nextCommit + count) { await waitGate(); continue; }
        const index = next++; await fetchOne(index);
      }
    } catch (error) { if (error.name !== 'AbortError') rootFailure ||= error; stopped = true; controller.abort(); wakeGate(); throw error; }
  }
  const workers = Array.from({ length: count }, worker);
  try {
    const results = await Promise.allSettled(workers); const failure = results.find(result => result.status === 'rejected' && result.reason.name !== 'AbortError') || results.find(result => result.status === 'rejected'); if (failure) throw rootFailure || failure.reason;
    if (signal.aborted || nextCommit !== playlist.resources.length) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
    return { networkBytes: network, peakWorkers: peak };
  } finally { stopped = true; controller.abort(); wakeGate(); await Promise.allSettled(workers); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
module.exports = { transferHlsParallel };
