# Browser v3: explicit DASH and YouTube handoff

The browser bridge continues to auto-capture ordinary HTTP(S) downloads only. It does not cancel a browser download merely because an MPD manifest was observed. DASH and YouTube transfer starts only after the user clicks the FlowDM control in the page overlay, extension popup, or browser context menu.

## Accepted media selections

- HLS: detected `.m3u8` or HLS MIME response.
- DASH: detected `.mpd` or `application/dash+xml`; the native media engine must reject DRM/protected manifests before publication.
- YouTube: a user-visible page that is exactly one of `youtube.com/watch?v=<11-id>`, `youtube.com/shorts/<11-id>`, or `youtu.be/<11-id>`.

The extension canonicalizes those YouTube forms, rejects blobs, stream fragments, channels, playlists, invalid IDs, credentials in URLs, and lookalike hosts. A content script may register a YouTube entry only where its sender tab has the same canonical video URL. It never turns observed network requests into an automatic YouTube transfer.

## Privacy and fallback

Credential transfer remains disabled unless the user grants the matching origin. No page URL is invented as `Referer`. Explicit DASH and YouTube requests, including a right-click MPD or canonical YouTube page URL, infer the external media type before header handling and strip every browser-derived header, including `Cookie`, `Authorization`, `Referer`, and `User-Agent`, even if a site has consent; those selections do not depend on optional cookie permission. If the native host rejects the explicit request, the popup/overlay reports the failure; normal browser downloads remain under browser ownership.

## Admission contract

For explicit `dash` and `youtube` handoffs, the native admission gate verifies media-tool availability before queueing. It avoids treating the YouTube watch page HTML as a direct downloadable file. Manifest parsing and DRM rejection are performed by the media backend. HLS and direct-download admission retain their existing accessibility probes.

## Focused tests

`node --test tests/bridge/extension-media.test.cjs tests/bridge/extension.test.cjs tests/bridge/extension-popup.test.cjs tests/browser/admission.test.cjs`

The suite covers DASH selection, `.mpd` auto-capture exclusion, canonical YouTube URL acceptance, lookalike/channel/playlist rejection, same-tab sender checks, popup selection, native tool-gated handoff, credentials, and existing fallback behavior.
