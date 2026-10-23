# Browser bridge implementation evidence

Date: 2026-10-23. Platform: Windows, Node v23.6.0.

- TDD RED: `node --test tests/bridge/bridge.test.cjs` failed with missing protocol module before implementation. `node --test tests/bridge/extension.test.cjs` separately failed for missing extension and installer.
- GREEN: `node --test tests/bridge/*.test.cjs` passes protocol, local authenticated dispatch, malformed input, errors, timeout, deduplication, host subprocess, extension mock and bundle generation.
- Coverage command: `npx c8 --include=src/bridge/** --exclude=src/bridge/host.cjs --all --check-coverage --lines=80 --statements=80 --functions=80 --branches=80 --reporter=text node --test tests/bridge/*.test.cjs`. Result: all nine tests pass; thresholds pass, 95.20% lines/statements, 82.81% branches, 86.66% functions. Host subprocess also runs under c8 but excluded consistently with project coverage script. Final whole-project totals are reported by the parent release verification.
- No Chrome/Edge profile, registry or third-party resource was changed. Real browser registration and POSIX execution remain unverified. Native host child-process communication is verified independently of browser installation.

Integration: `const {createBridge}=require('./bridge/server.cjs')`; `await createBridge({dataDir,onAdd:payload=>manager.add(payload)})`; await returned `close()` on shutdown. `dataDir` must be absolute and match the manually configured host. Only `{url}` reaches onAdd; only task ID returns to extension.

Sources and manual setup are in BROWSER.md. Source ownership is src/bridge, extension, tests/bridge, and these two docs; no package.json edits were made by the bridge worker.
