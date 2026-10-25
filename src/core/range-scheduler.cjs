'use strict';

function safeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  }
}

// Call only after the owning worker has settled. The new pending range has no
// index: the caller assigns a fresh index before persisting the new ownership.
function splitPendingRange(range, minBytes) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new TypeError('range must be an object.');
  }
  safeInteger(minBytes, 'minBytes', 1);
  safeInteger(range.start, 'range.start');
  safeInteger(range.received, 'range.received');
  if (Object.hasOwn(range, 'index')) safeInteger(range.index, 'range.index');
  if (range.end === null || range.end === undefined) return null;
  safeInteger(range.end, 'range.end', -1);
  if (range.end < range.start - 1) throw new RangeError('range.end precedes range.start.');
  const length = range.end - range.start + 1;
  safeInteger(length, 'range length');
  if (range.received > length) throw new RangeError('range.received exceeds range length.');
  const remaining = length - range.received;
  const retainedPendingBytes = Math.floor(remaining / 2);
  // Division avoids overflowing 2 * minBytes at the safe integer boundary.
  if (retainedPendingBytes < minBytes) return null;
  const pendingStart = range.start + range.received + retainedPendingBytes;
  return {
    retained: { ...range, end: pendingStart - 1 },
    pending: { start: pendingStart, end: range.end, received: 0 }
  };
}

module.exports = { splitPendingRange };
