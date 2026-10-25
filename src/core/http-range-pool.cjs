'use strict';
const { splitPendingRange } = require('./range-scheduler.cjs');
const MAX_SEGMENTS = 1024;
const MIN_PENDING_BYTES = 256 * 1024;
const complete = segment => segment.end !== null && segment.received === segment.end - segment.start + 1;

function redistribute(segments, connections, minBytes) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && complete(previous) && complete(segment)) {
      merged[merged.length - 1] = { ...previous, end: segment.end, received: previous.received + segment.received };
    } else merged.push({ ...segment });
  }
  while (merged.filter(segment => !complete(segment)).length < connections && merged.length < MAX_SEGMENTS) {
    const candidates = merged.map((segment, index) => ({ index, remaining: segment.end - segment.start + 1 - segment.received })).sort((a, b) => b.remaining - a.remaining);
    const index = candidates[0]?.index; if (index === undefined) break;
    const split = splitPendingRange(merged[index], minBytes); if (!split) break;
    merged.splice(index, 1, split.retained, split.pending);
  }
  return merged.map((segment, index) => ({ ...segment, index }));
}

class HttpRangePool {
  constructor({ task, runtime, transfer, persist, notify, minBytes = MIN_PENDING_BYTES }) {
    Object.assign(this, { task, runtime, transfer, persist, notify, minBytes });
    this.workers = new Map(); this.finished = new Set(); this.failure = null; this.pendingResize = null; this.wake = null; this.ended = false;
  }
  resize(connections) {
    if (this.ended || this.runtime.controller.signal.aborted) return Promise.reject(Error('Download stopped before connection change'));
    return new Promise((resolve, reject) => { this.pendingResize = { connections, resolve, reject }; this.wake?.(); });
  }
  _notify() { this.task.activeConnections = this.workers.size; this.notify(); }
  _pending() { return this.task.segments.filter(segment => !complete(segment) && !this.finished.has(segment)); }
  _start(segment) {
    const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, this.runtime.controller.signal]);
    const worker = { controller, stopping: false };
    this.workers.set(segment, worker);
    worker.promise = this.transfer(segment, signal).then(() => { this.finished.add(segment); }).catch(error => {
      if (error.name === 'AbortError' && (worker.stopping || this.runtime.controller.signal.aborted)) return;
      this.failure ||= error; this.runtime.controller.abort();
    }).finally(() => { this.workers.delete(segment); this._notify(); this.wake?.(); });
    this._notify();
  }
  async _settle() {
    const workers = [...this.workers.values()];
    for (const worker of workers) { worker.stopping = true; worker.controller.abort(); }
    await Promise.all(workers.map(worker => worker.promise));
  }
  _canSteal() {
    if (!this.task.ranges || this.workers.size >= this.task.connections || this._pending().some(segment => !this.workers.has(segment))) return false;
    return this.task.segments.length < MAX_SEGMENTS && [...this.workers.keys()].some(segment => segment.end - segment.start + 1 - segment.received >= 2 * this.minBytes);
  }
  async _reconfigure(request) {
    // Every writer has settled before replacing segment objects or boundaries.
    if (this.task.ranges) await this._settle();
    if (this.failure) throw this.failure;
    if (this.runtime.controller.signal.aborted) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
    const previous = this.task.segments; const oldConnections = this.task.connections;
    if (request) this.task.connections = request.connections;
    if (this.task.ranges) this.task.segments = redistribute(previous, this.task.connections, this.minBytes);
    try { await this.persist(); }
    catch (error) { this.task.segments = previous; this.task.connections = oldConnections; throw error; }
    // The caller loop checks cancellation before assigning any new workers.
    this._notify(); request?.resolve();
  }
  async run() {
    const signal = this.runtime.controller.signal;
    const abort = () => this.wake?.(); signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted && !this.failure) {
        if (this.pendingResize) {
          const request = this.pendingResize; this.pendingResize = null;
          try { await this._reconfigure(request); } catch (error) { request.reject(error); throw error; }
        }
        if (signal.aborted) break;
        for (const segment of this._pending()) {
          if (this.workers.size >= (this.task.ranges ? this.task.connections : 1)) break;
          if (!this.workers.has(segment)) this._start(segment);
        }
        if (!this.workers.size) break;
        if (this._canSteal()) { await this._reconfigure(); continue; }
        await new Promise(resolve => { this.wake = resolve; }); this.wake = null;
      }
    } finally {
      this.ended = true; signal.removeEventListener('abort', abort); await this._settle();
      this.pendingResize?.reject(this.failure || Error('Download stopped before connection change')); this.pendingResize = null;
      this.task.activeConnections = 0; this.notify();
    }
    if (this.failure) throw this.failure;
  }
}
module.exports = { HttpRangePool, MAX_SEGMENTS };
