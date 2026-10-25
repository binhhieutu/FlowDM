'use strict';
const crypto = require('node:crypto');
const { checkedUrl } = require('./policy.cjs');
const { selectionFormat } = require('../media/catalog.cjs');
const clone = value => structuredClone(value);
class MediaCatalogService {
  constructor(inspector) { this.inspector = inspector; this.catalogs = new Map(); this.controllers = new Set(); this.operations = new Set(); this.closed = false; }
  async inspect(input) {
    if (this.closed || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'mediaType'].includes(key))) throw Error('Media inspection options are required');
    const url = checkedUrl(input.url).href; const parsed = new URL(url);
    const mediaType = input.mediaType || (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname) ? 'youtube' : /\.mpd$/i.test(parsed.pathname) ? 'dash' : null);
    if (!['dash', 'youtube'].includes(mediaType)) throw Error('Format selection is available for YouTube and DASH');
    if (this.operations.size >= 2) throw Error('Wait for the current media inspections to finish');
    const controller = new AbortController(); this.controllers.add(controller);
    const operation = Promise.resolve().then(() => this.inspector({ url, mediaType, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }));
    this.operations.add(operation); let catalog;
    try { catalog = clone(await operation); } finally { this.controllers.delete(controller); this.operations.delete(operation); }
    if (this.closed) throw Error('Media inspection stopped');
    if (!catalog || !Array.isArray(catalog.formats) || !Array.isArray(catalog.subtitles) || !Array.isArray(catalog.entries) || catalog.formats.length > 2000 || catalog.subtitles.length > 200 || catalog.entries.length > 100) throw Error('Invalid or oversized media catalog');
    for (const [key, value] of this.catalogs) if (value.expiresAt <= Date.now()) this.catalogs.delete(key);
    while (this.catalogs.size >= 16) this.catalogs.delete(this.catalogs.keys().next().value);
    const catalogId = crypto.randomUUID(); this.catalogs.set(catalogId, { url, mediaType, catalog, expiresAt: Date.now() + 10 * 60 * 1000 });
    return { ...clone(catalog), catalogId };
  }
  _get(id) {
    const saved = typeof id === 'string' && this.catalogs.get(id);
    if (!saved || saved.expiresAt <= Date.now()) throw Error('Media inspection expired. Inspect the link again before choosing formats.');
    return saved;
  }
  resolve({ url, mediaType, selection, catalogId }) {
    const saved = this._get(catalogId);
    if (saved.url !== url || saved.mediaType !== mediaType || saved.catalog.entries.length) throw Error('Media inspection does not match this download');
    return selectionFormat(selection, saved.catalog);
  }
  playlist(catalogId, ids) {
    const saved = this._get(catalogId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw Error('Choose 1–100 distinct playlist entries');
    const entries = ids.map(id => saved.catalog.entries.find(entry => entry.id === id));
    if (entries.some(entry => !entry || !/^[A-Za-z0-9_-]{11}$/.test(entry.id) || entry.url !== `https://www.youtube.com/watch?v=${entry.id}`)) throw Error('Playlist entry does not belong to the inspected list');
    return clone(entries);
  }
  async close() {
    this.closed = true; for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.operations]); this.catalogs.clear();
  }
}
function playlistFilename(entry) {
  let title = String(entry.title || entry.id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  while (Buffer.byteLength(title, 'utf8') > 140) title = [...title].slice(0, -1).join('');
  return `video-${title || entry.id}-${entry.id}.mp4`;
}
module.exports = { MediaCatalogService, playlistFilename };
