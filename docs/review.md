# Independent release review

2026-10-23. Scope: all core, Electron main/preload/renderer, browser bridge and extension source, design, bridge report, and core/bridge/Electron tests. Read-only source review; existing suites were not rerun and source was not modified. `docs/core-report.md` was absent at inspection. Reported test/coverage results belong to the implementation/release lane, not this review.

Recommendation: request changes for the integrity and recovery issues below. No concrete IPC-origin, renderer injection, bridge authentication, or credential persistence vulnerability was identified in the inspected implementation. Native macOS/Linux execution and actual browser host registration remain separate unverified release checks.

## P1: Last-Modified is promoted to a strong resume validator without evidence

Location: `src/core/http-client.cjs:65`, consumed by `src/core/download-manager.cjs:155-164`.

The probe accepts any Last-Modified string when a strong ETag is absent. The manager then treats equal timestamp and length as enough to append ranges to saved bytes. Last-Modified has one-second granularity and is implicitly weak unless strength can be established; the code never inspects Date or otherwise establishes it. See [RFC 9110 section 8.8.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.2.2).

Reproduction: serve body A with ranges, no ETag, and Date equal to Last-Modified; pause after a nonempty prefix. Replace the resource with same-length body B during that timestamp's second, retain the legitimate same Last-Modified, and resume. The equality check succeeds and the output combines A's prefix with B's suffix. All byte counts pass; the application computes a SHA-256 of the mixed result and marks it complete. A computed hash alone cannot detect this representation mix.

Fix: use only strong ETags for range continuation for now, treating Last-Modified-only responses as fresh single streams. Alternatively implement and persist defensible Last-Modified strength evidence and enforce it for both old and new metadata. Add a regression asserting same-timestamp/same-length changed content restarts and produces exactly B.

## P2: A crash during successful publication cannot recover the completed task

Location: `src/core/download-manager.cjs:187-190`; `src/core/storage.cjs:45-46`.

The last durable journal still says downloading when `publish` creates the final hard link and removes the partial file. Completed state is journaled only afterward. A crash between those actions and the final journal leaves a full final file paired with a restored paused task. Resume finds the partial absent, downloads again, and fails EEXIST during publication. If the partial still exists, the same EEXIST occurs without needing another transfer. Retry never resolves the conflict, even though this task's exact completed bytes are already present.

Fix: record an explicit publication intent with expected size and SHA-256 before exposing the destination, then reconcile that state at init/resume. Verify the destination is a regular file and matches the recorded expected digest before adopting it; preserve unrelated existing destinations. Test crash snapshots both after final link creation and after partial deletion, and assert successful recovery without a network redownload.

## P2: Arbitrary destination selection silently requires hard-link support

Location: `src/core/storage.cjs:45`; destination selection in `src/main.cjs:71-74`.

Every successful transfer is published using a hard link. Common removable FAT/exFAT destinations do not support hard links, so choosing such a download folder transfers and hashes the entire file before failing at publication. Retry repeats the failing publication path. There is no early capability check or useful explanation of the filesystem restriction.

Fix: support an appropriate atomic no-replace publication primitive for the selected filesystem, or explicitly preflight and reject unsupported destinations before starting a network transfer with a clear filesystem-specific error. Preserve the existing no-overwrite guarantee. Include an unsupported-hard-link filesystem simulation in validation and disclose any deliberate filesystem support limitation.

## Validation boundaries

The existing tests provide useful exact-byte coverage for ordinary range, ignored-range, retry, queue, and orderly restart flows. They do not cover Last-Modified collisions, crash snapshots around publication, or unsupported destination hard links. No finding above relies on missing advanced IDM features. This is the independent code/security lane; a separate architect lane was not launched because this review was explicitly assigned without subagents, so this report is not a two-lane merge approval.

## Follow-up verification: all three findings resolved

2026-10-23, scoped read-only reinspection of the changed engine/storage code, new regression tests, and `docs/core-report.md`. No suites were rerun. This verdict supersedes the initial request-changes recommendation above for these three findings.

- **P1 representation mixing: resolved.** Both old and new validators must now be strong ETags before offset continuation; range transfer is likewise enabled only by an ETag. Last-Modified-only tasks reset their segments and partial file and transfer one fresh stream. The new same-timestamp, equal-size A-to-B fixture asserts the complete output equals B and ranges remain disabled.
- **P2 publication crash recovery: resolved.** The SHA-256 is persisted before publication. Init, resume, and the run entry now reconcile an existing final file offline using a strictly formatted digest, regular-file check, exact committed size, known-total completion, and actual full-file hash. The regressions cover restored downloading/paused checkpoints, recovery after init, offline sources, mismatched/malformed digests, wrong sizes, and non-files. Unrelated final bytes are retained.
- **P2 unsupported destination filesystem: resolved by explicit support restriction.** A tiny exclusive hard-link preflight now runs before network probing, cleans its temporary entries, and returns `UNSUPPORTED_DESTINATION_FILESYSTEM` for unsupported operations. The injected EOPNOTSUPP fixture asserts zero HTTP requests and no leftover probes. `docs/core-report.md` states FAT/exFAT are unsupported; this is now a deliberate early failure instead of a full-transfer publication surprise.

No remaining P1/P2 blocker was identified within this follow-up scope. The implementation lane reports 29 passing core tests with 99.36% line coverage, 90.00% branches, and 100% functions; these results were inspected as reported evidence rather than independently rerun. Optional cleanup improvement: after verified crash recovery, an obsolete internal `.part` file can remain if the original crash occurred before partial deletion; removing that retained copy after successful verification would reclaim space. This does not prevent correct recovery or change the resolved verdict.
