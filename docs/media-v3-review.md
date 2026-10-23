# FlowDM 0.3 DASH and YouTube review

Review date: 2026-10-23. Scope: the uncommitted 0.3 media adapter, download-manager integration, tool resolver and lock manifest, browser capture path, and focused regression tests. This review does not treat a successful build as native runtime evidence on another operating system.

## Decision

No P1 or P2 finding remains open after the final focused fixes and rerun. The Windows implementation has a conservative boundary: only public finite unencrypted DASH and canonical public YouTube pages are delegated; browser credentials are refused; yt-dlp configuration, plugins, and remote components are disabled; output is validated before an atomic manager publication; failures do not publish a final file. This supports a private Windows release candidate subject to the verification and platform limits below.

## Findings and dispositions

### P1 resolved: CDATA bypassed DASH reference validation

The first reviewed version validated MPD references with regular expressions, but an XML parser decoded CDATA before yt-dlp resolved the URL. The following static MPD passed that preflight:

```xml
<MPD type="static">
  <BaseURL><![CDATA[http://127.0.0.1/private/]]></BaseURL>
</MPD>
```

The validator interpreted the literal `<![CDATA[...]]>` as a relative path. Pinned yt-dlp interpreted it as the absolute URL inside CDATA. An end-to-end reproduction served the MPD from server A and the checked-in separate-audio/video fixture from server B. yt-dlp exited zero, and server B received every initialization and media-chunk request. A remote HTTPS MPD could therefore bypass the intended decoded-reference and HTTPS-downgrade checks and direct requests to loopback or another private origin outside the relay.

The final adapter rejects CDATA and namespaced URL-bearing/DRM elements before reference extraction. The focused preflight regression now covers both forms and passes. If the supported XML subset later grows, replace the regular expressions with a hardened XML parser and validate decoded element text and attributes.

### P2 resolved: the browser and core disagreed on mobile YouTube URLs

The extension canonicalized `m.youtube.com/watch?v=...`, while the first reviewed core adapter rejected it after queue admission. The final policy and adapter accept the same finite host forms as the extension, and a cross-layer regression covers desktop, mobile, and short-link forms.

### P2 resolved: the no-remote-component rule relied on an upstream default

The pinned yt-dlp release already defaulted to no remote components and the child received a minimal environment. The final fixed invocation also passes `--no-remote-components`, so the rule no longer relies on that upstream default.

### P2 resolved: cancellation waited during local publication copy

Process-tree termination and FFmpeg validation were abort-aware, but the first reviewed `copyVerifiedFile()` did not inspect the abort signal. The final copy checks the signal before opening, between blocks, and before fsync; an aborted copy closes both handles and removes its incomplete manager partial.

### P3 resolved: invalid explicit YouTube input left an empty scratch directory

An explicitly forced `mediaType: "youtube"` with a noncanonical HTTP(S) URL was rejected after the random scratch directory was created but before the outer cleanup `finally` began. The final adapter canonicalizes YouTube input before `mkdir`, and a regression verifies that failure creates no scratch workspace.

### P2 resolved: popup state retained a stale YouTube URL after SPA navigation

The first popup-discovery branch appended the current canonical YouTube URL to cached tab media. After an SPA navigation from video A to B, the popup could therefore list both and still accept a click on stale A. The final media store reconciles its single YouTube row to the URL returned by `chrome.tabs.get`, removes it when the current tab is no longer a canonical public video, and checks the fresh tab URL again immediately before a YouTube handoff. Web/content senders cannot invoke popup state, incognito and lookalike tabs produce no row, and state lookup alone never contacts the native host. The A-to-B regression verifies that stale A is removed and rejected.

## Resolved controls inspected

- DASH preflight is bounded to 1 MiB, requires HTTP 200 and a static manifest, rejects DTD/entities, DRM markers, live/update metadata, non-HTTP references, HTTPS-to-HTTP decoded references, `Location`, and xlink relocation.
- The exact preflighted MPD bytes are served once through a loopback-only relay, which removes the earlier second-fetch manifest time-of-check/time-of-use window. Relay methods, byte ranges, origins, and response sizes are bounded.
- YouTube input is reduced to an 11-character video ID and rebuilt as a canonical watch URL. Playlists, live/upcoming/post-live content, account cookies, browser headers, and arbitrary extractor URLs are not accepted.
- yt-dlp reads the URL through stdin, receives no browser secrets or inherited API/proxy/loader variables, ignores configuration, disables plugin directories, selects bounded MP4/H.264/AAC formats, and writes only under a random private scratch directory.
- Stdout and stderr retention is bounded. The scratch tree is monitored with a separate three-output workspace allowance, symlinks and unusual entries are rejected, and reported result paths must be immediate scratch children.
- Abort and timeout wait for child closure after terminating the process tree. FFmpeg output validation consumes bounded stderr and waits for close, avoiding publication while a validator is still running.
- Output must be a nonempty regular file within the configured final-output cap and pass a one-second FFmpeg decode with both video and audio. It is copied exclusively to the manager partial, fsynced, hashed, journaled, and atomically published by the existing manager path.
- External tasks use journal schema 3 and restart-only semantics. Progress uses a high-water mark across selected tracks and no credentials are persisted.
- Packaged Windows resolves only the resource-directory yt-dlp and FFmpeg files, rejects environment overrides, and checks exact size and SHA-256 from `assets/media-tools.json`. The child uses Electron's runtime with `ELECTRON_RUN_AS_NODE=1`.
- The Windows package carries yt-dlp notices and the FFmpeg GPLv3 text/build configuration. `docs/MEDIA_TOOLS.md` correctly limits the present result to a private local artifact and requires a corresponding-source review before public redistribution.
- The extension transfers an external-media URL only after a real user click. It excludes MPDs from automatic browser-download ownership transfer, strips all browser-derived headers for DASH/YouTube, checks that content-script requests match media detected in the same tab, and requires a durable native acknowledgement.

## Evidence observed

- `node --test tests/media/*.test.cjs tests/core/external-download.test.cjs tests/tools/*.test.cjs`: 20 passed, 0 failed after the final security and cleanup fixes.
- `node --test tests/bridge/extension*.test.cjs tests/browser/admission.test.cjs`: 46 passed, 0 failed after popup discovery and stale-SPA reconciliation.
- The integration owner reported a real source-mode Electron YouTube download of a public 634.624-second sample: 288,738,744 bytes, H.264 1920x1080 video plus AAC audio. FFmpeg decoded the entire file with `-xerror`, exit code 0, and empty stderr. The packaged-mode media suite also passed 3/3 with a full decode before the final background-only delta; final-archive browser/portable smoke remained pending at this review point.
- Actual Chromium navigation to the public YouTube page, popup selection, native-host handoff, 288 MB completion, and two-stream probe passed. The state lookup itself issued no native handoff; transfer began only after the popup click.
- The integration owner reported an actual Chromium popup/native-host DASH transfer of the checked-in separate-audio/video MPD plus HLS/direct/cookie-fallback paths. The DASH output had two streams and completed a full three-second decode.

The public YouTube evidence records `wholeFileDecoded: true` after the complete FFmpeg run. Bot/login/PO-token failure must remain a visible unsupported/upstream result; it is not a reason to import account cookies or add an evasion path.

## Platform and release limits

Windows is the only native runtime exercised in this cycle. Linux and macOS currently resolve yt-dlp and FFmpeg from the host and have no native DASH/YouTube execution evidence here. Archive creation or source portability does not establish runtime support. Repeat the fixture, cancellation/process-tree, browser/native-host, probe/decode, and one public-video proof on each OS before calling those targets verified.

The included binaries are unsigned. The current build is private and local; no publish, push, signing, or public distribution action was authorized. A public release needs exact third-party source/build-provenance and corresponding-source compliance review in addition to the license texts already present.

Primary release closure: final ASAR browser/native-host E2E passed again with a real YouTube page and popup click. The final FlowDM 0.3.0 portable also passed pause/restart/resume, bundled media integrity and a real 288,738,744-byte YouTube download with SHA-256 identical to the fully decoded sample. See VERIFICATION_V3.md and evidence/v0.3 for the final logs and checksums.
