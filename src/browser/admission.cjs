const { retryRequest, rangeInfo, contentLength } = require('../core/http-client.cjs');
const { checkedUrl } = require('../core/policy.cjs');
const { loadPlaylist } = require('../media/hls.cjs');
function createBrowserAdmission(manager, { timeoutMs = 2000, maxPending = 8, resolveTools = null } = {}) {
  let pending = 0;
  return async payload => {
    if (pending >= maxPending) throw new Error('Browser admission busy');
    pending++; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = checkedUrl(payload.url);
      const delegatedMedia = ['dash', 'youtube'].includes(payload.mediaType);
      if (delegatedMedia) {
        const resolve = resolveTools || require('../tools/media-tools.cjs').resolveTools;
        await resolve();
      }
      const hls = payload.mediaType === 'hls' || (payload.mediaType !== 'direct' && url.pathname.toLowerCase().endsWith('.m3u8'));
      if (hls) await loadPlaylist(url.href, payload.headers || {}, controller.signal);
      else if (!delegatedMedia) {
        const { response } = await retryRequest(url.href, { ...payload.headers, range: 'bytes=0-0' }, controller.signal);
        try {
          if (![200, 206].includes(response.statusCode)) throw new Error(`HTTP ${response.statusCode}`);
          if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers['content-type'] || '')) throw new Error('HTML/login response stays in browser');
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Encoded response stays in browser');
          const range = response.statusCode === 206 ? rangeInfo(response) : null;
          if (range && (range.start !== 0 || range.end !== 0)) throw new Error('Invalid probe range');
          const total = range?.total ?? contentLength(response);
          if (total !== null && total > manager.maxBytes) throw new Error('Download exceeds size limit');
        } finally { response.destroy(); }
      }
      if (controller.signal.aborted) throw new Error('Browser admission timed out');
      return await manager.add(payload);
    } finally { clearTimeout(timer); pending--; }
  };
}
module.exports = { createBrowserAdmission };
