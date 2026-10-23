# Browser capture v0.2

FlowDM uses an original Manifest V3 Chromium extension. Installing the extension enables automatic HTTP(S) browser download capture by default; its popup has an explicit persistent off switch. The extension requires a separately installed native host and running FlowDM desktop application.

## Ownership and fallback

`downloads.onCreated` handles only safe, non-incognito, in-progress HTTP(S) downloads. Known non-GET requests, browser/blob/data URLs and credential-bearing URLs are excluded. Request metadata is bounded to the last 128 URLs. A filename sent to the native bridge is a basename, never a browser destination path. Capture prefers the filename returned by the post-pause browser query, since onCreated frequently has no final filename. Known authenticated requests without per-origin consent stay entirely in the browser: no pause or native request occurs, and the popup explains how to enable consent. Before consent only a Boolean credential-presence marker is retained. Some Chromium builds omit requestHeaders even when cookies are sent; absence of this marker does not prove public access. Native admission must reject access failures before the ownership acknowledgment, allowing the browser to resume.

The browser download is paused before handoff and checked again. A native response transfers ownership only if `ok === true`, its `request_id` matches, and `payload.id` is a nonempty queued task id. The browser download is canceled only while it is still paused and in progress after that acknowledgment. A failed or absent host, wrong acknowledgment or five-second timeout resumes the browser download. Transient onCreated pause failures receive at most nine attempts spaced 50 ms apart (about 400 ms), checking fresh safe in-progress browser state before each retry. Completed/canceled or user-paused downloads stop retrying. Exhausted pause failures do not send a native request or permanently mark the id handled. Duplicate onCreated events in the active worker cannot hand off twice.

A delayed host may enqueue a task after the browser-side timeout has resumed the browser. The timeout warning instructs the user to inspect the FlowDM queue before retrying; automatic retry would increase duplicate risk. After a durable queued acknowledgment, subsequent remote HTTP failures belong to FlowDM and do not restore the canceled browser task. If Chromium completes or the user resumes a task during handoff, FlowDM cannot safely cancel that browser task: a possible duplicate is preferable to discarding the browser result.

## Media and privacy

An isolated content script detects real video/audio/source elements and dynamic source changes. It inserts a user-click button beside the media element. Synthetic page-script clicks are ignored; the button requires a trusted browser event. A separate response observer detects direct video/audio MIME responses, HLS URLs/MIME and DASH URLs/MIME, including manifests used by blob-backed players. Media observations alone never download streams. HLS and direct media are selectable; DASH is an explicit unsupported diagnostic. There is no DRM bypass.

Detected URLs retain signed query strings and omit fragment identifiers for deduplication. Metadata is session-only: at most 30 items per tab and 100 tabs, expiring after five minutes, with navigation/removal clearing the tab. `chrome.storage.session` survives worker suspension, not a browser session restart. Full URLs and headers are not rendered in popup labels or written to logs.

Cookie, Authorization, Referer and User-Agent headers are collected only after explicit consent for the download URL's origin. The popup domain selector includes the current page and detected media origins, allowing explicit consent for a media CDN separately from the page. Consent requests the optional cookies permission. No such headers are retained before consent; collection is bounded in memory and the handoff accepts only a recent request. Disabling consent immediately drops that origin's captured headers. Permission revocation clears all consent. Desktop redirect handling must strip sensitive headers across origins. No cookie or authorization values are persisted by this extension. With consent and the optional permission, an explicit handoff can query current URL-scoped cookies without a page reload if no recent Cookie header was observed. This query has a one-second bound, sanitized cookie pairs and a 16 KiB limit; consent and current optional permission are checked after asynchronous lookups and immediately before dispatch. Per-origin consent generations and a global permission generation abort stale sends, even when consent is revoked and quickly granted again. Permission removal invalidates pending sends synchronously before awaiting storage. Automatic handoffs abort and resume the browser on a stale generation. Referer is forwarded only when actually observed in a consented browser request; it is never guessed from the page URL, which could bypass Referrer-Policy or expose private query tokens to a CDN. Missing User-Agent is taken from the extension browser navigator only with consent. Neither headers nor page URL context are persisted. Authorization tokens can only come from a recent consented network request, so a page reload may still be needed for bearer-authenticated media.

## Browser E2E contract

Load `extension/` unpacked and install the `local.flowdm.bridge` native host for the exact extension id. Open `chrome-extension://<id>/popup.html` in a browser tab to automate the real popup.

Stable selectors:

- `[data-testid="auto-capture"]`: persistent automatic capture toggle.
- `[data-testid="credential-origin"]`: choose the current page or a detected media origin for explicit consent.
- `[data-testid="credentials"]`: selected origin's explicit credential permission toggle.
- `[data-testid="site-origin"]`: origin to which that consent applies.
- `[data-testid="capture-status"]`: most recent handoff result.
- `[data-testid="media-list"]`: media rows; each row has `data-media-type`.
- `[data-testid="download-media"]`: row download button; DASH is disabled.
- `[data-testid="flowdm-media-overlay"]`: actual page media download button.

Runtime messages are `flowdm:state {tabId}`, `flowdm:settings {autoCapture?,origin?,credentials?}`, `flowdm:media {items}`, `flowdm:options`, and `flowdm:download {tabId?,url,mediaType}`. Extension pages are identified by their own extension id and extension URL, including popup pages opened as browser tabs. Content script settings requests are rejected. A content script can only download media already detected on its own non-incognito tab. Native framing is `{schema:1,request_id,op:'add',payload:{url,filename?,headers?,mediaType?}}`.

## Verification

Tests were written and observed RED before creating the capture and media modules. A dynamic media click test also caught a stale-source closure and passed after correction. Commands run:

```
node --test tests/bridge/extension*.test.cjs
node --experimental-test-coverage --test tests/bridge/extension*.test.cjs
```

Latest result: 38 passed, 0 failed. Native Node coverage of the exercised extension source is 100% lines; branches are background 93.10%, capture 89.81%, content 70.59%, media 96%, popup 91.89%. Whole run including the installer integration path and mocked Chrome helper: 98.99% lines, 89.86% branches, 89.09% functions. Content script behavior, DOM mutation and popup controls are tested with DOM/Chrome fakes; these are not a claim of real-browser coverage. The parent task owns the independent real-browser E2E and its evidence.





