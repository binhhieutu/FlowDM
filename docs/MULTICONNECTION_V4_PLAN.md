# FlowDM 0.4 multi-connection execution packet

Status: implementation and release gate. Prepared on 2026-10-24 against aria2 1.37.0, yt-dlp 2026.10.21, the yt-dlp fragmented-manifest/aria2 advisory, and FlowDM's existing direct, HLS, DASH, and public-YouTube boundaries.

## Outcome and bounded scope

FlowDM 0.4 makes the existing `connections` value effective for every supported download class while retaining the existing validated range of 1 through 16. The UI offers 1, 2, 4, 8, and 16; IPC and journal validation continue to accept every integer in the full range. Requested connections are an upper bound. A small file, a short playlist, a server without byte ranges, or a representation with too few fragments may use fewer connections and must report that honestly.

This work does not add live media, playlists/channels, DRM, encrypted HLS, browser-account cookies for YouTube, proxy rotation, BitTorrent, Metalink, FTP/SFTP, RPC, user-supplied downloader arguments, or automatic capture of playback segments. The 0.3 public-video, credential, canonical-URL, tool-integrity, output-validation, and atomic-publication boundaries remain in force.

## One connection model per protocol

| Task | Parallelism owner | Contract for requested `N` |
|---|---|---|
| Direct HTTP(S) file | Existing FlowDM byte-range engine | At most `N` disjoint validated ranges; fall back to one connection when the server does not safely support ranges. |
| HLS VOD | New in-process bounded worker pool | At most `min(N, remaining resources)` HTTP requests, with one ordered disk commit stream. |
| DASH handled by yt-dlp | yt-dlp native fragment downloader | `--concurrent-fragments N` and explicit `--downloader dash,m3u8:native`. |
| YouTube progressive/separate HTTP(S) formats | aria2c invoked by yt-dlp | Fixed aria2 arguments set split and per-server connection ceilings to `N`; fragmented DASH/HLS still use yt-dlp native workers. |

Never multiply parallelism layers for the same resource. In particular, do not give a DASH fragment list to aria2 while also setting yt-dlp `-N`, and do not wrap each HLS segment in an `N`-way range download. For a task requesting `N`, the same media resource has a peak of at most `N`, not `N*N`. Existing queue limits still apply across tasks: with two tasks admitted for one host, the possible host socket count is the sum of their effective connection ceilings, not merely the number of tasks.

Persist requested `connections` as before. `media.effectiveConnections` and `media.peakWorkers` are observational values, derived from the current run and never trusted as restart authority. The UI must distinguish requested and observed counts; an argument containing `16` is not evidence that 16 requests overlapped.

## HLS worker and ordered-commit contract

The HLS path remains FlowDM-native and supports only the existing finite, unencrypted VOD subset. It must not hand manifests or fragment lists to aria2.

Use one task-local `AbortController` linked to the manager signal and exactly one bounded worker pool. Assign monotonically increasing resource indexes, including an fMP4 initialization map at index 0. A worker downloads one resource into a private regular temp file, validates HTTP status/encoding/length and TS or BMFF framing while streaming, fsyncs and closes it, then marks that index ready. A single committer streams ready files into the manager partial strictly by index and deletes each temp after a successful append. Never concatenate buffers for a whole segment, playlist, or output in RAM.

Keep a sliding scheduling window tied to the next index to commit. A stalled early segment must not allow workers to stage the rest of a 10,000-segment playlist. At most `N` resources are active or ready ahead of the commit cursor. Temp names are generated from task/run IDs and numeric indexes, not manifest text. Open exclusive files, reject links/reparse points and unexpected entries, and keep the staging directory under FlowDM's private data directory.

Count every received body byte in one task-global `networkBytes` counter before accepting it. Abort all workers when the counter would exceed `maxBytes`; do not let each worker independently consume `maxBytes`. `committedBytes` is checked independently against the same output cap but is not added to `networkBytes` as if it were a second download. The maximum staged-disk budget covers the partial output plus the bounded window and must include a small fixed allowance for filesystem/control metadata.

Apply `speedLimit` through one serialized task-global limiter. Per-worker limiters would permit up to `N * speedLimit`. Tests should measure aggregate server bytes over elapsed time with tolerance for one bounded chunk of burst, not assert sleeps or internal timestamps.

On the first resource, validation, write, limit, or cancellation failure: abort the shared controller, destroy every response, wait for all worker promises and open file handles, close the partial handle through the manager, and remove the task staging directory. Pause and shutdown leave the durable task paused with no workers; Cancel also removes partial/staging data. Resume starts a fresh HLS generation from resource 0. No late worker or persistence callback may update a newer generation.

## yt-dlp and aria2 invocation

FlowDM keeps the fixed yt-dlp policy from 0.3 and adds validated decimal `N` only through fixed arguments:

```text
--concurrent-fragments N
--downloader <absolute verified aria2c path>
--downloader dash,m3u8:native
--downloader-args aria2c:<FlowDM-owned fixed option string containing N>
```

The ordering must be covered by an argv regression. Both the global aria2 choice and the explicit `dash,m3u8:native` override are required. yt-dlp 2026.10.21 supports aria2 only for ordinary HTTP(S)/FTP protocols; its current native downloader is the supported path for fragmented DASH/HLS.

The FlowDM-owned aria2 option string should enforce the semantic equivalent of:

```text
--no-conf=true
--no-netrc=true
--enable-rpc=false
--follow-torrent=false
--follow-metalink=false
--check-certificate=true
--file-allocation=none
--auto-file-renaming=false
--summary-interval=0
--console-log-level=warn
--max-concurrent-downloads=1
--split=N
--max-connection-per-server=N
--min-split-size=1M
```

When `speedLimit > 0`, pass a decimal-byte `--max-overall-download-limit` for the one aria2 job. Retain yt-dlp's own task rate limit for native fragments. Do not enable aria2 input files, RPC, session save/load, hooks, seed/upload functions, DHT, peer discovery, torrent/Metalink following, proxy discovery, config/netrc discovery, remote timestamps, or arbitrary headers. FlowDM never accepts raw aria2 arguments from IPC, UI, extension, media metadata, or environment.

yt-dlp itself appends absolute `--dir`, controlled `--out`, and the extracted HTTP URL after an option terminator. The workspace is random and private; any existing output/control file is removed with the whole workspace before a fresh run. aria2 `.aria2` control/cookie files are scratch data and must be included in the workspace monitor and removed only after the entire child tree exits.

### Mandatory fragmented-manifest boundary

GHSA-vx4q-3cr2-7cg2 / CVE-2026-50574 describes arbitrary file write and possible code execution when older yt-dlp versions passed attacker-controlled HLS/DASH fragment lists to aria2 input files. yt-dlp fixed this in 2026.06.09 by removing aria2 support for fragmented manifests and recommends the native downloader for those protocols. FlowDM pins a newer release, but must still pass `--downloader dash,m3u8:native` explicitly and test it. A future tool update that routes `dash`, `m3u8`, `m3u8_native`, or `http_dash_segments` through aria2 fails the release gate.

### Child-command privacy exception

yt-dlp's current `Aria2cFD` passes the extracted HTTP(S) media URL as an aria2 command-line argument after `--`. For YouTube, that URL is normally a transient signed Google Video URL. Therefore 0.4 cannot retain a blanket claim that no signed media URL ever appears in any child process command line. It must instead state the narrow local exposure: the URL is visible to same-user/privileged process inspection for the aria2 child lifetime, but is not copied to FlowDM logs, journal, UI, screenshots, evidence, or errors. Browser Cookie/Authorization headers remain forbidden.

If command-line invisibility is a hard requirement, do not ship the yt-dlp-to-aria2 HTTP path; use yt-dlp native HTTP instead or design and separately review a single-URL stdin wrapper that rejects CR/LF and option lines. Do not work around the advisory by reintroducing an aria2 fragment input file.

## Process, output, and workspace invariants

The external job still has one yt-dlp process tree. aria2 children must inherit the minimal allowlisted environment and verified executable directory. Pause, Cancel, timeout, overflow, and shutdown terminate and await the entire yt-dlp/aria2/FFmpeg tree before workspace deletion or task transition. A zero yt-dlp exit is not completion until the existing scratch enumeration, regular-file/size checks, FFmpeg video+audio decode gate, copy/fsync, SHA-256, journal commit, and atomic publication finish.

Workspace monitoring must tolerate the legitimate video track, audio track, aria2 control/cookie files, merge output, and final copy while retaining a finite hard cap. Monitor during aria2 downloads and FFmpeg merging; `--max-filesize` and aria2's declared lengths are defense in depth. Bound stdout/stderr and progress rates. Redact HTTP(S) URLs and query strings from any tool diagnostic shown or persisted.

Do not claim `N` connections from yt-dlp/aria2 flags. For deterministic HTTP tests, the server records active requests and distinct valid Range intervals. For DASH native fragments and HLS, it records simultaneous fragment requests. The observed peak must be greater than 1 for a fixture sized to permit splitting, no greater than requested `N`, and exactly 1 for `N=1`. All response bytes and the final hash must match the single-connection reference.

## Direct-download regression boundary

Direct downloads already split validated byte ranges. Keep their ETag/length/range invariants and range-ignored fallback. Test `N` across 1 through 16, including files too small to split, connection drop/retry, changed validator, encoded response, and a server that returns 200 after initially advertising ranges. Parallel retries must never overlap committed ranges or exceed the task byte budget. Speed limiting remains aggregate for the task.

## Tool provenance and license gate

The Windows private artifact uses the official aria2 1.37.0 x64 release asset `aria2-1.37.0-win-64bit-build1.zip` from the aria2 GitHub release. The release tag is GitHub-verified with maintainer key ID `7E8403D5D673C366`, but the release page does not publish a checksum/signature for the individual Windows ZIP. Do not describe a locally computed hash as a publisher-signed checksum.

The provisioned `aria2c.exe` observed during planning is 5,649,408 bytes, SHA-256 `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`, reports version 1.37.0, and is not Authenticode-signed. The final manifest must also record the downloaded ZIP byte length/hash and verify both archive and extracted executable on every preparation. Packaged Windows must resolve only the resource copy, reject PATH/environment overrides, and verify exact size/hash before yt-dlp can launch it.

aria2 is GPL version 2 or later. Include the release `COPYING`, exact release/source URL, archive and executable hashes, and the private-artifact provenance record alongside the existing yt-dlp and FFmpeg notices. No external publish is authorized. Before public redistribution, review and satisfy the corresponding-source obligations for the exact aria2 and FFmpeg builds; a link and license text alone are not a completed public-release compliance claim. Linux/macOS continue to require native tool provisioning and native runtime proof.

## TDD and verification matrix

### Unit and integration gates

1. Validate every integer `N=1..16`; reject zero, fractions, strings, values above 16, unknown IPC fields, and corrupted journal values. UI options round-trip 1/2/4/8/16.
2. Direct fixture: for N=1/2/4/8/16, prove exact bytes/hash, disjoint requested ranges, real observed peak bounded by N, safe one-connection fallback, aggregate speed limit, and cancel/retry behavior.
3. HLS TS and fMP4 fixtures: delay indexes out of order; prove request peak `min(N, resources)`, byte-exact ordered output, init map first, per-resource framing validation, sliding-window bound, no whole-resource buffering, and no `N*N` fan-out.
4. HLS failures: missing/truncated/oversized/encoded/malformed segment, cross-origin credential stripping, early-index stall, later-worker failure, byte-cap race, disk failure, Pause/Cancel/close. All workers settle and temp/control files disappear before return.
5. External argv: exact absolute aria2 path; decimal N; native DASH/m3u8 override; no user config, plugins, remote components, fragment input file, RPC, netrc, proxy, torrent/Metalink, or secrets. N=1 and N=16 get separate assertions.
6. Fake process tree: yt-dlp spawns fake aria2 and FFmpeg grandchildren. Pause, Cancel, timeout, scratch overflow, validator failure, and close kill and await all descendants with no late output or publication.
7. Tool resolver: missing/tampered aria2 fails browser admission and desktop add clearly; packaged mode refuses override/PATH; source mode requires an absolute explicit override or a deliberately supported PATH binary. Manifest size/hash/version/license files are verified.
8. Journal restart: direct range state remains valid; HLS/DASH/YouTube become paused restart-only; stale worker generations and `.aria2` files cannot publish or update progress.

### Actual connection evidence

Use a local server that logs request start/end, Range, URL class, and active count without secrets. Make the direct object large enough for aria2's 1 MiB minimum split and make HLS/DASH contain at least `N+1` delayed resources. Report requested N, observed peak, request count, total served bytes, output bytes/hash, elapsed time, and aggregate rate. A faster wall-clock time alone is not proof of multi-connection behavior.

For public YouTube, repeat the exact popup-to-native-to-packaged path using the same public sample and isolated profile. Record yt-dlp/aria2/FFmpeg versions and hashes, requested N, sanitized evidence that aria2 launched, completion size/hash, two-stream ffprobe result, and full decode. Do not record the transient signed media URL. Because a remote CDN may restrict ranges or change formats, a lower observed public peak is reported honestly and does not replace the deterministic peak test.

### Release acceptance

- Direct, HLS, native DASH, and YouTube HTTP paths produce identical valid outputs at N=1 and multi-connection settings.
- Deterministic instrumentation proves real overlap greater than 1 and never above N; no path creates N squared workers.
- Global output/workspace byte caps and task-wide speed limits hold under concurrency.
- Pause/Cancel/timeout/shutdown await every worker/child and clean staging without final publication.
- The manifest advisory boundary is explicit and regression-tested: aria2 never receives HLS/DASH fragment lists.
- aria2 provenance, exact hashes, GPL text, source information, and private-build limitation are present.
- Existing 0.3 browser, media, packaged Windows, coverage, audit, and full-decode regressions remain green.
- Linux/macOS remain unverified until the same native tests run there; archive creation alone is insufficient.

## Primary upstream evidence

- aria2 1.37.0 release and verified tag: <https://github.com/aria2/aria2/releases/tag/release-1.37.0>
- aria2 1.37.0 manual: <https://aria2.github.io/manual/en/html/aria2c.html>
- aria2 GPLv2-or-later license: <https://github.com/aria2/aria2/blob/release-1.37.0/COPYING>
- yt-dlp 2026.10.21 aria2 implementation (HTTP(S)/FTP only): <https://github.com/yt-dlp/yt-dlp/blob/2026.10.21/yt_dlp/downloader/external.py>
- yt-dlp downloader and concurrent-fragment options: <https://github.com/yt-dlp/yt-dlp/blob/2026.10.21/README.md>
- GHSA-vx4q-3cr2-7cg2 / CVE-2026-50574: <https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-vx4q-3cr2-7cg2>
