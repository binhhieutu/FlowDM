# Task 6 review — 0.10.0

Baseline 3c294f7. One independent bounded code/security review scanned 23 changed files. All four findings were reproduced and fixed in one pass; covering regressions and the green whole suite validate the fixes.

| Finding | Change | Evidence |
|---|---|---|
| High: a public request queued behind final power validation could dispatch shutdown first | Cancel synchronously at public mutation entry; fence the controller and pending receipt continuations with epochs | Ten mutation paths RED→GREEN with blocked final validation; fake adapter receives zero calls |
| High: a completed queue's action was consumed while another queue remained active | Persist a receipt and retain its intent in RAM; arm the first eligible completed queue once the app is idle | A completes while B is active, then B completes: one fake countdown |
| High: a transient receipt write lost the action permanently | Retain failed receipt IDs in RAM and retry during reconciliation; do not restore them on restart | Write failure RED→GREEN; retry persists before one arm; cancellation during receipt writes suppresses later work |
| Medium: closing or interrupting scheduled running work converted it to a manual pause | Preserve scheduler provenance on graceful close and when restoring a downloading journal entry | Close inside/outside the window and interrupted-journal RED→GREEN; same ID and exact output bytes |

Final focused coordinator/manager integration: **43/43**. Final whole suite: **354/354**; coverage **95.77% lines, 86.64% branches, 91.31% functions**. Audit: zero vulnerabilities, no added dependencies. Adapter command tests inject execFile and Electron tests replace only the OS adapter; no actual shutdown or sleep was executed.

## Decisions and costs

- Recurring windows activate pending work, never copy completed downloads; manual pauses stay manual. Cost: downloading the same file again requires a new task.
- Schema 7 atomically stores task membership/order and queues. Validate ownership before exact-byte legacy backup/migration. Cost: old binaries cannot open the upgraded state; restore a separate state backup for rollback.
- Queue caps reserve fixed per-slot bandwidth across all engines. Empty slots do not lend bandwidth. Cost: small cohorts can run below the configured cap; buffering can produce instantaneous bursts. Global and per-host task caps remain three.
- Changing queue allocation or schedule requires no active worker in that queue. Cost: pause the queue before editing those settings.
- Only nonempty all-success queues qualify. Destructive actions wait for app-wide idleness; the first eligible completed queue wins one idle episode. Cost: failed/paused tasks block the action and later conflicting queue actions are suppressed.
- Pending receipts/intents live only in RAM, and new work/config cancels them. Durable completion keys prevent replay on restart. Cost: an old completion will not re-arm automatically after cancellation or restart.
- Use a monotonic countdown of at least 60 seconds, a cancel button, and fresh durable validation before OS dispatch. Cost: OS permissions can still reject execution; only fake OS execution has been tested.
- Reuse the existing dedicated feature checkout and scope this release to Task 6. Native Linux/macOS verification remains Task 9; no push or publication.

No deferred code-review findings. The limits above are deliberate behavior and are also documented in the user guide.
