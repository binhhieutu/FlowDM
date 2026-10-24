# Persistent media resume implementation plan

> Implementation uses disjoint subagent lanes with TDD; root integrates manager/UI, release evidence and real desktop tests.

**Goal:** Pause HLS/DASH/public YouTube, close/relaunch the app, continue using durable downloaded media rather than restarting the full job, and decode the finished video.

**Architecture:** Stable per-task private checkpoint directories under the app state directory, never user-provided paths. HLS checkpoints atomically validated complete resources and reconstructs the output in order. External media retains native yt-dlp/aria2 continuation state with explicit source/format identity checks and local file integrity validation; stable filenames survive changing loopback relay ports. Only complete validated outputs publish. Journal v4 reads v1-v3, preserves older tasks without claiming their missing media checkpoint exists.

**Tech stack:** Existing Electron/Node CommonJS, HTTP, pinned yt-dlp/FFmpeg/aria2; no new dependency or remote publication.

## Constraints and choices

- User explicitly authorizes autonomous implementation and actual download/pause/relaunch tests; use existing UX defaults without additional approval gates.
- A completed fragment must not be fetched again on ordinary continuation. An incomplete fragment may restart. HTTP audio partials may resume only with safe upstream identity support.
- Refuse changed manifest/format or tampered cache; do not silently discard checkpoints and restart a whole media job.
- Pause/close must wait for workers/child exit and durable checkpoint persistence; cancel/remove deletes the owned checkpoint only. Success cleans temporary cache after atomic publication/recovery.
- Do not persist browser credentials or signed extracted CDN URLs in new app metadata. Keep child environment, DRM/live exclusions, no remote components/plugins/config, and per-job byte/concurrency/rate limits.
- Sources without a verifiable continuation path must report the limitation while retaining bytes; no false promise of universal site support.
- Keep original download files, IDM, native browser registrations and daily profile untouched.

## Tasks and ownership

- [x] HLS lane: `src/media/hls-parallel.cjs`, new checkpoint helper if required, `tests/core/hls-parallel.test.cjs` and new focused tests. Optional `checkpointDir` and returned/onProgress cumulative bytes/completedResources/reusedResources; `checkpointDir` absent preserves legacy ephemeral behavior. Saved resources hash/size/container verified, playlist identity pinned, no credentials in JSON. RED/GREEN pause/reopen/reuse, tamper/change, missing/damaged/partial file, ordering, abort, size/rate/concurrency.
- [x] External lane: `src/media/external.cjs`, new external checkpoint helper, `tests/media/external*.test.cjs`. Optional `checkpointDir`, stable `.part/.ytdl/.aria2` state, source/format validation and safe abort snapshots. No global manager edits. RED/GREEN actual pinned yt-dlp DASH pause/reopen without repeat fragment fetch; HTTP controls, change/corrupt cache, kill/size/timeout safety. Expose cumulative resumable progress without URLs.
- [x] Root: manager stable checkpoint mapping, v4 journal/storage migration and validation, lifecycle cleanup and preserved UI progress; focused manager integration tests before implementation. UI copy and version 0.5.0 after integration.
- [x] Scoped independent security/correctness review once focused lanes green; resolve real blockers with regressions and delta check.
- [x] E2E: controlled real Electron HLS/DASH servers record requests before/after pause, close/reopen, continue and decode byte-exact result. Actual public YouTube GUI pause/close/relaunch/resume with checkpoint reuse evidence and full final A/V decode. Repeat on packaged Windows and portable where supported. Use unique per-run output names.
- [x] Release freeze: aggregate coverage >=80%, audit, Windows portable and Linux archive build/integrity; no native Linux/macOS claim. Package verified source/extension/checksums, commit local, final report in existing docs.

## Review focus

Checkpoint paths/symlinks and bounded parsing; write/checkpoint ordering under abort/crash; yt-dlp native index/fileoffset reconciliation and incomplete fragments; signed URL or selected format drift; cache total + workspace quota, cancellation cleanup, no publication of mixed or incomplete output.
