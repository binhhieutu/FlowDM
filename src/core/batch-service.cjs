'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { checkedUrl, integer } = require('./policy.cjs');
const { parseUrlList } = require('./batch-import.cjs');
const { crawlLinks } = require('./site-grabber.cjs');
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw Error('Invalid batch input');
}
const safeError = error => String(error?.message || error).replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 300);
function selectedUrls(urls) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 1000 || urls.some(url => typeof url !== 'string' || /[\r\n]/.test(url))) throw Error('Select 1–1000 valid URLs');
  const parsed = parseUrlList(urls.join('\n'));
  if (parsed.errors.length) throw Error('Selected list contains an invalid URL');
  if (!parsed.urls.length) throw Error('Select at least one URL');
  return parsed.urls;
}
class BatchService extends EventEmitter {
  constructor(manager, { crawl = crawlLinks } = {}) {
    super(); this.manager = manager; this.crawl = crawl; this.job = null; this.worker = null; this.controller = null; this.closed = false; this.submitting = false;
  }
  ready() { if (this.closed) throw Error('Batch service is closed'); }
  previewBatch(input) { this.ready(); fields(input, ['text']); return parseUrlList(input.text); }
  async submitBatch(input) {
    this.ready(); fields(input, ['urls', 'queueId', 'directory', 'connections']);
    if (this.submitting) throw Error('Batch submit busy');
    const urls = selectedUrls(input.urls), queueId = input.queueId ?? 'default';
    if (typeof queueId !== 'string' || !this.manager.listQueues().some(queue => queue.id === queueId)) throw Error('Queue not found');
    if (input.directory !== undefined && (typeof input.directory !== 'string' || !path.isAbsolute(input.directory))) throw Error('Absolute destination required');
    const connections = integer(input.connections ?? 4, 1, 16, 'Connections');
    this.submitting = true;
    const created = [], errors = [];
    try {
      for (const [index, url] of urls.entries()) {
        if (this.closed) { errors.push({ index, message: 'Batch service closed' }); break; }
        try { created.push(await this.manager.add({ url, queueId, connections, checkDuplicate: true, ...(input.directory === undefined ? {} : { directory: input.directory }) })); }
        catch (error) { errors.push({ index, message: safeError(error) }); }
      }
      return { created, errors };
    } finally { this.submitting = false; }
  }
  listGrabs() { return this.job ? [structuredClone(this.job)] : []; }
  publish() { const value = structuredClone(this.job); this.emit('change', value); return value; }
  startGrab(input) {
    this.ready(); fields(input, ['seed', 'maxDepth', 'maxPages']);
    if (this.job?.status === 'running') throw Error('Site Grabber busy');
    const seed = checkedUrl(input.seed).href;
    const maxDepth = integer(input.maxDepth ?? 2, 0, 2, 'Depth'), maxPages = integer(input.maxPages ?? 100, 1, 100, 'Pages');
    this.controller = new AbortController();
    this.job = { id: randomUUID(), status: 'running', pages: 0, links: [], errors: [] };
    const job = this.job, signal = this.controller.signal;
    this.worker = Promise.resolve().then(() => this.runGrab(job, { seed, maxDepth, maxPages, signal }));
    this.publish(); return { id: job.id };
  }
  async runGrab(job, options) {
    const links = new Map(); let bytes = 0;
    try {
      for await (const page of this.crawl(options)) {
        options.signal.throwIfAborted(); job.pages++;
        if (page.error) job.errors = [...job.errors, { message: safeError(page.error) }].slice(-100);
        for (const item of page.links || []) {
          const url = checkedUrl(item.url); url.hash = '';
          if (url.origin !== new URL(options.seed).origin || links.has(url.href)) continue;
          const size = Buffer.byteLength(url.href, 'utf8');
          if (links.size >= 1000 || bytes + size > 512 * 1024) continue;
          links.set(url.href, { url: url.href, text: String(item.text || '').slice(0, 180) }); bytes += size;
        }
        job.links = [...links.values()]; this.publish();
      }
      job.status = 'completed';
    } catch (error) {
      job.status = options.signal.aborted ? 'cancelled' : 'failed';
      if (!options.signal.aborted) job.error = safeError(error);
    }
    this.publish();
  }
  async cancelGrab(input) {
    fields(input, ['id']);
    if (!this.job || input.id !== this.job.id) throw Error('Grab not found');
    this.controller?.abort(); await this.worker; return structuredClone(this.job);
  }
  async close() { this.closed = true; this.controller?.abort(); await this.worker; }
}
module.exports = { BatchService, selectedUrls };
