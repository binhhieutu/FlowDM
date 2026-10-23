# Browser bridge v0.2

The native messaging protocol retains schema `1`, operation `add`, and the existing authenticated local pipe/socket. `payload` accepts `url` plus optional `filename`, `headers`, and `mediaType` (`direct` or `hls`). Other fields are rejected.

URL validation permits HTTP/HTTPS only, limits length to 16,384 characters, and rejects embedded credentials and control/space characters. Filename validation requires a single basename of 1–180 characters, rejects Windows reserved device names, path separators, illegal filename characters, and trailing dot/space. Header names are restricted to Referer, User-Agent, Cookie, and Authorization, normalized to lowercase, and checked for duplicates after normalization. Header values must be HTTP-compatible strings without line breaks or invalid controls. The header object permits at most eight entries and a total of 64 KiB, including names.

The bridge compares SHA-256 fingerprints of the entire normalized payload when deduplicating request IDs. A retry with reordered header keys or different header capitalization receives the same acknowledgment. A different filename, media type, or header value returns `REQUEST_ID_CONFLICT`. The callback receives a deep clone. Successful acknowledgment contains only `{id}`; callback exceptions produce generic error codes. Payload headers are never written to the bridge configuration, dedupe cache, logs, or replies. Credential forwarding consent and session-only persistence are responsibilities of the extension/core.

## Desktop onboarding API

```js
const { createHostBundle } = require('./src/bridge/install.cjs');
const { manifestPath, wrapperPath, hostPath } = await createHostBundle({
  output: absoluteBundleDirectory,
  dataDir: absoluteDesktopDataDirectory,
  extensionId: exactChromeOrEdgeExtensionId,
  nodePath: absoluteStableRuntimeExecutable,
  electron: true,
});
```

The runtime may be Node.js 22+ or an Electron executable supporting `ELECTRON_RUN_AS_NODE=1`. The desktop onboarding layer must place a portable Electron runtime in a stable directory before invoking this helper. Pointing at a temporary portable extraction directory will break after that directory is removed. Runtime copying and verification are outside this helper.

The helper creates native-host source files, a launcher, and `local.flowdm.bridge.json`; it does not write registry entries or register a browser. Registration must be an explicit onboarding action with the exact extension ID. Existing files are not overwritten. The legacy `generateBundle({outputDir, ...})` export returns only the manifest path, and the CLI still accepts `--output`, `--data-dir`, `--extension-id`, optional `--node`, and `--electron`.

On Windows, the launcher disables delayed expansion and quotes every fixed path. Browser-supplied command-line arguments are not forwarded because the protocol uses stdin/stdout. Spaces and shell metacharacters inside quoted paths work. Paths containing `%`, `!`, double quotes, or control characters are rejected to prevent command expansion. POSIX launchers use single-quoted arguments.

## Verification

TDD: the new metadata, canonical dedupe, and bundle integration tests failed against v0.1 before implementation. `node --test tests/bridge/bridge.test.cjs` passes all 12 bridge tests, including a real generated Windows `.cmd` launcher in a directory containing spaces, ampersand, and parentheses, private IPC, framed Unicode stdin/stdout, malformed/truncated frames, message count limits, generic failure replies, and installer CLI invocation.

`node node_modules/c8/bin/c8.js --include=src/bridge/** --reporter=text node --test tests/bridge/bridge.test.cjs` reports bridge aggregate coverage: 98.06% statements/lines, 88.83% branches, 94.73% functions. Browser extension behavior and actual browser registration are verified separately by the desktop/extension integration work.
