'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { inputOptions, integer, checkedUrl } = require('./policy.cjs');
const { probe, retryRequest, rangeInfo, contentLength } = require('./http-client.cjs');
const { atomicJournal, backupJournal, uniqueDestination, openPartial, hashFile, publish, recoverPublished, preflightPublication } = require('./storage.cjs');
const { HttpRangePool, MAX_SEGMENTS } = require('./http-range-pool.cjs');
const { loadPlaylist, getResource } = require('../media/hls.cjs');
const { createValidator } = require('../media/container-check.cjs');
const { transferHlsParallel } = require('../media/hls-parallel.cjs');
const { downloadExternal, inspectMedia } = require('../media/external.cjs');
const { validateSelection } = require('../media/catalog.cjs');
const { MediaCatalogService, playlistFilename } = require('./media-catalog-service.cjs');
const { assessHttpResume } = require('./http-resume.cjs');
const { prepareSourceReplacement } = require('./source-refresh.cjs');
const { prepareHeaderRebind } = require('./header-rebind.cjs');
const { QueueCoordinator } = require('./queue-manager.cjs');
const { effectiveQueueRate } = require('./queue-scheduler.cjs');
const { PowerActionController, SystemPowerAdapter } = require('./power-actions.cjs');

const clone = value => structuredClone(value);
const STATES = ['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled'];
function plan(total, connections, ranges) {
  const count = ranges && total ? Math.min(connections, total) : 1;
  return Array.from({ length: count }, (_, index) => ({ index, start: total === null ? 0 : Math.floor(index * total / count), end: total === null ? null : Math.floor((index + 1) * total / count) - 1, received: 0 }));
}

class DownloadManager extends EventEmitter {
  constructor({ dataDir, downloadDir, maxConcurrent = 3, maxBytes = 100 * 1024 ** 3, maxPerHost = 3, externalDownloader = downloadExternal, mediaInspector = inspectMedia, clock = Date.now, powerAdapter = new SystemPowerAdapter(), monotonicClock }) {
    super();
    if (![dataDir, downloadDir].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('Data and download directories must be absolute');
    this.dataDir = path.resolve(dataDir); this.downloadDir = path.resolve(downloadDir);
    this.maxConcurrent = integer(maxConcurrent, 1, 16, 'Concurrent downloads');
    this.maxPerHost = integer(maxPerHost, 1, 16, 'Per-host downloads');
    this.maxBytes = integer(maxBytes, 1, Number.MAX_SAFE_INTEGER, 'Size limit');
    if (typeof externalDownloader !== 'function') throw Error('External media downloader must be a function');
    this.externalDownloader = externalDownloader;
    if (typeof mediaInspector !== 'function') throw Error('Media inspector must be a function');
    this.mediaCatalog = new MediaCatalogService(mediaInspector);
    this.tasks = new Map(); this.secrets = new Map(); this.running = new Map(); this.pendingAdds = new Set();
    this.journal = path.join(this.dataDir, 'downloads.json');
    this.persistence = Promise.resolve(); this.mutations = Promise.resolve(); this.closed = false; this.initialized = false;
    if (typeof clock !== 'function') throw Error('Scheduler clock must be a function');
    this.powerController = new PowerActionController({ adapter: powerAdapter, ...(monotonicClock ? { monotonicNow: monotonicClock } : {}), beforeDispatch: intent => this._mutate(() => { this._ready(); return this.queueState.beforePowerDispatch(intent); }) });
    this.powerController.on('state', value => this.emit('power', value));
    this.queueState = new QueueCoordinator(this, { clock, powerController: this.powerController });
    this.queueTick = null; this.queueRetryAt = 0; this.queueError = null;
  }

  async init() {
    if (this.initialized) return this;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.downloadDir, { recursive: true });
    let saved;
    try { saved = JSON.parse(await fs.readFile(this.journal, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw Error(`Cannot read download journal: ${error.message}`); }
    if (saved) {
      if (![1, 2, 3, 4, 5, 6, 7].includes(saved.version) || !Array.isArray(saved.tasks)) throw Error('Unsupported download journal');
      for (const task of saved.tasks) this._validateStored(task, saved.version);
      const restoredTasks = this.queueState.load(saved);
      if (saved.version < 7) await backupJournal(this.journal, saved.version);
      for (const task of restoredTasks) {
        if (task.status === 'downloading' && this.queueState.require(task.queueId).schedule) task.queueHold = true;
        const needsPause = task.status === 'downloading' || (task.status === 'queued' && task.requiresHeaders);
        const restored = { ...task, ...(task.activeConnections === undefined ? {} : { activeConnections: 0 }), status: needsPause ? 'paused' : task.status, speed: 0 };
        await this._recoverPublished(restored);
        this.tasks.set(task.id, restored);
      }
    }
    this.initialized = true;
    await this._persist();
    this.timer = setInterval(() => this._pump(), 250); this.timer.unref();
    this._pump();
    return this;
  }

  _validateStored(task, version = 6) {
    if (!task || !/^[a-f0-9-]{36}$/.test(task.id) || !STATES.includes(task.status) || !path.isAbsolute(task.path) || path.basename(task.path) !== task.filename) throw Error('Invalid download journal task');
    checkedUrl(task.url);
    if (task.mediaType !== undefined && !['direct', 'hls', 'dash', 'youtube'].includes(task.mediaType)) throw Error('Invalid journal media type');
    if (task.selection !== undefined) {
      if (version < 6 || !['dash', 'youtube'].includes(task.mediaType)) throw Error('Invalid selected media journal version or type');
      validateSelection(task.selection);
      if (!['mp4', 'webm', 'mkv', 'm4a', 'opus', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'mka'].includes(task.media?.selectionExtension) || path.extname(task.filename) !== `.${task.media.selectionExtension}`) throw Error('Invalid selected media container');
    }
    integer(task.connections, 1, 16, 'Connections'); integer(task.speedLimit, 0, Number.MAX_SAFE_INTEGER, 'Speed limit');
    if (!Array.isArray(task.segments) || task.segments.length > (version < 5 ? 16 : MAX_SEGMENTS)) throw Error('Invalid journal segments');
    let received = 0, next = 0;
    for (const segment of task.segments) {
      integer(segment.start, 0, this.maxBytes, 'Segment start'); integer(segment.received, 0, this.maxBytes, 'Segment bytes');
      if (segment.start !== next || (segment.end !== null && (!Number.isSafeInteger(segment.end) || segment.end < segment.start - 1 || segment.received > segment.end - segment.start + 1))) throw Error('Invalid journal segment bounds');
      next = segment.end === null ? 0 : segment.end + 1; received += segment.received;
    }
    if (received !== task.downloadedBytes || (task.totalBytes !== null && (!Number.isSafeInteger(task.totalBytes) || task.totalBytes > this.maxBytes || task.totalBytes < received))) throw Error('Invalid journal byte count');
    if ((!task.mediaType || task.mediaType === 'direct') && task.totalBytes !== null && task.segments.length && task.segments.every(segment => segment.end !== null) && next !== task.totalBytes) throw Error('Invalid journal segment coverage');
  }

  list() { return clone([...this.tasks.values()]); }
  listQueues() { return this.queueState.snapshot().map(queue => ({ ...queue, error: this.queueError })); }
  _queueCall(method, ...args) { this.cancelPower(); return this._mutate(() => { this._ready(); return this.queueState[method](...args); }); }
  createQueue(input) { return this._queueCall('createQueue', input); }
  updateQueue(id, patch) { return this._queueCall('updateQueue', id, patch); }
  deleteQueue(id) { return this._queueCall('deleteQueue', id); }
  reorderQueue(id, taskIds) { return this._queueCall('reorderQueue', id, taskIds); }
  moveTask(id, queueId, beforeTaskId) { return this._queueCall('moveTask', id, queueId, beforeTaskId); }
  pauseQueue(id) { return this._queueCall('pauseQueue', id); }
  resumeQueue(id) { return this._queueCall('resumeQueue', id); }
  powerInfo() { return this.powerController.snapshot(); }
  cancelPower() { this.queueState.cancelPower(); return this.powerController.cancel('user-cancelled'); }
  _require(id) { const task = this.tasks.get(id); if (!task) throw Error('Download not found'); return task; }
  _ready() { if (!this.initialized || this.closed) throw Error('Download manager is not running'); }
  _partial(id) { return path.join(this.dataDir, `${id}.part`); }
  _mediaDirectory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid checkpoint owner');
    return path.join(this.dataDir, `${id}.media`);
  }
  async _prepareCheckpoint(task) {
    const directory = this._mediaDirectory(task.id);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe media checkpoint directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (task.media?.resumePolicy === 'checkpoint' && task.downloadedBytes > 0) throw Error('Media checkpoint is missing. Cancel and add again to restart.');
      await fs.mkdir(directory, { mode: 0o700 });
    }
    if (task.media?.resumePolicy === 'checkpoint' && task.downloadedBytes > 0) {
      try {
        const state = await fs.lstat(path.join(directory, 'checkpoint.json'));
        if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) throw Error('Unsafe media checkpoint metadata');
      } catch (error) {
        if (error.code === 'ENOENT') throw Error('Media checkpoint metadata is missing. Cancel and add again to restart.');
        throw error;
      }
    }
    return directory;
  }
  async _clearCheckpoint(task) {
    if (!['hls', 'dash', 'youtube'].includes(task.mediaType)) return;
    const directory = this._mediaDirectory(task.id);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe media checkpoint directory');
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  _notify() {
    this.emit('change', this.list());
    const queues = this.listQueues(), signature = JSON.stringify(queues);
    if (signature !== this.lastQueueSignature) { this.lastQueueSignature = signature; this.emit('queues', queues); }
  }
  _persist() {
    const snapshot = this.list();
    const queues = this.queueState.snapshot();
    const write = this.persistence.catch(() => {}).then(() => atomicJournal(this.journal, snapshot, 7, { queues }));
    this.persistence = write; return write;
  }
  _mutate(operation) {
    const result = this.mutations.catch(() => {}).then(operation);
    this.mutations = result; return result;
  }
  _persistProgress(runtime) {
    void this._persist().catch(error => { runtime.persistenceError ||= error; runtime.controller.abort(); });
  }
  async inspectMedia(input) { this._ready(); const result = await this.mediaCatalog.inspect(input); this._ready(); return result; }
  async addPlaylist(input) {
    this._ready();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['catalogId', 'entryIds', 'connections', 'speedLimit', 'directory', 'queueId'].includes(key))) throw Error('Invalid playlist options');
    const entries = this.mediaCatalog.playlist(input.catalogId, input.entryIds);
    integer(input.connections ?? 4, 1, 16, 'Connections'); integer(input.speedLimit ?? 0, 0, Number.MAX_SAFE_INTEGER, 'Speed limit');
    const created = [], errors = [];
    for (const entry of entries) {
      try { created.push(await this.add({ url: entry.url, mediaType: 'youtube', filename: playlistFilename(entry), connections: input.connections, speedLimit: input.speedLimit, directory: input.directory, queueId: input.queueId })); }
      catch (error) { errors.push({ id: entry.id, error: this._safeError(error) }); }
    }
    return { created, errors };
  }

  add(input) {
    this.cancelPower();
    return this._mutate(async () => {
      this._ready();
      const options = inputOptions(input, this.downloadDir);
      this.queueState.require(input.queueId ?? 'default');
      const selected = options.selection === undefined ? null : this.mediaCatalog.resolve({ url: options.url, mediaType: options.mediaType, selection: options.selection, catalogId: input.catalogId });
      if (selected) options.filename = `${path.parse(options.filename).name}.${selected.extension}`;
      const destination = await uniqueDestination(options.directory, options.filename, new Set(this.list().map(task => task.path.toLowerCase())));
      const task = { id: crypto.randomUUID(), url: options.url, ...destination, status: 'queued', totalBytes: null, downloadedBytes: 0, speed: 0, error: null, connections: options.connections, segments: [], createdAt: new Date().toISOString(), startAt: options.startAt, speedLimit: options.speedLimit, finalUrl: null, sha256: null, validator: null, ranges: false, requiresHeaders: Object.keys(options.headers).length > 0 };
      task.mediaType = options.mediaType;
      if (selected) { task.selection = selected.selection; task.media = { selectionExtension: selected.extension, format: selected.extension }; }
      this.queueState.attach(task, input.queueId ?? 'default');
      this.pendingAdds.add(task.id);
      this.tasks.set(task.id, task); this.secrets.set(task.id, options.headers);
      try { await this._persist(); }
      catch (error) {
        this.tasks.delete(task.id); this.secrets.delete(task.id); this.queueState.detach(task.id);
        // A running download may have queued a snapshot while this add was pending.
        // Queue its removal after those snapshots; retain the original add failure.
        await this._persist().catch(() => {});
        throw error;
      } finally { this.pendingAdds.delete(task.id); }
      this._notify(); this._pump(); return clone(task);
    });
  }

  pause(id) { this.cancelPower(); return this._mutate(() => this._pause(id)); }
  async _commitConnections(task, connections) {
    this._ready(); const previous = task.connections; task.connections = connections;
    try { await this._persist(); } catch (error) { task.connections = previous; throw error; }
  }
  setConnections(id, value) {
    this.cancelPower();
    return this._mutate(async () => {
      this._ready(); const connections = integer(value, 1, 16, 'Connections'); const task = this._require(id);
      if (!['queued', 'downloading', 'paused', 'failed'].includes(task.status)) throw Error('This download cannot change connections');
      if (task.connections === connections) return clone(task);
      const runtime = this.running.get(id);
      if (runtime?.rangePool) await runtime.rangePool.resize(connections);
      else if (runtime?.hlsControl) await runtime.hlsControl.resize(connections, () => this._commitConnections(task, connections));
      else if (runtime && ['dash', 'youtube'].includes(task.mediaType)) {
        const capability = runtime.externalControl ? await runtime.externalControl.canResize() : { allowed: false, reason: 'Wait for media preparation before changing connections' };
        if (task.status === 'completed') return clone(task);
        if (!capability.allowed) throw Error(capability.reason || 'This media resource cannot safely change connections while downloading');
        await this._pause(id); if (task.status === 'completed') return clone(task);
        await this._commitConnections(task, connections); await this._resume(id);
      } else {
        if (runtime?.hlsStage === 'transferring') throw Error('Wait for HLS checkpoint preparation before changing connections');
        await this._commitConnections(task, connections);
      }
      this._notify(); return clone(task);
    });
  }
  prepareHeaderRebind(id, headers, options) { return this._mutate(() => prepareHeaderRebind(this, id, headers, options)); }
  rebindHeaders(id, headers, options) { return this.prepareHeaderRebind(id, headers, options).then(prepared => prepared.commit()); }
  refreshSource(id, input) {
    this.cancelPower();
    return this._mutate(async () => {
      this._ready(); const task = this._require(id);
      if (!['paused', 'failed'].includes(task.status) || this.running.has(id)) throw Error('Pause the download before updating its source');
      const previousHeaders = this.secrets.get(id);
      const prepared = await prepareSourceReplacement({ task: clone(task), input, previousHeaders, checkpointDir: this._mediaDirectory(id), maxBytes: this.maxBytes, signal: AbortSignal.timeout(30000), externalValidator: require('../media/external.cjs').validateExternalReplacement });
      this._ready();
      const updated = { ...task, url: prepared.url, status: 'paused', error: null, speed: 0, requiresHeaders: Object.keys(prepared.headers).length > 0 };
      if (prepared.checkpointSourceHash) updated.media = { ...task.media, checkpointSourceHash: prepared.checkpointSourceHash };
      this.tasks.set(id, updated); this.secrets.set(id, prepared.headers);
      try { await this._persist(); }
      catch (error) {
        this.tasks.set(id, task);
        if (previousHeaders === undefined) this.secrets.delete(id); else this.secrets.set(id, previousHeaders);
        await this._persist().catch(() => {}); throw error;
      }
      this._notify(); return clone(updated);
    });
  }
  async _pause(id, { queueHold = false } = {}) {
    this._ready(); const task = this._require(id);
    if (['completed', 'canceled'].includes(task.status)) return clone(task);
    const changedHold = task.queueHold !== queueHold; task.queueHold = queueHold;
    if (task.status === 'paused') { if (changedHold) { await this._persist(); this._notify(); } return clone(task); }
    task.status = 'paused'; task.speed = 0;
    const runtime = this.running.get(id); runtime?.controller.abort();
    if (runtime) await runtime.promise;
    task.speed = 0;
    await this._persist(); this._notify(); return clone(task);
  }
  resume(id) { this.cancelPower(); return this._mutate(() => this._resume(id)); }
  async _resume(id) {
    this._ready(); const task = this._require(id);
    if (!['paused', 'failed'].includes(task.status)) return clone(task);
    if (await this._recoverPublished(task)) { await this._persist(); this._notify(); return clone(task); }
    if (task.requiresHeaders && !this.secrets.has(id)) throw Error('Request headers are not persisted. Reconnect the browser session for this download before resuming.');
    this.powerController.cancel('new-work'); task.status = 'queued'; task.queueHold = false; task.error = null; task.startAt = null;
    await this._persist(); this._notify(); this._pump(); return clone(task);
  }
  cancel(id) { this.cancelPower(); return this._mutate(() => this._cancel(id)); }
  async _cancel(id) {
    this._ready(); const task = this._require(id);
    if (['completed', 'canceled'].includes(task.status)) return clone(task);
    await this._pause(id);
    if (task.status === 'completed') return clone(task);
    task.status = 'canceled';
    await fs.unlink(this._partial(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this._clearCheckpoint(task);
    await this._persist(); this._notify(); return clone(task);
  }
  remove(id) { this.cancelPower(); return this._mutate(() => this._remove(id)); }
  async _remove(id) {
    this._ready(); if (!this.tasks.has(id)) return false;
    await this._cancel(id); this.tasks.delete(id); this.secrets.delete(id); this.queueState.detach(id);
    await this._persist(); this._notify(); return true;
  }
  async close() {
    if (this.closed) { await this.persistence; return; }
    this.closed = true; clearInterval(this.timer);
    this.powerController.close();
    const closing = [...this.running.entries()];
    for (const [id, runtime] of closing) {
      const task = this._require(id);
      if (task.status === 'downloading') {
        if (this.queueState.require(task.queueId).schedule) task.queueHold = true;
        task.status = 'paused';
      }
      task.speed = 0; runtime.controller.abort();
    }
    await this.mediaCatalog.close();
    await this.mutations.catch(() => {});
    await Promise.all(closing.map(([, runtime]) => runtime.promise));
    if (this.initialized) await this._persist();
  }

  _pump() {
    if (this.closed || !this.initialized || this.queueState.blocked || this.queueTick) return;
    const decision = this.queueState.evaluate();
    if (this.queueError || decision.queueTransitions.length || decision.pauseIds.length || decision.runnableIds.some(id => this.tasks.get(id)?.queueHold)) {
      if (Date.now() < this.queueRetryAt) return;
      this.queueTick = this._mutate(() => this.queueState.reconcile()).catch(() => { this.queueRetryAt = Date.now() + 1000; }).finally(() => { this.queueTick = null; if (!this.queueError) this._pump(); });
      return;
    }
    for (const id of decision.runnableIds) {
      const task = this.tasks.get(id); if (!task || this.running.has(id)) continue;
      if (this.running.size >= this.maxConcurrent) break;
      if (task.status !== 'queued' || this.pendingAdds.has(task.id)) continue;
      const queue = this.queueState.require(task.queueId);
      const slots = queue.speedLimit ? Math.min(queue.concurrency, queue.speedLimit) : queue.concurrency;
      if ([...this.running.keys()].filter(taskId => this.tasks.get(taskId)?.queueId === queue.id).length >= slots) continue;
      const host = new URL(task.url).host;
      if ([...this.running.values()].filter(runtime => runtime.host === host).length >= this.maxPerHost) continue;
      const runtime = { controller: new AbortController(), host, transferred: 0, began: Date.now(), lastEvent: 0, speedLimit: effectiveQueueRate(queue, task) };
      task.status = 'downloading'; this.running.set(task.id, runtime);
      runtime.promise = this._run(task, runtime).finally(() => {
        this.running.delete(task.id); this._notify();
        if (!this.closed && task.status === 'completed') void this._mutate(() => this.queueState.completed(task.id)).catch(() => { this.queueError = 'Cannot save queue completion'; this._notify(); });
        this._pump();
      });
      this._notify();
    }
  }

  async _prepare(task, runtime) {
    if (task.mediaType === 'hls') return this._prepareHls(task, runtime);
    if (['dash', 'youtube'].includes(task.mediaType)) return this._prepareExternal(task, runtime);
    await preflightPublication(task.path);
    const headers = this.secrets.get(task.id) || {};
    const metadata = await probe(task.url, headers, runtime.controller.signal, this.maxBytes);
    const resume = task.downloadedBytes > 0;
    if (resume) {
      const assessment = assessHttpResume({ saved: task, probed: metadata });
      if (!assessment.allowed) throw Error(assessment.reason);
    }
    if (resume) {
      try {
        const stat = await fs.lstat(this._partial(task.id));
        const required = Math.max(0, ...task.segments.filter(segment => segment.received > 0).map(segment => segment.start + segment.received));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < required || stat.size > task.totalBytes) throw Error('HTTP resume checkpoint has an unsafe size or is truncated; retained bytes were preserved');
      } catch (error) { if (error.code === 'ENOENT') throw Error('HTTP resume checkpoint is missing; progress was preserved'); else throw error; }
    }
    const ranges = metadata.ranges && metadata.validator?.type === 'etag';
    if (!resume) {
      await fs.unlink(this._partial(task.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      task.segments = plan(metadata.total, metadata.validator?.type === 'etag' ? task.connections : 1, ranges);
      task.downloadedBytes = 0;
    }
    task.sha256 = null;
    task.totalBytes = metadata.total; task.finalUrl = metadata.finalUrl;
    task.validator = metadata.validator; task.ranges = ranges; task.contentEncoding = metadata.contentEncoding;
    const handle = await openPartial(this._partial(task.id), resume);
    try { await this._persist(); } catch (error) { await handle.close(); throw error; }
    return { handle, headers };
  }

  async _run(task, runtime) {
    let handle;
    try {
      if (await this._recoverPublished(task)) { await this._persist(); return; }
      const prepared = await this._prepare(task, runtime); handle = prepared.handle;
      if (prepared.external) await this._transferExternal(task, runtime);
      else if (prepared.playlist) await this._transferHls(task, prepared.playlist, handle, runtime);
      else await this._transfer(task, prepared.headers, handle, runtime);
      if (runtime.persistenceError) throw runtime.persistenceError;
      if (runtime.controller.signal.aborted || task.status !== 'downloading') return;
      if (task.totalBytes !== null && task.downloadedBytes !== task.totalBytes) throw Error('Incomplete download byte count');
      if (handle) { await handle.sync(); await handle.close(); handle = null; }
      task.sha256 = await hashFile(this._partial(task.id));
      if (runtime.controller.signal.aborted || task.status !== 'downloading') return;
      await this._persist();
      await publish(this._partial(task.id), task.path);
      await this._clearCheckpoint(task);
      task.totalBytes = task.downloadedBytes; task.status = 'completed'; task.error = null; task.speed = 0;
      await this._persist();
    } catch (error) {
      if (task.status === 'downloading') {
        task.status = 'failed'; task.error = this._safeError(error); task.speed = 0;
      }
      await this._persist().catch(persistError => { task.status = 'failed'; task.error = `Cannot save journal: ${persistError.code || 'storage error'}`; });
    } finally { if (handle) await handle.close().catch(() => {}); }
  }

  async _recoverPublished(task) {
    if (['completed', 'canceled'].includes(task.status) || !await recoverPublished(task)) return false;
    await fs.unlink(this._partial(task.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this._clearCheckpoint(task);
    task.status = 'completed'; task.totalBytes = task.downloadedBytes; task.error = null; task.speed = 0;
    return true;
  }

  async _prepareHls(task, runtime) {
    const playlist = await loadPlaylist(task.url, this.secrets.get(task.id) || {}, runtime.controller.signal);
    if (path.extname(task.filename) !== playlist.extension) {
      const destination = await uniqueDestination(path.dirname(task.path), `${path.parse(task.filename).name}${playlist.extension}`, new Set(this.list().filter(item => item.id !== task.id).map(item => item.path.toLowerCase())));
      task.path = destination.path; task.filename = destination.filename;
    }
    await preflightPublication(task.path);
    const checkpointDir = await this._prepareCheckpoint(task);
    await fs.unlink(this._partial(task.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (task.media?.resumePolicy !== 'checkpoint') task.downloadedBytes = 0;
    task.segments = [{ index: 0, start: 0, end: null, received: task.downloadedBytes }]; task.totalBytes = null;
    task.sha256 = null; task.validator = null; task.ranges = false; task.finalUrl = playlist.finalUrl;
    task.media = { ...task.media, format: playlist.extension.slice(1), segmentCount: playlist.segmentCount, resumePolicy: 'checkpoint' };
    const handle = await openPartial(this._partial(task.id), false);
    try { await this._persist(); } catch (error) { await handle.close(); throw error; }
    return { handle, playlist, checkpointDir };
  }

  async _prepareExternal(task) {
    await preflightPublication(task.path);
    await this._prepareCheckpoint(task);
    await fs.unlink(this._partial(task.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (task.media?.resumePolicy !== 'checkpoint') task.downloadedBytes = 0;
    task.segments = [{ index: 0, start: 0, end: null, received: task.downloadedBytes }];
    task.totalBytes = null; task.sha256 = null; task.validator = null; task.ranges = false; task.finalUrl = null;
    task.media = { ...task.media, format: task.media?.selectionExtension || 'mp4', resumePolicy: 'checkpoint', externalTool: 'yt-dlp', canResize: false };
    await this._persist();
    return { external: true };
  }

  async _transferExternal(task, runtime) {
    const result = await this.externalDownloader({
      url: task.url, mediaType: task.mediaType, headers: this.secrets.get(task.id) || {}, output: this._partial(task.id),
      checkpointDir: this._mediaDirectory(task.id), signal: runtime.controller.signal, maxBytes: this.maxBytes, speedLimit: runtime.speedLimit, connections: task.connections,
      checkpointSourceHash: task.media?.checkpointSourceHash,
      selection: task.selection, expectedExtension: task.media?.selectionExtension,
      onControlReady: control => { runtime.externalControl = control; task.media.canResize = !!control && control.eligible !== false; this._notify(); },
      onProgress: progress => {
        if (['completed', 'canceled'].includes(task.status)) return;
        const downloaded = Number.isSafeInteger(progress.downloadedBytes) ? Math.min(progress.downloadedBytes, this.maxBytes) : 0;
        // yt-dlp reports each selected track independently; retain the high-water mark
        // until the final muxed file gives us the authoritative combined byte count.
        const reported = Math.max(task.downloadedBytes, downloaded);
        task.downloadedBytes = reported; task.segments[0].received = reported; runtime.transferred = reported;
        task.totalBytes = Number.isSafeInteger(progress.totalBytes) ? Math.min(progress.totalBytes, this.maxBytes) : null;
        task.speed = task.status === 'downloading' ? Math.round(runtime.transferred * 1000 / Math.max(1, Date.now() - runtime.began)) : 0;
        for (const key of ['completedResources', 'reusedResources', 'reusedBytes']) if (Number.isSafeInteger(progress[key]) && progress[key] >= 0) task.media[key] = progress[key];
        if (Number.isSafeInteger(progress.completedResources)) task.media.completedSegments = progress.completedResources;
        this._persistProgress(runtime);
        this._notify();
      }
    });
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > this.maxBytes) throw Error('External media output exceeds size limit');
    task.downloadedBytes = result.bytes; task.totalBytes = result.bytes; task.segments[0].received = result.bytes;
    task.finalUrl = result.finalUrl || null; task.media = { ...task.media, ...result.metadata, completedSegments: task.media.completedResources || 1 };
    await this._persist();
  }

  async _transferHls(task, playlist, handle, runtime) {
    runtime.hlsStage = 'transferring';
    let appended = 0;
    const result = await transferHlsParallel({ playlist, connections: task.connections, tempRoot: this.dataDir, checkpointDir: this._mediaDirectory(task.id), maxBytes: this.maxBytes, speedLimit: runtime.speedLimit, signal: runtime.controller.signal,
      onControlReady: control => { runtime.hlsControl = control; task.media.canResize = !!control; this._notify(); },
      append: async chunk => { let written = 0; while (written < chunk.length) { const value = await handle.write(chunk, written, chunk.length - written, appended + written); if (!value.bytesWritten) throw Error('Disk write made no progress'); written += value.bytesWritten; } appended += written; await handle.sync(); },
      onProgress: progress => { task.downloadedBytes = Math.max(task.downloadedBytes, progress.cumulativeBytes ?? appended); task.segments[0].received = task.downloadedBytes; task.media.completedSegments = progress.completedResources || 0; task.media.reusedResources = progress.reusedResources || 0; task.media.networkBytes = progress.networkBytes; task.media.effectiveConnections = Math.min(task.connections, playlist.resources.length); task.activeConnections = progress.activeConnections || 0; runtime.transferred = progress.networkBytes; task.speed = task.status === 'downloading' ? Math.round(runtime.transferred * 1000 / Math.max(1, Date.now() - runtime.began)) : 0; this._persistProgress(runtime); this._notify(); }
    });
    task.downloadedBytes = appended; task.segments[0].received = appended;
    task.totalBytes = task.downloadedBytes; task.media.networkBytes = result.networkBytes; task.media.peakWorkers = result.peakWorkers;
  }

  async _transfer(task, headers, handle, runtime) {
    const pool = new HttpRangePool({ task, runtime, transfer: (segment, signal) => this._segment(task, segment, headers, handle, runtime, signal), persist: () => this._persist(), notify: () => this._notify() });
    runtime.rangePool = pool;
    try { await pool.run(); } finally { runtime.rangePool = null; }
  }

  _safeError(error) {
    // Network diagnostics never include URL/header values or server response bodies.
    if (error.code) return `Download failed (${error.code})`;
    const message = String(error.message || 'Download failed');
    return message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 300);
  }

  async _segment(task, segment, headers, handle, runtime, signal = runtime.controller.signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await this._segmentOnce(task, segment, headers, handle, runtime, signal); }
      catch (error) {
        // Node can surface a deliberately destroyed response as ECONNRESET
        // rather than AbortError. Only normalize cancellation/network teardown;
        // validator/protocol/storage failures must remain substantive errors.
        if (signal.aborted && ['ABORT_ERR', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
        // A validated range may continue from its fsynced offset after a dropped stream.
        // Other protocol errors remain visible; a non-range retry starts via resume().
        const retryable = ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ETIMEDOUT'].includes(error.code);
        if (!task.ranges || !retryable || attempt >= 2 || signal.aborted) throw error;
        await delay(100 * 2 ** attempt + Math.floor(Math.random() * 40), undefined, { signal });
      }
    }
  }

  async _segmentOnce(task, segment, headers, handle, runtime, signal = runtime.controller.signal) {
    if (segment.end !== null && segment.received === segment.end - segment.start + 1) return;
    const start = segment.start + segment.received;
    const requestHeaders = { ...headers };
    if (task.ranges) requestHeaders.range = `bytes=${start}-${segment.end}`;
    if (task.ranges && task.validator) requestHeaders['if-range'] = task.validator.value;
    const { response, finalUrl } = await retryRequest(task.url, requestHeaders, signal);
    try {
      if (task.finalUrl && new URL(finalUrl).origin !== new URL(task.finalUrl).origin) throw Error('Remote response origin changed; retained bytes were preserved');
      this._checkResponse(task, segment, response, start);
      for await (const chunk of response) {
        if (signal.aborted) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
        const remaining = segment.end === null ? this.maxBytes - task.downloadedBytes : segment.end - segment.start + 1 - segment.received;
        if (chunk.length > remaining || task.downloadedBytes + chunk.length > this.maxBytes) throw Error('Response exceeds expected size or size limit');
        runtime.transferred += chunk.length;
        if (runtime.speedLimit) await delay(Math.max(0, runtime.transferred * 1000 / runtime.speedLimit - (Date.now() - runtime.began)), undefined, { signal });
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written, segment.start + segment.received + written);
          if (!result.bytesWritten) throw Error('Disk write made no progress');
          written += result.bytesWritten;
        }
        await handle.sync();
        segment.received += written; task.downloadedBytes += written;
        task.speed = Math.round(runtime.transferred * 1000 / Math.max(1, Date.now() - runtime.began));
        await this._persist();
        if (Date.now() - runtime.lastEvent > 100) { runtime.lastEvent = Date.now(); this._notify(); }
      }
      if (signal.aborted) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
      if (segment.end !== null && segment.received !== segment.end - segment.start + 1) throw Error('Truncated response');
    } finally { response.destroy(); }
  }

  _checkResponse(task, segment, response, start) {
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw Error('Encoded response is unsafe for byte ranges');
    if (task.ranges) {
      if (response.statusCode === 200) throw Object.assign(Error('Server stopped honoring byte ranges'), { code: 'RANGE_IGNORED' });
      if (response.statusCode !== 206) throw Error(`HTTP ${response.statusCode}`);
      const range = rangeInfo(response);
      if (range.start !== start || range.end !== segment.end || range.total !== task.totalBytes) throw Error('Content-Range does not match requested segment');
      const length = contentLength(response);
      if (length !== null && length !== range.end - range.start + 1) throw Error('Content-Length does not match range');
    } else if (response.statusCode !== 200) throw Error(`HTTP ${response.statusCode}`);
    if (task.validator) {
      const actual = response.headers[task.validator.type === 'etag' ? 'etag' : 'last-modified'];
      if (actual !== task.validator.value) throw Error('Remote file validator changed during download');
    }
  }
}
module.exports = { DownloadManager };
