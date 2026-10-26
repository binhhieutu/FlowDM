'use strict';
const { createHash } = require('node:crypto');
const { canonicalUrl } = require('./batch-import.cjs');
const { checkedDownloadUrl } = require('./policy.cjs');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function duplicateKey(input) {
  const parsed = checkedDownloadUrl(input.url); parsed.hash = '';
  const inferred = ['ftp:', 'ftps:'].includes(parsed.protocol) ? 'ftp' : /\.m3u8$/i.test(parsed.pathname) ? 'hls' : /\.mpd$/i.test(parsed.pathname) ? 'dash' : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname) ? 'youtube' : 'direct';
  return JSON.stringify([parsed.href, !input.mediaType || input.mediaType === 'auto' ? inferred : input.mediaType, stable(input.selection || null)]);
}
function findDuplicate(input, tasks) {
  const key = duplicateKey(input);
  return tasks.find(task => { try { return duplicateKey(task) === key; } catch { return false; } }) || null;
}
function clipboardSuggestion(text, tasks) {
  if (typeof text !== 'string' || text.length > 32768 || /[\r\n]/.test(text)) return null;
  try {
    const url = canonicalUrl(text.trim());
    if (findDuplicate({ url }, tasks)) return null;
    return { url, display: new URL(url).origin + '/ (đường dẫn/query ẩn)' };
  } catch { return null; }
}
class ClipboardWatcher {
  constructor({ readText, tasks, onSuggest }) { this.readText = readText; this.tasks = tasks; this.onSuggest = onSuggest; this.enabled = false; this.lastDigest = null; }
  setEnabled(value) {
    if (typeof value !== 'boolean') throw Error('Clipboard opt-in must be boolean');
    this.enabled = value; this.lastDigest = null; clearInterval(this.timer);
    if (value) { this.timer = setInterval(() => this.tick(), 1500); this.timer.unref?.(); }
  }
  tick() {
    if (!this.enabled) return;
    let text; try { text = this.readText(); } catch { return; }
    if (typeof text !== 'string' || text.length > 32768) return;
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    const value = clipboardSuggestion(text, this.tasks()); if (value) this.onSuggest(value);
  }
  close() { this.enabled = false; this.lastDigest = null; clearInterval(this.timer); }
}
module.exports = { duplicateKey, findDuplicate, clipboardSuggestion, ClipboardWatcher };
