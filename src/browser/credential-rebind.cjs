'use strict';
const crypto = require('node:crypto');
const { checkedUrl, integer } = require('../core/policy.cjs');

function originOf(value) {
  const url = checkedUrl(value); if (url.origin !== value) throw Error('An exact HTTP/HTTPS origin is required');
  return value;
}
function createCredentialRebind(manager, { ttlMs = 120000, maxPending = 8, now = Date.now } = {}) {
  integer(ttlMs, 1, 120000, 'Credential request lifetime'); integer(maxPending, 1, 8, 'Pending credential requests');
  const pending = new Map(), operations = new Set(); let closed = false;
  const ready = () => { if (closed) throw Error('Browser reconnection is closed'); manager._ready(); };
  const taskFor = id => manager.list().find(task => task.id === id);
  const eligible = task => task && ['paused', 'failed'].includes(task.status) && ['direct', 'hls'].includes(task.mediaType || 'direct');
  function discard(entry) {
    if (pending.get(entry.requestId) === entry) pending.delete(entry.requestId);
    clearTimeout(entry.timer); entry.controller.abort(); entry.prepared?.discard(); entry.prepared = null;
  }
  function prune() {
    for (const entry of pending.values()) {
      const task = taskFor(entry.taskId);
      if (entry.expiresAt <= now() || !eligible(task) || task.url !== entry.url) discard(entry);
    }
  }
  const dto = entry => Object.fromEntries(['requestId', 'taskId', 'origin', 'url', 'filename', 'expiresAt'].map(key => [key, entry[key]]));
  function request(taskId) {
    ready(); prune(); const task = taskFor(taskId);
    if (['dash', 'youtube'].includes(task?.mediaType)) throw Error('blocked-by-adapter: authenticated DASH/YouTube is not supported');
    if (!eligible(task)) throw Error('Pause an HTTP/HLS download before reconnecting its browser session');
    if (task.url.length > 16384) throw Error('Download URL exceeds browser reconnection size limit');
    for (const entry of pending.values()) if (entry.taskId === taskId) discard(entry);
    if (pending.size >= maxPending) throw Error('Too many pending browser reconnection requests');
    const entry = { requestId: crypto.randomUUID(), taskId, origin: new URL(task.url).origin, url: task.url, filename: task.filename, expiresAt: now() + ttlMs, state: 'pending', controller: new AbortController(), prepared: null };
    entry.timer = setTimeout(() => discard(entry), ttlMs); entry.timer.unref(); pending.set(entry.requestId, entry);
    return dto(entry);
  }
  function requests(origin) {
    ready(); originOf(origin); prune();
    return [...pending.values()].filter(entry => entry.origin === origin && entry.state === 'pending').map(dto);
  }
  function binding(input, withHeaders = false) {
    ready(); prune();
    const fields = ['taskId', 'origin', 'requestId', ...(withHeaders ? ['headers'] : [])];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) throw Error('Invalid browser reconnection binding');
    originOf(input.origin);
    const entry = pending.get(input.requestId);
    if (!entry) throw Error('Browser reconnection request expired or is unavailable');
    if (entry.taskId !== input.taskId || entry.origin !== input.origin) throw Error('Browser reconnection task or origin does not match');
    return entry;
  }
  async function prepare(input, { signal } = {}) {
    const entry = binding(input, true);
    if (entry.state !== 'pending') throw Error('Browser reconnection preparation is already in progress');
    entry.state = 'preparing';
    const active = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    const operation = (async () => {
      try {
        active.throwIfAborted();
        entry.prepared = await manager.prepareHeaderRebind(entry.taskId, input.headers, { signal: active });
        active.throwIfAborted(); ready(); prune();
        if (pending.get(entry.requestId) !== entry) throw Error('Browser reconnection request expired or changed');
        entry.state = 'prepared'; return { id: entry.taskId, prepared: true };
      } catch (error) { discard(entry); throw error; }
    })();
    operations.add(operation); try { return await operation; } finally { operations.delete(operation); }
  }
  async function commit(input, { signal } = {}) {
    const entry = binding(input);
    if (entry.state !== 'prepared' || !entry.prepared) throw Error('Browser credentials must be prepared before committing');
    entry.state = 'committing';
    const operation = (async () => {
      try { signal?.throwIfAborted(); await entry.prepared.commit({ signal }); return { id: entry.taskId }; }
      finally { discard(entry); }
    })();
    operations.add(operation); try { return await operation; } finally { operations.delete(operation); }
  }
  async function cancel(input) { const entry = binding(input); discard(entry); return { id: entry.taskId }; }
  async function close() { closed = true; for (const entry of pending.values()) discard(entry); await Promise.allSettled([...operations]); }
  return { request, requests, prepare, commit, cancel, close };
}
module.exports = { createCredentialRebind };
