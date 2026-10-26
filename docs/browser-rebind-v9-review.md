# Task 5 bounded code/security review

Baseline: `9e7fd2a` (0.8.0). Scope: the new browser credential-rebind flow, native protocol operations, Firefox manifest/export/native registration, and desktop/popup integration. This is not an audit of unchanged download engines or Task 6–10.

An independent fresh-context reviewer inspected RAM-only two-phase preparation/commit, task/source/origin/nonce binding and expiry, trusted popup/current-tab checks, rollback on journal failure, cancellation on native timeout/disconnect, HLS identity preservation, and Firefox's separate host/manifest and scoped 32-bit Windows registration. The reviewer independently ran the five new credential/Firefox unit/integration test files: **34 passed, zero failed/skipped**. No reproducible actionable P1/P2 regression was identified in that review snapshot.

The first broad unit run exposed an existing exact probe-DTO assertion that omitted the new `contentType` field. The fixture now supplies `video/mp4` and verifies its returned metadata explicitly. The new field lets credential preflight reject HTML/login responses even when no bytes or validator have been saved yet; the generic HTTP download API still permits deliberate HTML downloads.

Parent verification subsequently reproduced and corrected an HTML media-type whitespace variant (`TEXT/HTML ; charset=utf-8`): the zero-byte credential test failed before media-type token normalization and passed afterward. The focused core/bridge/identity suite passed **22/22** after this fix. Browser end-to-end testing also identified the Firefox MV2 optional-host-permission mapping difference; the generated manifest retains Chromium's optional origin patterns in Firefox's `optional_permissions` field. These test-driven corrections are separate from the independent review result.

## Authorization boundary

The user explicitly starts reconnection in the desktop application for a stopped HTTP/HLS task. Pending nonces live only in RAM, expire after two minutes and are capped at eight. Preparation probes the unchanged source and validates retained content identity without installing new headers. The trusted extension popup rechecks its current tab, per-origin consent and optional permissions before a separate commit request. Headers are installed only in manager RAM; the task stays paused until the user resumes it.

The last browser permission/context check before commit dispatch is the authorization point. Revoking permission afterward cannot retract credentials already transmitted or committed; the feature does not claim retroactive revocation of an existing download session. Timeout/disconnect during outstanding preparation cancels that work, and cancellation/expiry discards staged headers. Preparation/commit ACKs carry only the matching task ID and preparation flag, never header values. Same-origin challenge listings intentionally return the nonce over the private bridge to the trusted popup; Cookie/Authorization values and pending nonces are not written to browser storage or download journals.

Authenticated DASH/YouTube remains explicitly `blocked-by-adapter`; the new flow accepts only HTTP/HLS. Existing source identity, HTTP range and HLS resource checks remain active. Firefox tests and release artifact verification are tracked separately in the release report; a unit result is not evidence of native Firefox or packaged execution.

## Subsequent Firefox ownership delta

Real Firefox testing showed pause at zero bytes cancels rather than preserving a resumable paused item. The later Firefox-only ACK-before-cancel branch and optional-origin manifest mapping received a separate bounded review of the newly added lines. The reviewer independently ran17/17 Firefox-filtered extension/setup and23/23 existing Chromium capture cases; no confirmed P1/P2 was found. Chromium behavior remains unchanged. Firefox fresh-state, safe/nonincognito/same-URL/consent checks and post-cancel USER_CANCELED verification remain mandatory. Real packaged0.9 Firefox and Chromium journeys subsequently passed; see VERIFICATION_V9.md.
