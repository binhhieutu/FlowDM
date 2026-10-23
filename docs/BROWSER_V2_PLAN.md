# Browser capture and video — v0.2 execution packet

Objective: installing/enabling the FlowDM MV3 extension transfers ordinary browser downloads to the desktop, discovers direct video and HLS VOD, and produces byte-correct playable files through the real native host.

Risk: high (browser permissions, cookie/header consent, canceling browser downloads, persisted state). No user browser profile or global settings changed by automated tests. A temporary native-host registry registration owned by this test is backed up and restored in finally; Chromium runs an isolated profile.

## Acceptance

- Auto capture: real Chromium HTTP attachment becomes a completed FlowDM file; original browser item canceled only after acknowledged queued ID. With desktop absent or disabled, original download completes in browser.
- Popup/content detector: direct video/audio/source and network HLS; DOM mutation without duplicate overlays; choose a video explicitly; no automatic bulk video download.
- Per-origin credential consent defaults off. Only allowlisted headers sent after consent; never persisted in task journal. Redirect strips credentials. POST/blob/incognito/dangerous/unsupported sources retain browser handling.
- HLS VOD: master selection and unencrypted TS/fMP4 playlist with exact segment content; pause/restart safe; reject live/encrypted/unsupported separate-audio/broken manifests. Real generated media decoded by ffmpeg in test, no bundled ffmpeg requirement.
- Browser setup in desktop exposes unpacked extension location and creates native host bundle. No external Node dependency for packaged Windows if copied Electron host runtime can be verified. Native-host registration is explicit from setup UI; no silent edits to user browser profiles.
- Unit/integration regression and real browser → native host → manager file tests. Final aggregate coverage >=80%, independent code/security review, Windows executable/extension/source archives refreshed. Linux packaging and Mac runtime gaps reported honestly.

## Ownership / contracts

Extension lane: extension/** + extension-specific bridge tests. Core/media lane: src/core/**, src/media/** and tests/core/**, tests/media/**. Bridge lane: src/bridge/** and bridge protocol tests. Primary: main/preload/UI, browser setup service, real browser E2E, package/release/docs. Disjoint edits; common add payload `{url, filename?, headers?, mediaType?: 'direct'|'hls'}`.

Native reply stays `{request_id,ok,payload:{id}}`; accept only matched ID with a nonempty task ID. Directory and scheduling cannot be injected from a web page. HLS is explicit type or `.m3u8` path. Signed query preserved; no query/body/header logs.

## Gates / sequence

1. RED/GREEN extension capture, consent and detector; RED/GREEN strict bridge schema; RED/GREEN HLS parser/engine. Focused tests first.
2. Desktop setup/permission UI and host generation with tests before implementation. Browser test uses real native messaging and temporary registration, never mocks sendNativeMessage.
3. Slice E2E success and host-down fallback, dynamic direct video, HLS, authenticated site consent, extension settings. Network and output bytes/hashes are the oracle.
4. Freeze code, review, fix reproduced findings, final coverage/audit/build once, packaged browser smoke, refreshed checksums/source archives.

Open native verification gaps from 0.1: no Linux/Mac machine. Do not call these verified just because source/archives exist. Advanced DRM/site-specific extraction/FTP/proxy parity is not implied by this slice.
