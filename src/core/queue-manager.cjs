'use strict';
const { createHash } = require('node:crypto');
const { normalizeQueue, createDefaultQueue, evaluateQueues } = require('./queue-scheduler.cjs');
const SETTINGS = ['name', 'enabled', 'concurrency', 'speedLimit', 'schedule', 'onComplete'];
function settings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !SETTINGS.includes(key))) throw Error('Invalid queue settings');
}
class QueueCoordinator {
  constructor(manager, { clock = Date.now, powerController } = {}) {
    this.manager = manager; this.clock = clock; this.powerController = powerController;
    this.queues = new Map([['default', createDefaultQueue(manager.maxConcurrent)]]); this.blocked = 0;
    this.pendingCompletions = new Map(); this.pendingReceipts = new Map(); this.armedCompletion = null; this.powerEpoch = 0;
  }
  load(saved) {
    if (!saved) return [];
    if (!saved || !Number.isInteger(saved.version) || saved.version < 1 || saved.version > 8 || !Array.isArray(saved.tasks)) throw Error('Unsupported download journal');
    const tasks = structuredClone(saved.tasks), ids = new Set(tasks.map(task => task.id));
    if (ids.size !== tasks.length) throw Error('Duplicate journal task');
    let queues;
    if (saved.version < 7) {
      const queue = createDefaultQueue(this.manager.maxConcurrent); queue.taskIds = tasks.map(task => task.id); queues = [queue];
      for (const task of tasks) { task.queueId = 'default'; task.queueHold = false; }
    } else {
      if (!Array.isArray(saved.queues) || !saved.queues.length || saved.queues.length > 32) throw Error('Invalid journal queues');
      queues = saved.queues.map(queue => normalizeQueue(queue));
      if (new Set(queues.map(queue => queue.id)).size !== queues.length || queues.filter(queue => queue.id === 'default').length !== 1) throw Error('Invalid journal queue identities');
      const owners = new Map();
      for (const queue of queues) for (const id of queue.taskIds) {
        if (!ids.has(id) || owners.has(id)) throw Error('Invalid queue task ownership'); owners.set(id, queue.id);
      }
      if (owners.size !== tasks.length) throw Error('Unassigned journal task');
      for (const task of tasks) if (owners.get(task.id) !== task.queueId || typeof task.queueHold !== 'boolean') throw Error('Invalid task queue membership');
    }
    this.queues = new Map(queues.map(queue => [queue.id, queue]));
    this.pendingCompletions.clear(); this.pendingReceipts.clear(); this.armedCompletion = null; return tasks;
  }
  snapshot() { return structuredClone([...this.queues.values()]); }
  require(id) { const queue = this.queues.get(id); if (!queue) throw Error('Queue not found'); return queue; }
  cancelPower() {
    this.powerEpoch++;
    this.pendingCompletions.clear(); this.pendingReceipts.clear(); this.armedCompletion = null;
    this.powerController?.cancel('queue-changed');
  }
  attach(task, queueId = 'default') {
    const queue = this.require(queueId);
    if ([...this.queues.values()].some(candidate => candidate.taskIds.includes(task.id))) throw Error('Task is already assigned');
    this.cancelPower(); task.queueId = queueId; task.queueHold = false; queue.taskIds = [...queue.taskIds, task.id];
  }
  detach(id) {
    this.cancelPower();
    for (const queue of this.queues.values()) queue.taskIds = queue.taskIds.filter(taskId => taskId !== id);
  }
  evaluate() {
    const tasks = [...this.manager.tasks.values()].filter(task => !this.manager.pendingAdds?.has(task.id)).map(task => ({ ...task, requiresHeadersMissing: (!!task.requiresHeaders && !this.manager.secrets?.has(task.id)) || (task.requiresProxy && !this.manager.proxy) || (task.requiresFtpCredentials && !this.manager.ftpSecrets?.has(task.id)) }));
    return evaluateQueues({ queues: this.snapshot(), tasks, now: this.clock(), maxConcurrent: this.manager.maxConcurrent, maxPerHost: this.manager.maxPerHost });
  }
  async transaction(operation) {
    const previous = this.snapshot();
    const membership = new Map([...this.manager.tasks].map(([id, task]) => [id, { queueId: task.queueId, queueHold: task.queueHold }]));
    this.blocked++; this.cancelPower();
    try {
      const result = await operation(); await this.manager._persist(); return structuredClone(result);
    } catch (error) {
      this.queues = new Map(previous.map(queue => [queue.id, queue]));
      for (const [id, fields] of membership) { const task = this.manager.tasks.get(id); if (task) Object.assign(task, fields); }
      await this.manager._persist().catch(() => {}); throw error;
    } finally {
      this.blocked--; this.manager._notify?.(); this.manager._pump?.();
    }
  }
  async createQueue(input) {
    settings(input); if (this.queues.size >= 32) throw Error('Queue limit reached');
    const queue = normalizeQueue(input, { defaultConcurrency: this.manager.maxConcurrent });
    return this.transaction(() => { this.queues.set(queue.id, queue); return queue; });
  }
  async updateQueue(id, patch) {
    settings(patch); const queue = this.require(id);
    const allocationChange = ['concurrency', 'speedLimit', 'schedule'].some(key => Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(queue[key]));
    if (allocationChange && queue.taskIds.some(taskId => this.manager.running.has(taskId))) throw Error('Pause the queue before changing its limits or schedule');
    const next = normalizeQueue({ ...queue, ...patch });
    if (Object.hasOwn(patch, 'schedule') && JSON.stringify(patch.schedule) !== JSON.stringify(queue.schedule)) next.windowState = { key: null, closedKeys: [] };
    return this.transaction(() => { this.queues.set(id, next); return next; });
  }
  async deleteQueue(id) {
    const queue = this.require(id); if (id === 'default' || queue.taskIds.length) throw Error('Cannot delete the default or a nonempty queue');
    return this.transaction(() => { this.queues.delete(id); return true; });
  }
  async reorderQueue(id, taskIds) {
    const queue = this.require(id);
    if (!Array.isArray(taskIds) || taskIds.length !== queue.taskIds.length || new Set(taskIds).size !== taskIds.length || taskIds.some(taskId => !queue.taskIds.includes(taskId))) throw Error('Provide the exact queue task order');
    return this.transaction(() => { queue.taskIds = [...taskIds]; return queue; });
  }
  async moveTask(taskId, queueId, beforeTaskId = null) {
    const task = this.manager.tasks.get(taskId); if (!task) throw Error('Download not found');
    const destination = this.require(queueId), source = this.require(task.queueId);
    if (this.manager.running.has(taskId) || task.status === 'downloading') throw Error('Pause the download before moving it');
    if (beforeTaskId !== null && (beforeTaskId === taskId || !destination.taskIds.includes(beforeTaskId))) throw Error('Invalid destination order');
    return this.transaction(() => {
      source.taskIds = source.taskIds.filter(id => id !== taskId);
      const order = destination.taskIds.filter(id => id !== taskId), index = beforeTaskId === null ? order.length : order.indexOf(beforeTaskId);
      destination.taskIds = [...order.slice(0, index), taskId, ...order.slice(index)]; task.queueId = queueId;
      // A manual pause remains manual when moved; a scheduler-held task follows its destination.
      return task;
    });
  }
  async pauseQueue(id) { await this.updateQueue(id, { enabled: false }); await this.reconcile(); return structuredClone(this.require(id)); }
  async resumeQueue(id) { await this.updateQueue(id, { enabled: true }); await this.reconcile(); return structuredClone(this.require(id)); }
  async reconcile() {
    const previous = this.snapshot();
    let successful = false;
    this.blocked++;
    try {
      const decision = this.evaluate();
      if (decision.pauseIds.length || decision.runnableIds.some(id => this.manager.tasks.get(id)?.queueHold)) this.cancelPower();
      for (const transition of decision.queueTransitions) this.require(transition.queueId).windowState = structuredClone(transition.windowState);
      for (const id of decision.pauseIds) await this.manager._pause(id, { queueHold: true });
      const released = [];
      for (const id of decision.runnableIds) {
        const task = this.manager.tasks.get(id);
        if (task?.status === 'paused' && task.queueHold === true) { task.status = 'queued'; task.queueHold = false; released.push(task); }
      }
      try { await this.manager._persist(); }
      catch (error) {
        // Preserve stopped workers as paused; never resurrect a detached runtime.
        for (const task of released) { task.status = 'paused'; task.queueHold = true; }
        for (const queue of previous) this.require(queue.id).windowState = queue.windowState;
        this.manager.queueError = 'Cannot save queue schedule'; throw error;
      }
      for (const id of [...this.pendingReceipts.values()]) await this.completed(id);
      this.flushCompletions();
      this.manager.queueError = null; successful = true; return decision;
    } catch (error) {
      for (const queue of previous) this.require(queue.id).windowState = queue.windowState;
      this.manager.queueError = 'Cannot save queue schedule'; throw error;
    } finally { this.blocked--; this.manager._notify?.(); if (successful) this.manager._pump?.(); }
  }
  completionKey(queue) { return createHash('sha256').update(JSON.stringify([queue.onComplete, [...queue.taskIds].sort()])).digest('hex'); }
  allCompleted(queue) { return queue.taskIds.length > 0 && queue.taskIds.every(id => this.manager.tasks.get(id)?.status === 'completed' && !['pending', 'running', 'failed'].includes(this.manager.tasks.get(id)?.postScan?.status) && !this.manager.running.has(id)); }
  appIdle() { return this.manager.running.size === 0 && !this.manager.scanOperations?.size && [...this.manager.tasks.values()].every(task => ['completed', 'canceled'].includes(task.status) && !['pending', 'running', 'failed'].includes(task.postScan?.status)); }
  flushCompletions() {
    if (!this.appIdle() || this.armedCompletion) return;
    for (const intent of this.pendingCompletions.values()) {
      const queue = this.queues.get(intent.queueId);
      if (!queue?.enabled || queue.onComplete !== intent.action || queue.lastCompletionKey !== intent.intentId || this.completionKey(queue) !== intent.intentId || !this.allCompleted(queue)) continue;
      // One deterministic winner for an idle episode; no replacement countdown.
      this.pendingCompletions.clear(); this.armedCompletion = intent;
      this.powerController?.arm(intent); return;
    }
    this.pendingCompletions.clear();
  }
  async completed(id) {
    const task = this.manager.tasks.get(id); if (task?.status !== 'completed') return false;
    const queue = this.require(task.queueId); if (!queue.enabled || !this.allCompleted(queue)) return false;
    const key = this.completionKey(queue);
    if (queue.lastCompletionKey === key) { this.flushCompletions(); return false; }
    const previous = queue.lastCompletionKey, epoch = this.powerEpoch; this.blocked++;
    try {
      queue.lastCompletionKey = key;
      try { await this.manager._persist(); }
      catch (error) {
        queue.lastCompletionKey = previous;
        if (epoch === this.powerEpoch) this.pendingReceipts.set(queue.id, id);
        throw error;
      }
      this.pendingReceipts.delete(queue.id);
      if (epoch !== this.powerEpoch) return false;
      const intent = { intentId: key, queueId: queue.id, queueName: queue.name, action: queue.onComplete };
      if (queue.onComplete === 'notify' && !this.armedCompletion) this.powerController?.arm(intent);
      else if (['sleep', 'shutdown'].includes(queue.onComplete)) this.pendingCompletions.set(key, intent);
      this.flushCompletions();
      return true;
    } finally { this.blocked--; this.manager._notify?.(); }
  }
  async beforePowerDispatch(intent) {
    const queue = this.queues.get(intent?.queueId);
    if (!queue || !queue.enabled || queue.onComplete !== intent.action || queue.lastCompletionKey !== intent.intentId || this.completionKey(queue) !== intent.intentId || !this.allCompleted(queue)) return false;
    if (intent.action !== 'notify' && !this.appIdle()) return false;
    await this.manager._persist(); return true;
  }
}
module.exports = { QueueCoordinator };
