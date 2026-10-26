'use strict';
const { checkedHeaders } = require('./policy.cjs');
const { prepareSourceReplacement } = require('./source-refresh.cjs');

function credentialHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 4) throw Error('Invalid browser credential headers');
  const names = Object.keys(input).map(name => name.toLowerCase());
  if (new Set(names).size !== names.length || names.some(name => !['cookie', 'authorization', 'referer', 'user-agent'].includes(name))) throw Error('Unsupported browser credential headers');
  const headers = checkedHeaders(input);
  if (!headers.cookie?.trim() && !headers.authorization?.trim()) throw Error('Browser session must include Cookie or Authorization');
  if (Object.entries(headers).reduce((size, [name, value]) => size + Buffer.byteLength(name) + Buffer.byteLength(value), 0) > 65536) throw Error('Browser credential headers exceed size limit');
  return headers;
}
function stopped(manager, id) {
  manager._ready(); const task = manager._require(id);
  if (['dash', 'youtube'].includes(task.mediaType)) throw Error('blocked-by-adapter: authenticated DASH/YouTube is not supported');
  if (!['paused', 'failed'].includes(task.status) || manager.running.has(id)) throw Error('Keep this download stopped before reconnecting the browser');
  return task;
}
async function prepareHeaderRebind(manager, id, input, { signal } = {}) {
  const task = stopped(manager, id); const fingerprint = JSON.stringify(task);
  let headers = credentialHeaders(input); const activeSignal = signal || AbortSignal.timeout(30000);
  activeSignal.throwIfAborted();
  await prepareSourceReplacement({ task: structuredClone(task), input: { url: task.url, headers }, checkpointDir: manager._mediaDirectory(id), maxBytes: manager.maxBytes, signal: activeSignal, credentialRebind: true });
  activeSignal.throwIfAborted(); manager._ready();
  let settled = false;
  return {
    discard() { settled = true; headers = null; },
    commit: ({ signal: commitSignal } = {}) => manager._mutate(async () => {
      if (settled) throw Error('Browser credential preparation is no longer available');
      settled = true;
      try {
        activeSignal.throwIfAborted(); commitSignal?.throwIfAborted(); const current = stopped(manager, id);
        if (JSON.stringify(current) !== fingerprint) throw Error('Download changed while reconnecting; request browser access again');
        const oldHeaders = manager.secrets.get(id);
        const updated = { ...current, status: 'paused', error: null, speed: 0, requiresHeaders: true };
        manager.tasks.set(id, updated); manager.secrets.set(id, headers);
        try { await manager._persist(); activeSignal.throwIfAborted(); commitSignal?.throwIfAborted(); manager._ready(); }
        catch (error) {
          manager.tasks.set(id, current);
          if (oldHeaders === undefined) manager.secrets.delete(id); else manager.secrets.set(id, oldHeaders);
          await manager._persist().catch(() => {}); throw error;
        }
        manager._notify(); return structuredClone(updated);
      } finally { headers = null; }
    })
  };
}
module.exports = { prepareHeaderRebind, credentialHeaders };
