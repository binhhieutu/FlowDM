# FlowDM design

Build a new desktop download manager from the reconstructed feature specification at `../IDM/analysis/RECONSTRUCTION_SPEC.md`. Own source and visual identity; no IDM code or assets copied.

Electron plus a dependency-free Node.js HTTP/HTTPS engine was selected over Rust/Tauri (additional native toolchains and GUI test setup) and Python/Qt (extra runtime/packaging ecosystem). One desktop interface on Windows, Linux and macOS; native verification is reported separately per OS. Initial scope is a dependable daily-use downloader, not full IDM parity.

## Behavior

Add HTTP/HTTPS URLs, choose destination/name, 1–8 connections, queue up to three jobs, pause/resume/cancel/retry, persisted history and restart recovery, schedule at an explicit instant, per-download speed limit, final SHA-256. Never overwrite an existing file. Reject unsafe filenames, credential URLs, invalid input and non-HTTP schemes. Local URLs are intentionally allowed for LAN downloads and fixture tests. Never execute downloaded content automatically. HTTPS redirects may not downgrade to HTTP.

Range responses require exact Content-Range and representation validation. Servers ignoring Range fall back to a fresh single stream. Resume across sessions is allowed only after trustworthy validators; otherwise restart safely. Write temporary segment data, flush before journal checkpoints, then publish a complete file without overwrite. Stored URLs may contain signed queries (needed for resume); explain this in documentation; credentials/headers are session-only. Renderer loads local assets with CSP, sandbox, no Node, narrow validated IPC. No web administration endpoint.

## Modules and interface

`src/core/download-manager.cjs` exports DownloadManager; constructor `{dataDir,downloadDir,maxConcurrent}`; methods `init`, `add(input)`, `list`, `pause(id)`, `resume(id)`, `cancel(id)`, `remove(id)`, `close`; `change` event. Input `{url,filename?,directory?,connections?,headers?,startAt?,speedLimit?}`. Tasks expose `{id,url,filename,path,status,totalBytes,downloadedBytes,speed,error,connections,segments,createdAt}`; statuses queued/downloading/paused/completed/failed/canceled. Asynchronous mutations. Never expose mutable internal task references.

`src/main.cjs` handles OS lifecycle, single instance, directory selection and IPC. `src/preload.cjs` exposes only named operations. `src/ui/` renders Vietnamese interface with no framework or remote resources. `src/bridge/` provides framed Native Messaging and authenticated local socket handoff; optional MV3 context menu extension. No browser download is canceled automatically. Extension and host installation remains an explicit user action.

## Visual direction

Compact workstation UI: deep blue navigation #16324f, mist workspace #f3f6fa, white rows #ffffff, teal activity #087f8c, slate text #24374b, amber error #aa5a10. Segoe UI/system sans for controls and monospaced transfer numbers. Signature: real per-connection progress strips beneath the selected transfer. Sidebar filters, compact toolbar, file rows, bottom detail panel; empty state explains adding a link. Accessible labels, keyboard focus, responsive layout; no marketing dashboard or fake statistics.

## Validation

Tests before engine/protocol implementation. Fixture server asserts exact bytes/SHA-256 for segmented, ignored Range, interrupted, changed-validator, redirect, retry, missing length and malformed responses. Queue, persistence, scheduler and cancellation invariants tested. Unit/integration coverage threshold >=80%. Electron E2E adds a real local download, pauses/resumes, restarts and verifies file bytes, errors and persistence. Package Windows executable and run packaged smoke; build Linux artifact where supported. Supply CI matrix for native Windows/Linux/macOS checks but do not claim those ran without evidence. No publishing or signing credentials.

Known later scope: FTP, advanced site grabber, DRM-free HLS/DASH assembly, authenticated proxy profiles and automatic browser interception are not advertised as implemented until independently tested.
