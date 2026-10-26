'use strict';
const http = require('node:http');
const https = require('node:https');
const { canonicalUrl, MAX_URLS, MAX_TEXT_BYTES } = require('./batch-import.cjs');
const { extractLinks } = require('./html-links.cjs');
const MAX_HTML = 2 * 1024 * 1024;
function deadline(milliseconds, parent) {
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  if (parent?.aborted) forward();
  else parent?.addEventListener('abort', forward, { once: true });
  // Own the controller for the full timer lifetime. This also keeps the short
  // page deadline independent of the lifetime of any longer parent deadline.
  const timer = setTimeout(() => controller.abort(Error('Crawler deadline exceeded')), milliseconds);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', forward); } };
}
function checkOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['seed', 'maxDepth', 'maxPages', 'signal'].includes(key))) throw Error('Invalid crawler options');
  const seed = canonicalUrl(options.seed), maxDepth = options.maxDepth ?? 2, maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 2 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('Crawler limits: depth 0–2, pages 1–100');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error('Invalid crawler cancellation signal');
  return { seed, maxDepth, maxPages, signal: options.signal };
}
async function responseFor(url, signal) {
  const response = await new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? https : http;
    const request = transport.get(url, { headers: { 'accept-encoding': 'identity', accept: 'text/html, application/xhtml+xml' }, signal }, resolve);
    request.on('error', reject);
  });
  response.on('error', () => {});
  // Own cancellation until the response body is finished, not only until headers
  // arrive. The close listener also retains the composed deadline signal for
  // the full stream lifetime and removes the listener on every terminal path.
  const abort = () => response.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  response.once('close', () => signal.removeEventListener('abort', abort));
  if (signal.aborted) abort();
  return response;
}
async function readPage(url, context, signal) {
  let current = url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (context.requests >= context.maxPages) throw Error('Page request budget reached');
    if (context.requested.has(current)) throw Error('Redirect points to a previously visited page');
    context.requested.add(current); context.requests++;
    const response = await responseFor(current, signal);
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (!response.headers.location || redirect === 5) throw Error('Redirect limit or missing location');
        const next = canonicalUrl(new URL(response.headers.location, current).href);
        if (new URL(next).origin !== context.origin) throw Error('Cross-origin redirect refused');
        current = next; continue;
      }
      if (response.statusCode !== 200) throw Error([401, 403].includes(response.statusCode) ? 'Page requires access or authentication' : 'Page returned HTTP ' + response.statusCode);
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers['content-type'] || '')) throw Error('Page is not HTML');
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers['content-type'] || '')?.[1].toLowerCase();
      if (charset && !['utf8', 'utf-8', 'us-ascii'].includes(charset)) throw Error('Only UTF-8 HTML is supported');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw Error('Encoded HTML is unsupported');
      if (response.headers['content-length'] && Number(response.headers['content-length']) > MAX_HTML) throw Error('HTML size limit exceeded');
      const chunks = []; let bytes = 0;
      for await (const chunk of response) { bytes += chunk.length; if (bytes > MAX_HTML) throw Error('HTML size limit exceeded'); chunks.push(chunk); }
      return { url: current, html: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
    } finally { response.destroy(); }
  }
  throw Error('Redirect limit reached');
}
// Follow an explicit page-extension subset. Other anchor URLs stay in preview
// without fetching their bodies; a filename alone cannot prove HTML content.
function navigable(url) { const pathname = new URL(url).pathname; return !/\.[^/]+$/.test(pathname) || /\.(?:html?|xhtml|php\d*|aspx?|jsp|cgi|cfm)$/i.test(pathname); }
// Sequential network access is intentional: one active request is below the
// two-request ceiling and makes cancellation and request-budget accounting exact.
async function* crawlLinks(options) {
  const { seed, maxDepth, maxPages, signal } = checkOptions(options);
  signal?.throwIfAborted();
  const total = deadline(60000, signal), totalSignal = total.signal;
  const context = { origin: new URL(seed).origin, requests: 0, maxPages, requested: new Set() };
  const pending = [{ url: seed, depth: 0 }], enqueued = new Set([seed]), discovered = new Set(); let resultBytes = 0;
  try { while (pending.length && context.requests < maxPages && discovered.size < MAX_URLS) {
    totalSignal.throwIfAborted();
    const page = pending.shift(); if (context.requested.has(page.url)) continue;
    const pageDeadline = deadline(10000, totalSignal), pageSignal = pageDeadline.signal;
    try {
      const result = await readPage(page.url, context, pageSignal), parsed = extractLinks(result.html, result.url), links = [];
      if (parsed.protectedPage) { yield { url: result.url, depth: page.depth, links, error: 'Page contains a password form; authenticated crawling is unsupported' }; continue; }
      for (const link of parsed.links) {
        if (discovered.has(link.url)) continue;
        const bytes = Buffer.byteLength(link.url, 'utf8') + 1;
        if (discovered.size >= MAX_URLS || resultBytes + bytes > MAX_TEXT_BYTES) break;
        discovered.add(link.url); resultBytes += bytes; links.push(link);
        if (page.depth < maxDepth && navigable(link.url) && !enqueued.has(link.url)) { enqueued.add(link.url); pending.push({ url: link.url, depth: page.depth + 1 }); }
      }
      yield { url: result.url, depth: page.depth, links };
    } catch (error) {
      totalSignal.throwIfAborted();
      const message = pageSignal.aborted ? 'Page fetch timed out' : error.message;
      yield { url: page.url, depth: page.depth, links: [], error: message };
    } finally { pageDeadline.dispose(); }
  } } finally { total.dispose(); }
}
module.exports = { crawlLinks };
