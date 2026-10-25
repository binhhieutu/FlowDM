'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPendingRange } = require('../../src/core/range-scheduler.cjs');

test('split divides only the uncommitted suffix without mutating its range', () => {
  const range = Object.freeze({ index: 7, start: 100, end: 119, received: 4 });
  const result = splitPendingRange(range, 4);
  assert.deepEqual(result, {
    retained: { index: 7, start: 100, end: 111, received: 4 },
    pending: { start: 112, end: 119, received: 0 }
  });
  assert.deepEqual(range, { index: 7, start: 100, end: 119, received: 4 });
  assert.notEqual(result.retained, range);
});

test('inclusive odd and threshold ranges keep both pending portions large enough', () => {
  assert.deepEqual(splitPendingRange({ start: 0, end: 4, received: 0 }, 2), {
    retained: { start: 0, end: 1, received: 0 },
    pending: { start: 2, end: 4, received: 0 }
  });
  assert.equal(splitPendingRange({ start: 0, end: 2, received: 0 }, 2), null);
  assert.deepEqual(splitPendingRange({ start: 0, end: 1, received: 0 }, 1), {
    retained: { start: 0, end: 0, received: 0 },
    pending: { start: 1, end: 1, received: 0 }
  });
});

test('unknown, empty, complete and tiny ranges do not split', () => {
  for (const range of [
    { start: 0, end: null, received: 0 }, { start: 0, received: 0 },
    { start: 0, end: -1, received: 0 }, { start: 100, end: 99, received: 0 },
    { start: 4, end: 7, received: 4 }, { start: 4, end: 7, received: 3 }
  ]) assert.equal(splitPendingRange(range, 1), null);
});

test('large safe offsets and limits never overflow or lose bytes', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(splitPendingRange({ start: max - 8, end: max, received: 3 }, 3), {
    retained: { start: max - 8, end: max - 3, received: 3 },
    pending: { start: max - 2, end: max, received: 0 }
  });
  const range = { start: 1, end: max, received: 1 };
  assert.equal(splitPendingRange(range, max), null);
  const result = splitPendingRange(range, 1);
  assert.equal(result.retained.end + 1, result.pending.start);
  assert.equal(result.retained.received, 1);
  assert.equal(result.pending.end, max);
});

test('repeated splits have disjoint exact coverage and preserve committed progress', () => {
  let ranges = [{ index: 0, start: 10, end: 1009, received: 37 }];
  for (let i = 0; i < 8; i++) {
    ranges = ranges.flatMap(range => {
      const split = splitPendingRange(range, 3);
      return split ? [split.retained, split.pending] : [range];
    });
  }
  assert.equal(ranges[0].start, 10);
  assert.equal(ranges.at(-1).end, 1009);
  assert.equal(ranges.reduce((sum, range) => sum + range.received, 0), 37);
  assert.equal(ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0), 1000);
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i].start, ranges[i - 1].end + 1);
    assert.equal(ranges[i].received, 0);
    assert.equal(Object.hasOwn(ranges[i], 'index'), false);
  }
});

test('invalid range values and split limits fail clearly', () => {
  for (const value of [null, undefined, [], 'range', 42]) {
    assert.throws(() => splitPendingRange(value, 1), /range/i);
  }
  const valid = { index: 0, start: 1, end: 10, received: 0 };
  for (const minBytes of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => splitPendingRange(valid, minBytes), /minBytes/i);
  }
  for (const patch of [
    { start: -1 }, { start: '1' }, { start: 1.5 }, { start: Infinity },
    { end: -2 }, { end: '10' }, { end: 1.5 }, { end: NaN },
    { received: -1 }, { received: 11 }, { received: '0' }, { received: undefined },
    { received: Number.MAX_SAFE_INTEGER + 1 }, { index: -1 }, { index: 1.5 },
    { start: 0, end: Number.MAX_SAFE_INTEGER }, { end: 0, received: 1 }
  ]) assert.throws(() => splitPendingRange({ ...valid, ...patch }, 1), /range|start|end|received|index/i);
});
