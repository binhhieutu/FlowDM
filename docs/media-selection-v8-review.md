# Media selection v8 bounded review

Reviewed the Task 4 media-selection and live connection-count delta against baseline f524dc0. Scope: catalog and playlist DTO/token validation, exact format selection and refresh identity, schema 6 persistence and rollback, native resume eligibility, HLS worker limits, inspection lifecycle, IPC and renderer inputs, subtitle handling and output publication. This is not an audit of unchanged legacy code.

## Findings closed

- **P2: yt-dlp selector aliases and actual representation substitution.** An offline pinned-tool reproduction showed an existing 144p format ID named b selecting the different 2160p representation through --format b. Catalog validation now rejects selector aliases, and selectedMetadata compares the actual selected track IDs and count with the requested IDs before identity pinning, checkpoint creation and transfer. The regression retains the requested ID in formats while returning a different actual ID; it verifies no transfer marker and no checkpoint.json.
- **P2: subtitle work bypassed the transfer deadline.** A local delayed-caption reproduction completed and published an MKV after 2267 ms despite timeoutMs=1000. The operation wrapper now supplies one deadline signal through metadata, transfer, subtitle fetch/remux, validation and copy, retains checkpoints, preserves user AbortError and refuses publication after expiry. The delayed-body and explicit-abort regressions cover no output and retained media.
- **P2: caption format confusion.** The adapter review reproduced a caption body interpreted by FFmpeg as a concat input, reading local fixture media. Captions now require their text signature/timestamp, use an explicit webvtt or srt demuxer and map only the subtitle stream. The malicious concat-caption regression is green.

## Verification

The reviewer independently ran node --test tests/media/external-deadline.test.cjs tests/media/external-subtitle-security.test.cjs tests/media/selected-identity.test.cjs after the fixes: **4 passed, 0 failed, 0 skipped**. The reviewer inspected the alias guard and actual-ID check, operation deadline cleanup and signal propagation, and forced-caption demuxer/stream mapping.

No open P1/P2 findings remain in this bounded review. Source GUI and public-source download successes were reported by the implementation agents; this reviewer did not independently rerun them. The final full verification gate and release artifact were pending at review closure.
