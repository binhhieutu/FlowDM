# HLS video support verification

Implemented core scope: HTTP/HTTPS unencrypted finite HLS VOD. `DownloadManager.add()` accepts `mediaType: 'hls' | 'direct'`; absent a type, a URL pathname ending in `.m3u8` selects HLS, including signed query URLs. Explicit `direct` preserves ordinary-file behavior. URL strings are bounded to 32,768 characters.

The resolver follows at most four manifest levels and selects the largest declared BANDWIDTH variant. It supports relative HTTP/HTTPS URIs, ordered MPEG-TS byte concatenation into `.ts`, and one initial EXT-X-MAP followed by fragments into `.mp4`. It does not transcode, remux, inspect codecs, or combine separately served audio/video. A muxed media playlist remains the origin server's responsibility. The manifest filename is replaced with the actual supported container extension; destination allocation and atomic publication never overwrite an existing file.

## Safety and recovery

- Manifests: at most 1 MiB each, at most 10,000 media segments and 1,000 master variants. Parser limit overrides can only lower these hard bounds. An ENDLIST and nonempty segment list are mandatory. Master selection scans actual line indexes once and retains only the best candidate, without repeated index lookup or sorting.
- Every resource must return unencoded HTTP 200. Advertised and actual body sizes are checked; total assembled bytes obey the manager's existing maxBytes (100 GiB default). Empty/truncated resources fail visibly.
- Every TS segment must start at a 188-byte packet boundary, have byte 0x47 at every packet boundary across arbitrary HTTP chunks, and end on a full packet. Packed AAC, HTML login responses and unsupported packet framing fail. Each fMP4 resource is scanned as bounded top-level ISO BMFF boxes: valid bounded 32/64-bit sizes, permitted box types, no truncation, initialization starts with ftyp and contains moov, fragments start with styp/sidx/moof and contain moof before mdat. This scanner retains at most 16 header bytes; it does not decode or verify codec payloads. Corrupt elementary streams inside structurally valid containers can still require a player/decoder to diagnose.
- Existing HTTP retry policy applies before reading each resource: up to three attempts, bounded exponential delay, 15-second socket inactivity timeout, five redirects. Streaming failures fail the task; user Retry safely starts the whole VOD again.
- Cookie, Authorization, Proxy-Authorization and Referer are stripped on cross-origin requests and redirects; a redirected manifest cannot restore removed credentials when resolving children. HTTPS-to-HTTP resource transitions and redirects are refused. Credentials in URLs and non-HTTP schemes are refused.
- Request headers remain session-only. The journal stores source/final URLs, which can include signed queries; it never stores manifest bodies, segment lists, or request headers.
- Pause, shutdown, retry and process-restart recovery use **restart from the beginning**, not segment append/resume. The output partial is removed and recreated exclusively before a new HLS attempt. Existing durable byte checkpoints allow honest UI progress and recovery validation but are never trusted for mixing segment versions.
- Reuses existing queue, schedule, per-host cap, speed limiter, abort controls, SHA-256 and safe hard-link publication. Only complete successful output becomes Completed. Digest-verified final files recover without network; obsolete `.part` files are removed after verified recovery.

## Explicitly unsupported

Live/event streams without ENDLIST, AES-128/SAMPLE-AES/DRM, alternate/separate AUDIO or VIDEO master renditions, packed AAC/MP3/WebVTT, non-188-byte TS framing, unrecognized top-level BMFF boxes or zero-size boxes, byte ranges including MAP ranges, changing initialization maps, discontinuities, gaps, delta/partial playlists, I-frame-only streams, URI variables, DASH, automatic website extraction and transcoding. These cases fail explicitly. No ffmpeg dependency or claim of universal media compatibility.

## Verification

Tests were introduced failing before parser implementation. Local deterministic HTTP fixtures verify byte-exact TS/fMP4 assembly and SHA-256, highest-bandwidth choice, ordered initialization map, queue integration, pause and manager restart, header secrecy and cross-origin redirect stripping, explicit direct override, invalid inputs, malformed/unsupported manifests, segment failure/truncation/empty bodies, aggregate byte limits, and no completed output on failure. Existing direct HTTP integration tests remain enabled. Crash-publication tests now assert obsolete partial cleanup.

Command: `node node_modules/c8/bin/c8.js --include=src/core/** --include=src/media/** --reports-dir=coverage-hls --reporter=text node --test tests/core/*.test.cjs tests/media/*.test.cjs`.

Most recent passing baseline: 43 tests; aggregate line/statement coverage 99.25%, branch coverage 90.32%, function coverage 100%. Container checker coverage: 100% lines, 97.77% branches. Synthetic fixtures now use framed TS packets and BMFF boxes; exact output comparisons remain. HTTP-200 HTML, AAC, invalid initialization, missing moof, wrong packet sync and partial packet fixtures fail without publication. These fixtures test framing, not decodability.

The master-variant regression reproduces the previous quadratic scan with 18,000 variants below the byte limit (3,804 ms before the fix), rejects over 1,000 variants, selects the correct winner at the exact cap, and verifies duplicate tag lines use their actual following URI. The combined regression took 30 ms under coverage after the fix. UI and packaged application checks belong to the main integration run; this report does not claim public-site compatibility or native media playback tests.
