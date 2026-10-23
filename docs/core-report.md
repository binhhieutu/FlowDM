# FlowDM core implementation evidence

Verified on Windows with Node v23.6.0, 2026-10-23.

## Contract

`require('./src/core/download-manager.cjs').DownloadManager` extends EventEmitter.
Constructor: `{ dataDir, downloadDir, maxConcurrent=3, maxPerHost=3, maxBytes=107374182400 }`.
Methods: async `init()`, `add({url, filename?, directory?, connections=4, headers?, startAt?, speedLimit=0})`, `pause(id)`, `resume(id)`, `cancel(id)`, `remove(id)`, `close()`; synchronous `list()` returns detached snapshots. `change` emits the full detached list.

`directory` must be absolute and permits a main-process directory chooser to choose each job's destination. Destination filename collisions receive a numeric suffix. Existing output files are retained by remove/cancel; cancellation removes the internal partial file. Canceled items require a new add; failed/paused items support resume. `speedLimit` means bytes per second for the complete job, across its segments. `startAt` is an epoch millisecond instant or ISO timestamp; display timezone belongs to the UI.

Task fields: `id,url,filename,path,status,totalBytes,downloadedBytes,speed,error,connections,segments,createdAt,startAt,speedLimit,finalUrl,sha256,validator,ranges,requiresHeaders`. Segment fields: `index,start,end,received`. Statuses: `queued,downloading,paused,completed,failed,canceled`.

## Behavior and safety

- HTTP/HTTPS user-mode GET engine; 5 redirects; no credential URLs or HTTPS downgrade. Network read/connect inactivity timeout is 15 seconds. 429/500/502/503/504 and network request errors have bounded exponential retry with jitter.
- Global and per-origin-host download concurrency bounds; 1–16 requested connections. Only a strong ETag enables multiple ranges or byte-offset resume. Last-Modified and absent validators use one fresh stream and restart after pause/restart, preventing same-second, same-length representation changes from combining versions.
- Known and unknown-length bodies, empty responses, byte-size ceiling, strict Content-Range/Content-Length checks, SHA-256 of completed content. A server abandoning Range after its probe triggers an aborted-and-drained set of segments followed by a truncated, fresh single stream.
- Resume validates a strong ETag and total size before appending. Changed remote representations fail visibly; cancel and add again restarts. Missing/shortened partial files and missing strong validators trigger a fresh download. Interrupted validated segment streams retry at their committed offsets; malformed protocol responses fail visibly.
- File bytes are fsynced before advancing journal offsets. Queue checkpoints use a flushed, versioned JSON file and atomic rename. Downloading jobs restore as paused. Destination publication copies to a random staging file in the chosen filesystem, fsyncs it, then creates an exclusive hard link to the final filename. Publication never overwrites an existing destination, including a symlink; failed staging is cleaned up and the source partial is retained.
- A tiny exclusive hard-link capability check runs before network probing/body transfer. Unsupported destinations, including FAT/exFAT, fail immediately with `UNSUPPORTED_DESTINATION_FILESYSTEM`; both probe entries are cleaned up. Use a filesystem supporting hard links, such as NTFS on Windows.
- A crash after final publication but before the completed journal is recovered offline on init/resume: the persisted SHA-256 must contain exactly 64 hexadecimal digits, final size must equal committed downloaded bytes, known total must be complete, and the full final file digest must match. Unrelated files, wrong sizes, malformed hashes and non-files never become completed through this recovery.
- Header names/values and file paths are validated. Request headers stay only in memory, are never journaled, and sensitive headers are stripped on cross-origin redirects. Header-dependent restored jobs pause and require a new add with the needed context. Diagnostics omit response bodies and redact URLs.
- Controls serialize state changes. Pause/cancel/close abort HTTP and limiter waits and wait for file work before checkpointing. Completed output is retained when removing history.

## Test evidence

TDD RED: `node --test tests/core/download-manager.test.cjs` initially failed with MODULE_NOT_FOUND before implementation.

Final core validation command:

```powershell
.\node_modules\.bin\c8.cmd --include="src/core/**" --reporter=text --reporter=json-summary --check-coverage --lines=80 --statements=80 --functions=80 --branches=80 node --test tests/core/download-manager.test.cjs
```

Result after release review fixes: **29 tests passed**, 0 failed, approximately 8.66 seconds. c8: **99.36% lines/statements, 90.00% branches, 100% functions**. Every core module exceeds 80% branches.

Fixtures cover exact parallel output/hash; Range-ignored and chunked fallback; unsafe input and filename collisions; invalid ranges and cap; secret-free journal and scheduled restoration; pause/restart; changed validators; no-validator restart; actual limiter timing; global/per-host queue bounds; cancel/shutdown; 503 retry/404 failure; redirect credential stripping and loops; truncated/oversized/encoded/changed responses; missing credentials; empty and missing/short checkpoint files; unsafe partial types; exclusive staging; injected disk-full and failed journal rename; and interrupted stream resume offsets.

Release review regression RED reproduced three findings before fixes: Last-Modified same-timestamp replacement produced mixed output; a fully published offline crash checkpoint remained paused; unsupported hard-link destinations failed only after transfer. GREEN fixtures now prove full fresh Last-Modified restart, digest-checked offline init/resume recovery, unrelated final preservation, size/type/hash rejection, and injected EOPNOTSUPP rejection with zero HTTP requests and no leftover filesystem probe entries.

## Explicit limits

This core does not implement proxy profiles, encrypted credential persistence, browser interception, HLS/DASH reconstruction, checksums supplied by servers, or kernel integration. Header-dependent downloads need their context supplied again after restart. Concurrency caps count jobs, with each job's connection setting governing its ranges. FAT/exFAT and other filesystems lacking hard-link support are unsupported; the capability preflight rejects them before network transfer. Real power-loss and OS/filesystem hardware failure recovery have not been exercised; controlled restart, final-publication crash checkpoints, missing/short checkpoints, injected disk-full and atomic rename failures are tested. Cross-platform source paths are implemented; this report's runtime evidence is Windows only.
