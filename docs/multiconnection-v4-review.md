# FlowDM 0.4 focused review

Status: closed with no remaining P1/P2 finding in the reviewed delta. Scope is limited to the 0.4 multi-connection implementation and the targeted fixes below. Runtime sources and tests are owned by the implementation lanes; this document records review evidence only.

## Resolved findings

### Resolved P1 — DASH relay accounts bytes per request instead of per task

`createDashRelay` creates `bytes = 0` inside each request handler. With `N` native fragment requests, every request can independently relay up to `maxBytes`. The later scratch poll limits stored files, but it does not enforce the required task-global network budget and runs only every 100 ms. A hostile or oversized static MPD can therefore make FlowDM relay substantially more than the configured task limit before the external job is killed.

Resolution: the relay now owns one shared received-byte counter, tracks every upstream and downstream response, and destroys the concurrent set before an overflowing chunk can be delivered. The concurrent two-response regression proves their combined delivered bytes do not exceed the task limit.

### Resolved P1 — aria2 may discover implicit netrc credentials

The fixed aria2 option string disables its config file and RPC, but does not pass `--no-netrc=true`. aria2 enables netrc processing by default, so a same-user netrc entry can silently add credentials to the extracted CDN request. This breaks FlowDM's explicit no-credential boundary for YouTube.

Resolution: the fixed and argv-tested policy now includes `--no-netrc=true`, `--max-concurrent-downloads=1`, `--follow-torrent=false`, and `--follow-metalink=false`.

### Resolved P2 — HLS scheduling is not bounded by the ordered commit cursor

When a later resource finishes before resource zero, its worker places a file in `ready`, finds that the next ordered index is absent, and immediately takes another index. A local reproduction with 20 resources, `N=4`, and index zero held behind a gate observed all 20 requests start before index zero was released:

```text
WINDOW_STARTED_BEFORE_INDEX0=20
```

Active requests remain bounded by `N`, but an early stall can stage the full playlist, up to the 10,000-resource parser limit. This violates the bounded sliding-window contract and creates avoidable file-count and scratch pressure.

Resolution: assignment now waits while `next >= nextCommit + N`, ordered commit wakes the blocked workers, and error/abort paths also wake them before joining. Re-running the original 20-resource reproduction observed exactly four starts while index zero was held:

```text
WINDOW_STARTED_BEFORE_INDEX0=4
```

### Resolved P2 — peer abort can hide the original HLS failure

After a worker fails, the shared controller aborts its peers. `Promise.allSettled` then selects the first rejected result by worker-array order, which may be a peer's synthetic `AbortError` rather than the validation or I/O failure that caused cancellation. A reproduction with worker/index two throwing while lower-index workers were delayed reported:

```text
REPORTED_ERROR=AbortError:Aborted
```

Resolution: workers retain the first non-abort root failure and settlement prefers a substantive rejection before an abort. The combined stall regression fails worker/index two and asserts the original `worker-two-validation` error.

### Resolved P2 — the YouTube argv lacks the explicit native manifest override

The YouTube branch scopes aria2 to `http:`, but does not also pass `--downloader dash,m3u8:native`. The pinned yt-dlp version currently blocks aria2 for fragmented manifests, so this is a defense and upgrade-regression gap rather than a current exploit. The explicit override is part of the v0.4 advisory acceptance gate.

Resolution: the YouTube branch now passes both the HTTP-only aria2 mapping and `dash,m3u8:native`, with exact argv coverage. Its preferred format selects native HLS video when available and retains aria2 only for ordinary HTTP fallback/audio transfers.

## Evidence already green before review

- Focused HLS tests covered TS/fMP4 ordering, N=1 and N=4 output, basic failure cleanup, aggregate rate timing, and abort waiting.
- Focused external tests covered connection validation, actual yt-dlp native DASH overlap, and an actual aria2 32 MiB ranged transfer with N=1 and N=4.
- Bridge, popup, protocol, tool-resolution, and connection preference suites were reported green by their owning lanes.

Targeted reviewer verification after the fixes:

```text
node --test tests/core/hls-parallel.test.cjs tests/media/external.test.cjs
tests 23, pass 23, fail 0
```

The actual deterministic benchmarks reported by the owning lane produced byte-exact, fully decoded outputs. With 400 ms fixture latency per resource, HLS completed in 1,317 ms at N=1 and 457 ms at N=4, with observed peaks 1 and 3; DASH completed in 5,132 ms at N=1 and 2,862 ms at N=4, with observed peaks 1 and 4. The public YouTube native-HLS CLI download and merge took 18.65 seconds, followed by a separate successful full-file decode. The aria2 HTTP comparison download completed in 97 seconds, established four TCP connections, and also passed a separate full-file decode, so native HLS remains the preferred video transport while aria2 handles ordinary HTTP(S) audio and full-file fallback. The authoritative current-app N=4 run downloaded in 21.258 seconds; the full E2E including verification took 49.787 seconds.

Rate interaction was rechecked in the final argv policy. Native fragment concurrency is reduced to at most the positive byte-per-second limit, then the native per-fragment rate is the floor of the task rate divided by that effective concurrency. aria2 receives both per-download and overall limits equal to the task rate. This prevents a tiny limit from producing a zero rate and avoids multiplying the task limit across native fragment workers. The transport mappings remain mutually exclusive for one resource, so no reviewed path creates N-squared work.

## Review boundary

This pass intentionally omits readability and low-impact cleanup. The signed Google Video URL remains a documented narrow child-argv exposure: it may be visible to same-user or privileged process inspection while aria2 runs, but must not be copied into the journal, UI, errors, logs, screenshots, or test evidence.
