'use strict';
const { canonicalUrl } = require('./batch-import.cjs');
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', colon: ':', sol: '/', period: '.', Tab: '\t', NewLine: '\n' };
function decode(value, strict = false) {
  let unknown = false;
  const result = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, entity, offset, source) => {
    if (entity[0] !== '#') {
      if (!whole.endsWith(';') && (!['amp', 'quot', 'lt', 'gt', 'nbsp'].includes(entity) || (strict && /[a-z0-9=]/i.test(source[offset + whole.length] || '')))) return whole;
      if (Object.hasOwn(ENTITIES, entity)) return ENTITIES[entity];
      unknown = true; return whole;
    }
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
  });
  return strict && unknown ? null : result;
}
function attributes(tag) {
  const result = {};
  const source = tag.replace(/^<\/?[^\s/>]+/, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!Object.hasOwn(result, name)) result[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}
function tokenize(html) {
  const tokens = []; let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) { tokens.push({ text: html.slice(offset) }); break; }
    if (start > offset) tokens.push({ text: html.slice(offset, start) });
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); offset = end < 0 ? html.length : end + 3; continue; }
    let end = start + 1, quote = null;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= html.length) break;
    const raw = html.slice(start, end + 1), match = /^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(raw);
    offset = end + 1;
    if (!match) continue;
    const name = match[2].toLowerCase(), closing = !!match[1];
    if (!closing && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'].includes(name)) {
      if (name === 'plaintext') break;
      const pattern = new RegExp('</' + name + '\\s*>', 'gi'); pattern.lastIndex = offset;
      const close = pattern.exec(html); offset = close ? pattern.lastIndex : html.length; continue;
    }
    tokens.push({ name, closing, attributes: closing ? {} : attributes(raw) });
  }
  return tokens;
}
function extractLinks(html, pageUrl) {
  const candidates = []; let current = null, base = pageUrl, hasBase = false, templateDepth = 0, protectedPage = false;
  const finish = () => { if (current) { candidates.push(current); current = null; } };
  for (const token of tokenize(html)) {
    if (token.name === 'template') { templateDepth += token.closing ? -1 : 1; templateDepth = Math.max(0, templateDepth); continue; }
    if (templateDepth) continue;
    if (token.text !== undefined) { if (current && current.text.length < 1024) current.text += token.text.slice(0, 1024 - current.text.length); continue; }
    if (token.closing) { if (token.name === 'a') finish(); continue; }
    const attrs = token.attributes;
    if (token.name === 'input' && (decode(attrs.type || '').toLowerCase() === 'password' || /^(?:password|passwd)$/i.test(attrs.name || ''))) protectedPage = true;
    if (token.name === 'base' && !hasBase && Object.hasOwn(attrs, 'href')) {
      hasBase = true; const value = decode(attrs.href, true);
      try { base = value === null ? null : canonicalUrl(new URL(value, pageUrl).href); } catch { base = null; }
    }
    if (token.name === 'a' && Object.hasOwn(attrs, 'href')) { finish(); current = { href: attrs.href, text: '' }; }
  }
  finish();
  const origin = new URL(pageUrl).origin, seen = new Set(), links = [];
  for (const candidate of candidates) {
    const href = decode(candidate.href, true); if (href === null || href.length > 32768) continue;
    try {
      const absolute = base === null ? canonicalUrl(href) : canonicalUrl(new URL(href, base).href);
      if (new URL(absolute).origin !== origin || seen.has(absolute)) continue;
      seen.add(absolute); links.push({ url: absolute, text: decode(candidate.text).replace(/\s+/g, ' ').trim().slice(0, 180) });
    } catch { /* Unsupported or malformed links are not candidates. */ }
  }
  return { links, protectedPage };
}
module.exports = { extractLinks };
