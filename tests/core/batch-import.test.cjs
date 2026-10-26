'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUrlList } = require('../../src/core/batch-import.cjs');
test('batch parser canonicalizes, deduplicates fragments and preserves meaningful query and Unicode', () => {
  const input = ' https://EXAMPLE.com:443/tệp.zip?a=1#one\r\nhttps://example.com/tệp.zip?a=1#two\nhttps://example.com/tệp.zip?a=2\n\n';
  const parsed = parseUrlList(input);
  assert.deepEqual(parsed.urls, ['https://example.com/t%E1%BB%87p.zip?a=1', 'https://example.com/t%E1%BB%87p.zip?a=2']);
  assert.equal(parsed.duplicates, 1); assert.deepEqual(parsed.errors, []);
});
test('batch parser reports line errors without echoing unsafe URLs or embedded credentials', () => {
  const parsed = parseUrlList('https://example.com/good\nftp://example.com/file\nhttps://secret:password@example.com/private\nnot a URL\nhttps://example.com/end');
  assert.deepEqual(parsed.errors.map(error => error.line), [2, 3, 4]); assert.equal(parsed.urls.length, 2);
  assert.doesNotMatch(JSON.stringify(parsed.errors), /secret|password|private/);
});
test('batch parser rejects oversized inputs, too many nonempty lines, invalid type and overlong URL', () => {
  assert.throws(() => parseUrlList(null), /text|string/i);
  assert.throws(() => parseUrlList('a'.repeat(512 * 1024 + 1)), /size|512|limit/i);
  assert.throws(() => parseUrlList('https://example.com/a\n'.repeat(1001)), /1000|limit/i);
  assert.equal(parseUrlList('https://example.com/' + 'a'.repeat(32769)).errors.length, 1);
  assert.equal(parseUrlList('https://example.com/\n' + 'x\n'.repeat(999)).errors.length, 999);
});
test('batch parser bounds canonical encoded aggregate as well as raw UTF8 bytes', () => {
  const lines = Array.from({ length: 60 }, (_, index) => 'https://example.com/' + '界'.repeat(1000) + '/' + index).join('\n');
  assert.ok(Buffer.byteLength(lines) < 512 * 1024);
  assert.throws(() => parseUrlList(lines), /size|512|limit/i);
});
test('batch parser refuses embedded controls instead of silently changing the URL', () => {
  assert.equal(parseUrlList('https://example.com/ab\tcd').errors.length, 1);
  assert.equal(parseUrlList('https://example.com/ab\u0000cd').errors.length, 1);
});
