# FlowDM 0.3 — DASH and public YouTube execution packet

Status: implementation gate. This packet defines the supported slice, trust boundaries, and evidence required before the feature can be described as working. It was prepared against the yt-dlp documentation and release state available on 2026-10-23.

## Outcome and bounded scope

FlowDM 0.3 adds two explicit, user-initiated media jobs:

- `dash`: a finite, unencrypted DASH VOD manifest (`.mpd` or `application/dash+xml`), including separate audio and video representations that must be merged into one playable file.
- `youtube`: a canonical public YouTube video page URL handled by yt-dlp. A watch page, Shorts URL, or `youtu.be` URL is a site job; the extension does not scrape player JSON or submit transient Google Video URLs as the primary task.

The engine delegates site extraction and DASH representation selection to a pinned yt-dlp executable and delegates merging/validation to pinned FFmpeg/ffprobe executables. These jobs reuse FlowDM's durable queue, per-host/global concurrency, scheduling, speed-limit policy where the external tool supports it, SHA-256, collision-free destination allocation, and atomic publication.

The slice excludes playlists, channels, live/premiere streams, DRM/EME/license acquisition, paid/private/member-only/age-gated video, geo or bot-check evasion, proxy rotation, CAPTCHA automation, arbitrary yt-dlp plugins, user-supplied yt-dlp/FFmpeg arguments, and downloading browser cookies wholesale. A failure caused by login, `Sign in to confirm you're not a bot`, PO-token enforcement, DRM, or unavailable formats must be reported as that failure. It must not trigger an automatic workaround.

## Contracts

### IPC and journal

The common add payload becomes:

```text
{ url, filename?, headers?, mediaType?: 'direct' | 'hls' | 'dash' | 'youtube' }
```

Only the main process chooses executable paths, output templates, format selection, plugin policy, runtime, workspace, and process environment. None of those fields are accepted from renderer, extension, native-messaging payload, title, manifest, or downloaded metadata.

`dash` requires an HTTP(S) URL whose path or observed content type identifies an MPD. `youtube` accepts only recognized `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, and `youtube-nocookie.com` video URL shapes. It is canonicalized to a single-video URL and drops fragments, playlist/tracking parameters, credentials, and non-video routes. A bare channel, search, playlist, feed, or arbitrary URL cannot select the YouTube adapter.

Persist a new journal version while continuing to read versions 1 and 2. Persist only the canonical source URL and non-secret task state. External jobs recovered from `downloading` become `paused` and restart from the beginning. Version 0.2 must not be used to reopen a version 0.3 journal.

### External adapter invocation

Spawn absolute, verified executable paths with `shell: false`, a fixed argument array, a private per-task working directory, hidden windows, and piped stdio. Never build a command string. Feed the validated single URL on stdin with `--batch-file -` so signed URLs do not appear in the process command line. Close stdin immediately after one newline-terminated URL.

The fixed yt-dlp policy must include the semantic equivalent of:

```text
--ignore-config
--no-config-locations
--no-plugin-dirs
--no-remote-components
--no-playlist
--max-downloads 1
--abort-on-error
--no-overwrites
--no-continue
--part
--no-write-info-json
--no-write-description
--no-write-thumbnail
--no-write-subs
--no-embed-metadata
--no-exec
--no-cache-dir
--ffmpeg-location <trusted tool directory>
--paths home:<private staging directory>
--paths temp:<private staging directory>
--output <task UUID>.%(ext)s
--progress-template <FlowDM-owned numeric template>
--newline
--batch-file -
```

Use a fixed single-video format policy (`bv*+ba/b`) and a bounded merge-container preference that preserves codecs, such as MP4 with MKV fallback. Do not enable `allow-unplayable-formats`, `allow-unsafe-ext`, extractor impersonation, external downloaders, `--exec`, SponsorBlock, metadata embedding, thumbnails, subtitles, or archive/config discovery. `--max-filesize` is defense in depth, not the size oracle: manifest estimates may be missing or inaccurate.

Do not parse ordinary yt-dlp output as a stable protocol. Parse only FlowDM-prefixed lines produced by `--progress-template`/`--print`, with numeric fields, a per-line byte limit, and a bounded ring buffer for diagnostics. Strip ANSI and control characters before logs/UI. Titles and filenames remain untrusted display data and never become paths.

The environment is allowlisted. Remove `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`, dynamic-loader injection variables, yt-dlp config overrides, and unrelated secrets. Point yt-dlp explicitly to the trusted FFmpeg directory and the single approved JS runtime. Remote EJS downloads remain disabled; the EJS scripts must come from the same verified yt-dlp distribution. The current official executable includes yt-dlp-ejs; full YouTube extraction also needs a supported JavaScript runtime. Node 22+ or Deno 2.3+ are the current documented floors.

### Credential and URL privacy

The 0.3 site adapter supports public videos without account cookies. It must never invoke `--cookies-from-browser`, read a browser cookie database, or export all-site cookies. That upstream option can expose cookies for unrelated sites and does not satisfy FlowDM's per-origin consent model.

Do not put Cookie, Authorization, PO tokens, signed media URLs, or full stderr in argv, telemetry, screenshots, test names, or user-visible logs. A later authenticated-site design needs a separate review and an ephemeral mode-0600 cookie/config file scoped to the required domains, securely removed in every exit path. Until then, credential-required YouTube jobs fail clearly. Direct/HLS credential consent from 0.2 remains independent.

The journal necessarily retains the canonical source URL for resume. YouTube canonicalization must reduce it to the video ID URL. Signed MPD query strings remain sensitive local state: keep the data directory owner-only, redact queries from errors, and never copy them into evidence.

## Workspace, bounds, and atomic publication

Each external job owns exactly one workspace below FlowDM's private data directory, named only by the generated task UUID. Creation rejects symlinks/reparse points and an already-populated unexpected directory. yt-dlp receives no path influenced by remote metadata.

Enforce all of these independently:

- output limit: the manager's existing `maxBytes`;
- workspace limit: enough for separate video, audio, merge temporary, and final output, but finite (recommended hard bound `min(3 * maxBytes, configured hard ceiling)`);
- one input and one final media output;
- bounded stdout/stderr, progress-line size/rate, and child inactivity;
- bounded process shutdown grace period;
- normal queue and per-host concurrency.

Monitor the real workspace size during download and post-processing. If it exceeds the workspace limit, terminate the whole process tree and fail without publication. This covers unknown or dishonest manifest sizes that `--max-filesize` cannot prevent.

After a zero exit code, independently enumerate the workspace without following links. Require exactly one final regular media file; reject links/reparse points, device files, sockets, directories, executable/script extensions, empty files, unexpected sidecars, files outside the workspace, and outputs above `maxBytes`. Never trust a printed filepath without this scan.

Run trusted ffprobe with JSON output, a timeout, bounded stdout, and `shell: false`. A completed video requires at least one decodable video stream; the deterministic DASH fixture and the selected YouTube format also require audio. Allow only a reviewed media-container extension set. Then run a decode validation in release E2E (`ffmpeg -v error -i <file> -f null -`) before claiming compatibility.

Only after validation: sync the final staging file, compute SHA-256, allocate a non-overwriting destination, and publish through the existing atomic storage path. A failed, paused, canceled, timed-out, or killed process never leaves a Completed task or final destination. Cleanup its private workspace after the child tree has exited; verified completed outputs may be recovered using the existing digest rules.

## Pause, cancel, shutdown, and process trees

Pause, app shutdown, crash recovery, and retry use whole-job restart semantics for DASH/YouTube. Partial fragments are not resumed across FlowDM task transitions. The UI states this explicitly.

Track the child PID and exit promise before exposing the task as downloading. On POSIX, spawn a separate process group and signal the group; on Windows, terminate the verified child tree with a direct `taskkill.exe /PID <numeric child pid> /T` invocation and escalate to `/F` after a short grace period. Never pass a PID from IPC and never use a shell. Await process exit before cleanup or status transition. Guard against late progress/exit callbacks with a per-run generation token so an old process cannot complete a resumed task.

Tests must prove that pause, cancel, close, output overflow, parser failure, and timeout kill a spawned grandchild as well as the immediate test child. They must also prove that Cancel removes staging, Pause leaves a resumable task with no final file, and Resume starts a fresh generation.

## Browser behavior

MPD observations appear as `dash` choices in the extension popup and in the trusted-click page overlay. They are never auto-downloaded. A YouTube video page gets one explicit `Tải video bằng FlowDM` action; the action sends the canonical page URL, not a player-response URL. Synthetic DOM `.click()` remains rejected through `event.isTrusted`.

The normal `downloads.onCreated` handoff remains limited to real HTTP(S) browser downloads. It does not cancel YouTube playback requests or bulk-capture media segments. Host missing, unsupported URL, disabled capture, or a negative native reply leaves browser behavior unchanged.

For popup/content/native messaging, continue the 0.2 epoch checks, request-ID matching, payload size limits, and header consent. `mediaType` is a fixed enum. The extension may classify `.mpd`/DASH MIME, but the main process revalidates every URL and type.

## User-visible failure classes

Errors are mapped to concise stable categories while detailed bounded diagnostics remain local:

- `TOOLS_MISSING_OR_UNVERIFIED`: yt-dlp, ffmpeg, ffprobe, EJS, or JS runtime is absent/wrong hash/wrong version;
- `UNSUPPORTED_LIVE_OR_DRM`: finite unencrypted media was not available;
- `LOGIN_REQUIRED`: account-restricted content is outside this release;
- `BOT_OR_TOKEN_REQUIRED`: YouTube rejected the environment; no bypass was attempted;
- `NO_PLAYABLE_FORMAT`: no non-DRM video/audio selection could be merged;
- `LIMIT_EXCEEDED`: output/workspace/process-output bound was exceeded;
- `MEDIA_VALIDATION_FAILED`: child succeeded but the result was missing, ambiguous, linked, malformed, or undecodable;
- `EXTERNAL_TOOL_FAILED`: sanitized exit summary, without URL queries, cookies, command line, or raw control characters.

Do not translate a killed/pause exit into a failure, and do not translate an extractor error into a completed task.

## Tool provisioning and license gate

Use a versioned tool manifest per OS/architecture containing source URL, release tag, filename, byte length, SHA-256, expected `--version`, and license/notices. Provision only from official release assets, verify the publisher checksum/signature where the release provides it, then verify the pinned hash before every use. Do not run yt-dlp self-update (`-U`) or accept an arbitrary update repository. Updates are a FlowDM release/tool-manifest change with the same verification and regression gates.

The current upstream release observed during planning was yt-dlp `2026.10.21`. Do not encode `latest` as the runtime contract; pin the exact tested tag/hash. Official documentation currently recommends the standalone `yt-dlp.exe` for Windows 10+, the zipimport `yt-dlp` for Linux/BSD, and `yt-dlp_macos` for macOS 10.15+.

Licensing is a release gate:

- the yt-dlp source project is Unlicense, but its official PyInstaller executables include GPLv3+ components and the combined executable is GPLv3+; official distributions also carry third-party notices;
- FFmpeg is LGPL 2.1+ by default, while builds using GPL components are GPL; the exact build configuration controls the obligation;
- distributing either binary requires the matching license texts, notices, exact source/build provenance, and corresponding-source path required by that build. A FlowDM MIT source ZIP alone is not sufficient evidence of third-party compliance.

Keep the tools as separate executables invoked out of process, list them in About/third-party notices, include their exact sources/checksums in release evidence, and obtain a release/license review before publishing binaries. Tests may use locally provisioned tools, but a package is not self-contained until its platform-specific resources are verified from the installed package.

## Verification matrix

### Deterministic tests (required and release-blocking)

1. Generate a short original test pattern and tone, then create a static DASH VOD with separate AVC video and AAC audio representations. Serve MPD and segments from the local fixture server.
2. Submit the MPD through the same public add/queue path as the UI. Assert separate audio/video resources were requested, the task completed once, staging was cleaned, and no other destination was written.
3. ffprobe the published result: one video stream, one audio stream, finite duration within tolerance, expected dimensions/sample rate, and no unexpected attachments/data streams. Decode the whole result with FFmpeg and require exit 0 with empty error output.
4. Cover relative/base URLs, query strings, redirects under existing HTTP policy, unknown/oversized lengths, malformed MPD, missing segment, dynamic/live MPD, DRM descriptors, audio-only/video-only inputs, merger failure, nonzero exit, deceptive success output, duplicate outputs, symlink/reparse output, executable extension, workspace overflow, stdout flood, timeout, pause/resume, cancel, close, and grandchild termination.
5. Use fake yt-dlp/ffmpeg/ffprobe executables to assert the exact argv/environment contract: no shell, no user config/plugins/remote components, no secret in argv, one stdin URL, fixed workspace/output, and trusted tool paths. Malicious title/URL characters cannot inject an argument or path.
6. Extension tests cover MPD MIME/path detection, YouTube URL canonicalization/rejection, trusted user gesture, duplicate suppression, native-host fallback, and that playback/segments are not automatically canceled.
7. Migration tests load v1/v2 journals and write the new version. Restarted external jobs are paused; no old generation can publish.

All existing direct HTTP, HLS, browser capture, bridge, desktop, recovery, coverage, and audit suites remain green. Aggregate line, branch, statement, and function coverage stays at or above 80%, with the external adapter and process-tree code receiving focused branch coverage.

### Actual online YouTube proof (required for the user's requested result)

Run this after deterministic tests with the exact packaged Windows toolchain and an isolated browser/profile/output directory. Use one small, public, non-DRM sample intended for downloader testing or an openly licensed sample. Do not use a personal account, cookies, VPN/proxy rotation, or paid/private content.

The proof is successful only when all of these are recorded:

- canonical page URL submitted through the actual extension/native host/packaged FlowDM path;
- task reaches Completed and produces one nonempty regular media file;
- ffprobe reports both video and audio and a finite duration;
- full FFmpeg decode exits 0;
- FlowDM SHA-256 equals an independent hash of the published file;
- no Cookie/Authorization/query token appears in journal diagnostics or evidence;
- native-host registrations and temporary browser/tool state are restored in `finally`.

Record the date, public video ID (not transient media URLs), yt-dlp/FFmpeg/JS-runtime versions and hashes, selected format/container, output size/hash, ffprobe summary, decoder result, and whether the run was source or packaged. Do not assert a stable media hash across dates because YouTube can change available encodes.

If YouTube returns login/bot/PO-token/403, capture only the redacted failure class and current tool versions. Update once to a separately pinned official release if the manifest and regression gate already permit it. If the same current environment remains blocked, report the online proof as blocked; do not add account cookies, PO-token plugins, impersonation, proxy rotation, or CAPTCHA automation just to turn the test green. Deterministic DASH support may still pass, but YouTube must not be called verified.

### Package and native-OS proof

Inspect Windows portable and unpacked packages to confirm platform tools, EJS/runtime, license files, and manifest hashes are present outside ASAR at the paths the main process uses. Repeat the packaged DASH and public-YouTube proof without relying on PATH-installed tools. Source-mode success does not prove packaging.

Build Linux and macOS with their native yt-dlp/FFmpeg/runtime assets and executable modes. Archive inspection is packaging evidence only. Claim runtime support for an OS only after the same local DASH fixture, process-tree, ffprobe/decode, and one public online proof run natively on that OS.

## Release acceptance

The 0.3 release may claim DASH and public YouTube support only when:

- deterministic separate-audio/video DASH passes end to end through the manager and decodes;
- actual packaged Windows extension → native host → FlowDM → yt-dlp/FFmpeg download succeeds on a public video and decodes;
- pause/cancel/shutdown terminate the whole process tree without final publication;
- all bounds, path, argv/config/plugin, privacy, and migration tests pass;
- previous 0.2 regressions and aggregate coverage/audit pass;
- tool hashes and third-party license/source evidence are present;
- Linux/macOS gaps are stated from actual native evidence, not inferred from archives.

## Primary upstream evidence

- yt-dlp README/release files/options/embedding: <https://github.com/yt-dlp/yt-dlp/blob/master/README.md>
- yt-dlp current release assets/checksums: <https://github.com/yt-dlp/yt-dlp/releases>
- yt-dlp EJS runtime guide: <https://github.com/yt-dlp/yt-dlp/wiki/EJS>
- yt-dlp YouTube extractor and PO-token notes: <https://github.com/yt-dlp/yt-dlp/wiki/Extractors> and <https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide>
- yt-dlp cookie warning/FAQ: <https://github.com/yt-dlp/yt-dlp/wiki/FAQ>
- FFmpeg protocol/demuxer documentation: <https://ffmpeg.org/ffmpeg-protocols.html> and <https://ffmpeg.org/ffmpeg-all.html>
- FFmpeg license guidance: <https://ffmpeg.org/legal.html>
