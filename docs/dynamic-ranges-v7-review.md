# Dynamic HTTP ranges review, 2026-10-25

Scope: Task 3 changes in `src/core/range-scheduler.cjs`, `src/core/http-range-pool.cjs`, the download manager's worker signals and connection-change method, schema v5 storage/backup, desktop IPC/preload, and the live connection controls. This was a finite code/security review of the implementation and a final UI/IPC delta review. It was not a new broad audit or a certification of other media adapters or platforms.

Verdict: no unresolved P1/P2 findings identified in this bounded review.

## Ownership and persistence

Redistribution settles the current range workers before replacing segment objects or boundaries. Worker-local cancellation is separate from task cancellation, and deliberately interrupted network streams do not enter ordinary retry handling. Pending ranges are divided only after their latest writes, fsync, and journal operations finish. The new sorted ownership plan is persisted before replacement workers start; failed ownership persistence restores the previous segment plan and connection setting. Pause/close cancellation is checked after asynchronous reconfiguration, and final cleanup waits for workers before closing the shared file handle.

The same runtime byte counter and start clock survive reconfiguration, retaining the aggregate rate limit. Configured connections remain bounded to 1–16; a server without the validated range contract uses one actual connection even when the configured maximum is higher. Adjacent completed ranges may be coalesced. Each new pending half must contain at least 256 KiB, and plans are capped at 1,024 segments. The minimum split size can leave a short tail with fewer active workers than the configured maximum.

Schema v5 accepts the larger bounded segment plan; older schemas retain their 16-segment validation bound. Upgrade first writes and flushes an original-byte journal backup, and a backup failure blocks migration. The v5 journal retains byte counts and range boundaries; restoring finite direct-file plans checks contiguous coverage through the recorded total. Existing unknown-length single-stream behavior remains supported. Older binaries must not open a v5 state directory.

## Desktop boundary

The new IPC method uses the existing trusted main-frame sender checks and permits only `id` and `connections`. The manager validates integer bounds, task state, and direct HTTP applicability. The preload exposes a fixed method rather than a generic channel invocation. Errors use the existing sanitized download error path, and UI values are assigned through text content or fixed select options.

The connection selector preserves an unsubmitted draft over progress updates and disables repeat submission while a change is pending. Its controls are hidden for HLS/DASH/YouTube and completed/canceled tasks. Detail text distinguishes active/configured connections from persisted ranges, so a range is not represented as an active socket. The existing `[hidden]` CSS rule takes precedence over the control layout.

`HttpRangePool.resize()` assumes serialized callers; the manager's mutation queue supplies that guarantee. Segment indexes are not separately validated on journal restoration, but transfer offsets and coverage use explicit start/end/received fields rather than indexes. Neither observation is a P1/P2 blocker for the current reachable interface.

## Evidence and limits

The reviewer inspected `test-results/dynamic-v7-source.json`: actual source Electron GUI changes 1 → 4 → 1, then pause → close/relaunch → resume, retained 253,952 committed bytes without replaying committed ranges. The 4,194,304-byte real MP4 fixture with ISO-BMFF padding matched SHA-256 `d6081daf4fa5aba1f01aa25d510439301b6ef798eb05b21875e50602a53dff0f` and passed whole-file FFmpeg decode. Under the controlled slow-first-range fixture, fixed four-range baseline took 5,985 ms and dynamic scheduling took 3,304 ms, with peak server connections of four. This is a controlled comparison, not a general internet speed claim.

The integrating agent reported 205 unit/integration tests plus the actual desktop test passing in the first full coverage run; the subsequent focused eight-test run also passed after adding configured-16/actual-1 non-range coverage. The next fresh full run and final packaged execution were still pending when this review was written. Their authoritative outcomes belong in the release verification report. This reviewer did not rerun tests.

Live connection changes apply to direct HTTP(S) tasks. They do not change yt-dlp/aria2 process concurrency or HLS fragment worker counts during an active media task. This work does not add authenticated media downloads, native Linux/macOS execution evidence, arbitrary power-loss guarantees, or Task 4–10 features.
