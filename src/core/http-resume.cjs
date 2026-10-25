'use strict';

// RFC 9110 entity tags are quoted opaque strings. A weak tag or a date cannot
// establish byte identity, even when the server reports the same length.
function isStrongEtag(validator) {
  return validator?.type === 'etag' && typeof validator.value === 'string' &&
    /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(validator.value);
}
function identityEncoding(value) {
  return value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'identity');
}
function assessHttpResume({ saved, probed }) {
  const refuse = reason => ({ allowed: false, reason });
  if (!saved || !probed) return refuse('Missing HTTP resume identity. Keep the partial file and start a new task.');
  if (!isStrongEtag(saved.validator) || !isStrongEtag(probed.validator)) return refuse('A matching strong ETag is required to resume safely.');
  if (saved.validator.value !== probed.validator.value) return refuse('Remote file validator changed. Existing bytes were preserved.');
  const savedTotal = saved.total === undefined ? saved.totalBytes : saved.total;
  const probedTotal = probed.total === undefined ? probed.totalBytes : probed.total;
  if (![savedTotal, probedTotal].every(value => Number.isSafeInteger(value) && value > 0) || savedTotal !== probedTotal) return refuse('Remote file size is missing or changed. Existing bytes were preserved.');
  if (saved.ranges !== true || probed.ranges !== true) return refuse('The source must honor byte ranges to resume safely.');
  // Schema v4 direct downloads already rejected non-identity representations;
  // their missing encoding field therefore means identity, rather than unknown.
  if (!identityEncoding(saved.contentEncoding) || !identityEncoding(probed.contentEncoding)) return refuse('Encoded representations cannot be resumed safely.');
  if (saved.finalUrl && probed.finalUrl) {
    try {
      if (new URL(saved.finalUrl).origin !== new URL(probed.finalUrl).origin) return refuse('Redirect origin changed. Existing bytes were preserved.');
    } catch { return refuse('Invalid HTTP source identity.'); }
  }
  return { allowed: true, reason: null };
}
module.exports = { assessHttpResume, isStrongEtag, identityEncoding };
