# FlowDM execution ledger

Plan: docs/superpowers/plans/2026-10-23-flowdm.md

2026-10-23 | Setup | User authorized autonomous implementation and testing. Design decisions documented; preserve reverse-analysis sources. Independent tasks use disjoint allowlists. Shared contract: manager in DESIGN.md, bridge dispatch callback in main.

Ruling: Build dependable HTTP/HTTPS desktop scope first and explicitly document advanced IDM features that are still absent. Cost: no claim of complete IDM parity.

Ruling: Use Electron rather than Rust/Qt for one UI and actual automated desktop testing with the available Node environment. Cost: larger application binary.

2026-10-23 | Engine | RED missing module, GREEN initial engine; release review reproduced weak Last-Modified mixing, publication crash gap and late unsupported-filesystem failure. Fixed with ETag-only byte resume, offline full SHA/size final recovery and destination capability preflight. Final 29 core tests green.

2026-10-23 | Browser | RED missing module, GREEN 9 protocol/extension cases, including actual Node native-host subprocess. No browser/registry modification. Installer is manual-only.

2026-10-23 | Desktop | RED absent main, then fixed test environment ELECTRON_RUN_AS_NODE presence and Windows cleanup ordering. Source and Windows packaged E2E green: byte-identical completed file, pause/restart/resume, custom folder/schedule/cancel, filters, invalid input, 404, sandbox/context isolation. NSIS strips Playwright loader; portable smoke uses temporary loopback CDP and passes same pause/restart/resume byte check.

2026-10-23 | Review | Independent reviewer confirmed all 1 P1 and 2 P2 fixed; no remaining blockers in reviewed scope. Deferred minor: publication crash recovery may retain an obsolete internal .part copy; documented in README/verification.

2026-10-23 | Release gate | npm run test:coverage: 38 unit/integration + actual Electron journey green; aggregate all-src V8 96.70% lines/statements, 86.54% branches, 92.13% functions. npm audit zero vulnerabilities. Real HTTPS smoke 502941 bytes equals independent fetch.

2026-10-23 | Packaging | Windows portable ~101 MB passes direct GUI smoke; Linux tar.gz ~125 MB created, corrected POSIX executable permissions and verified 71 payloads. Both ASARs contain 17 runtime source/asset files exactly matching frozen source. macOS builder explicitly refuses Windows host. No native Linux/Mac runtime available; never claimed their runtime verification. CI matrix provided locally, not dispatched.

2026-10-23 | v0.2 | Browser capture/video slice implemented: automatic ACK-gated HTTP downloads, explicit media popup/content button, per-origin credential consent, native-host setup UI with stable Windows runtime, finite TS/fMP4 HLS and v1 journal migration. Real Chromium + Electron source and Windows unpacked E2E pass, including popup buttons, cookie/no-consent and host-down browser fallback; three generated media outputs decode with FFmpeg. Existing IDM hook isolated using renamed CFT copy; owner process/profile preserved and native registration restored.

2026-10-23 | v0.2 review | Six confirmed P1/P2 fixed: synthetic-click handoff, stale consent, registration write-ahead ownership, quadratic HLS parsing, undurable add starting after rejection, guessed Referer query leak. Independent focused review closes all findings. 102 unit/integration + source desktop E2E pass; aggregate src/extension V8 97.88% lines, 88.54% branches, 96.06% functions; audit zero vulnerabilities. Final package evidence tracked in docs/VERIFICATION_V2.md.

2026-10-23 | v0.3 | Added static DASH separate A/V + public YouTube using pinned yt-dlp/FFmpeg, MPD validation/byte-bound relay, atomic MP4 publication, no external-media browser headers, minimal child environment, process abort/size guards and journal v3. Actual public Big Buck Bunny 634.624s/1080p/H264+AAC downloaded through source, packaged GUI, real Chromium popup/native host and final portable; full decode exit0 and stable SHA. Browser real test exposed missing YouTube DOM/SPA stale selection, fixed via trusted current-tab URL and handoff recheck. CDP portable close harness fixed with renderer window.close. Final 122 unit/integration + desktop coverage green: 97.26% lines, 85.46% branches, 95.26% functions. Audit zero; review closes code P1/P2. Windows/private-build proof and Linux/Mac/redistribution limits in VERIFICATION_V3.md.
