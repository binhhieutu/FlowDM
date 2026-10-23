# Browser v0.2 independent code/security review

Baseline: HEAD `bd65ba9` to working tree, 2026-10-23. Scope: extension, core/media, bridge, browser setup, and their implementation reports. Existing suites were not rerun by this reviewer. Focused reproductions below are Node/VM evidence; native browser operation and actual playback remain the primary E2E gate.

## Confirmed findings

### P1: synthetic page click triggered native downloads — fixed during review

`extension/content.js` originally ignored the trust flag on overlay clicks. A page controls video/source URLs and can call the injected button's `.click()`, causing the content script to report that URL as detected media and then invoke native download without user action. A focused content VM connected to the existing background fixture emitted one native request for `http://127.0.0.1:8000/private-export.mp4` after `button.click({isTrusted:false})`.

The extension owner added `event.isTrusted`; the identical reproduction then emitted zero native requests. A real trusted click still needs the primary browser E2E.

### P1: revoke during cookie lookup still forwards credentials — open at discovery

`extension/capture.js`, `cookieHeaders()`/`send()`: the newly added fallback checks consent before asynchronous cookie lookup. Revoking while getAll waits clears settings/cache, but the suspended send still forwards the returned cookie.

Focused reproduction: enable `https://a.test`, start send, wait until getAll starts, revoke origin, resolve getAll with `session=secret`. Observed native payload still contained that Cookie while current consent was false.

Repair: track origin consent generation, validate it after asynchronous permission/cookie work and before dispatch, and invalidate pending work on permission removal. Revoke then reenable must not authorize an earlier lookup. Test controlled promise suspension windows.

Delta check: a boolean consent recheck was added during review. It closes revoke-only forwarding, but the controlled reproduction with revoke then reenable still forwarded `session=stale-secret`; generation invalidation remains necessary. Aborting a stale handoff also preserves authenticated browser fallback; sending a headerless task and canceling the browser item can lose that download.

### P2: registration mutation precedes durable ownership record — open at discovery

`src/browser/setup.cjs`, original connect lines 69–71, disconnect lines 80–82: registry/native manifest mutation occurs before browser-setup.json saves the previous registration and ownership. Process death in that window leaves an installed host without its prior-owner rollback value; disconnect similarly leaves stale ownership metadata after restoring/removing registration. A registration adapter that mutates then rejects also bypasses connect's save-only rollback catch.

Repair: save durable write-ahead intent with browser, operation, exact previous snapshot and proposed/owned value before external mutation. Recover only when registration equals an expected old/new value, never overwrite an unrelated external value. Finalize or rollback then clear intent. Test fresh service recreation after set/remove mutates then rejects, plus old/new/external pending-intent fixtures.

### P2: legal-sized HLS master stalls Electron main — open at discovery

`src/media/hls.cjs`, original lines 21–26: each variant calls lines.indexOf over the full manifest, making parsing quadratic. A focused 18,000-variant, 787,791-byte master below the 1 MiB cap took 3,541 ms synchronously on the task machine. UI IPC, bridge ACK and pause/shutdown handling cannot run during this parse; nested masters can repeat it.

Repair: a single indexed traversal validates the following URI at its actual location and retains the best-bandwidth variant without sorting. Optionally cap variants. Regression should use a large master without brittle timing assertions.

## Other inspected boundaries

Bridge metadata/header allowlists, canonical payload fingerprints, queued-ID-only acknowledgment, header secrecy, HLS finite VOD/resource size checks, map ordering, publication, and restart-from-zero recovery were inspected. HTTP/HLS cross-origin redirect stripping and redirected-manifest child context were inspected; no additional concrete regression established there. Delayed ACK duplicates are already disclosed in the contract.

DRM, live, DASH, separate audio/video and explicitly rejected HLS features are exclusions, not findings solely because unsupported. This report does not certify native browser operation, playable generated media or packaged platform behavior.

## Follow-up review: setup, media, main/preload/UI

The durable pending intent is now fsynced before registration mutation. Serialized info/connect/disconnect recover ownership metadata only when the actual registration exactly matches the recorded before/after snapshot; unrelated external registration is refused. This addresses the original process-death/mutate-then-reject ownership window. The primary reports six focused setup tests passing; this reviewer inspected the implementation and did not rerun that suite.

The HLS parser now uses a single indexed traversal and a 1,000-variant cap. Repeating the original 787,791-byte master reproduction rejects it with `HLS variant limit exceeded` in 16 ms instead of blocking for 3,541 ms. New bounded streaming TS/BMFF framing checks are wired into each HLS resource before publication. Focused calls independently confirmed HTML rejection for TS, MP4 initialization and MP4 fragments. These framing checks make no codec/decoding guarantee; actual generated-media playback remains an E2E requirement.

Main/preload sender-main-frame checks, browser setup IPC and browser UI were inspected. UI uses textContent for returned data and errors, with no new HTML injection path established. No additional concrete P1/P2 blocker found in this delta. Extension epoch/sender fixes and real browser/desktop E2E remained pending at this follow-up point.

## Final scoped delta verdict

The extension now versions origin consent and global permission changes. Permission removal invalidates pending work synchronously before waiting for initialization; send rechecks the stamp and current permission before dispatch, and automatic capture resumes the browser when consent changes. Independent controlled-promise reproductions for origin revoke/regrant and global permission removal/regrant both returned accepted=false with zero native messages after the old cookie promise resolved. The stale-cookie P1 is resolved by this evidence.

Own-extension sender ID and URL checks now allow popup.html opened as a browser tab without granting settings access to a content-script sender. A focused background fixture confirmed own-extension popup state succeeds and an HTTPS page URL with the same extension ID is denied.

All four confirmed findings above have source/focused verification of their repairs. No remaining concrete P1/P2 blocker was established in the reviewed delta. This verdict is limited to static review and focused reproductions: broad suites were not rerun, and native Chromium/Desktop flow, real media decoding, packaged runtime and platform operation require the primary runtime evidence.

## Final admission/referrer delta review

The primary subsequently reported real Chromium E2E success, including authenticated capture and no-consent fallback. The browser admission layer restricts concurrent preflights, times out network work, validates response/range/encoding/size, rejects HTML/login responses, and queues only after that check. Main wires this gate only into browser bridge admission. No new concrete blocker was established in that admission code itself. The CDN consent selector displays exact origins and destination consent still gates cookies, Referer and User-Agent.

Two additional P2 findings were reproduced during the requested final delta review:

1. **Failed durable add remains runnable.** DownloadManager.add inserts the queued task and secret headers before awaiting initial persistence. An injected ENOSPC makes add reject (bridge responds ADD_FAILED and browser resumes) but leaves the task queued. A focused manager harness observed one retained queued task and one subsequent pump start after the rejected add. The normal 250 ms pump can also start that staged task while persistence is still pending. Keep uncommitted additions ineligible for the pump until persistence succeeds and remove task/secrets on failure. This deterministic failed-admission duplicate differs from the explicitly disclosed indeterminate timeout case.

2. **Guessed full Referer leaks cross-origin page query data.** With no captured Referer, capture.payload copies input.referrer in full after destination-origin consent. A focused call granting only https://cdn.test and supplying page https://private.test/watch?access_token=private-token emitted that entire page URL as Referer to the CDN. A browser's default cross-origin policy would send only the source origin, and no-referrer would send nothing. Preserve actual observed headers; avoid inventing full page Referer. A conservative fallback must at least strip cross-origin path/query and refuse HTTPS-to-HTTP referrer leakage, or omit unobserved Referer entirely.

User-Agent fallback itself introduced no concrete P1/P2 issue. These two findings were sent to the primary before release; source repairs and focused delta verification remain pending at this report point.

### Durable admission follow-up

The manager now marks additions pending before exposing them to the pump, excludes pending IDs from scheduling, removes the task and session-only headers on initial persistence failure, and queues a clean snapshot after snapshots from already running tasks. Independent controlled initial-persist/ENOSPC reproduction after this repair observed zero starts before durability, zero starts after rejection, zero retained tasks, zero secrets and zero pending IDs. The failed durable admission P2 is resolved. The primary also reports its focused RED/GREEN regression passing; this reviewer did not rerun the suite.

### Final referrer verification and release review verdict

Guessed Referer construction and its background/context-menu plumbing have been removed. Repeating the private-token page to CDN reproduction now emits no unobserved Referer and no private token anywhere in the payload. A second focused call with a real observed, consented Referer preserves the exact observed source-origin header. The Referer privacy P2 is resolved; User-Agent fallback remains separately consent gated.

All six confirmed review findings are now resolved with inspected source and independent focused reproduction evidence. No remaining concrete P1/P2 blocker was identified in the final scoped delta. The primary reports source Chromium E2E passing, including popup media controls and consent/fallback. Final aggregate checks and packaged-binary browser/playback verification remain the primary's release gates, not claims made by this read-only review.
