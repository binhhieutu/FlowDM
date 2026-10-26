# Task 7 review — 0.11.0

Baseline 1314956. One independent review scanned 31 changed files, ran focused tests and reproduced two Important/Medium findings. Both were fixed with natural RED→GREEN regressions, followed by the green whole suite and final packaged checks. No additional minor findings.

| Finding | Fix | Evidence |
|---|---|---|
| Dynamic HTML pages such as next.php were not visited | Add explicit PHP/ASP/ASPX/JSP/CGI/CFM navigation suffixes, keep HTML Content-Type guard | Real local HTTP RED before fix; seven dynamic routes followed at depth 1, ZIP/unknown suffix never fetched; focused core20/20 |
| A stale directory picker or queue refresh modified a newly staged batch | Bind results and errors to live view epoch plus picker/queue request tokens; preserve current queue selection | Real Electron natural RED for picker success/error and stale queue response, then all seven Task 7 cases GREEN |

Earlier implementation tests also found and fixed a real ten-second silent-stream deadline hang, Unicode canonical-size expansion, ambiguous HTML entities, charset corruption, active-crawl/new-preview races and stale preview/start responses. The existing desktop coverage test exposed a duplicate folder label; the new batch label was changed to Đích lưu danh sách, preserving old test behavior.

Final full gate389/389, coverage93.51/86.49/87.52, audit0. Final Windows batch7cases, browsers3suites, queues2cases, media5cases and portable HTTP/tools passed. Five Internet YouTube/playlist opt-in cases were skipped explicitly; older evidence remains version-specific. OS power is always fake in tests.

## Decisions and costs

- Reuse the dedicated feature checkout; implement Task7 only. Local commit, no push/publication. Cost: integration with another branch is not included.
- Preview defaults unchecked. Only selected URLs become jobs; preserve query and strip fragment, deduplicate inside an import. Existing-history duplicate rules remain Task8f. Cost: repeated imports can create another task for a URL already in history.
- Crawler is same-origin, sequential (one active request), depth0–2, request budget1–100 including redirects, at most1000 links and512KiB canonical URLs. HTML2MiB/page,10s/page,60s/crawl, UTF-8 only. No browser headers/cookies, JS, subresources or binary file bodies. Cost: limited sites and slower discovery than two concurrent requests.
- Follow extensionless, HTML/XHTML and explicit PHP/version/ASP/ASPX/JSP/CGI/CFM routes. Unknown/binary suffixes remain selectable links without crawling their bodies. Cost: unusual dynamic routes may hide deeper links.
- HTML extraction is a bounded lexical subset, not a full browser parser; unknown entities, non-UTF8 HTML and conservative password-form detection can reject otherwise usable pages. Rendered-page links can instead be collected explicitly through the browser extension.
- Native previewBatch stages only the latest RAM preview, never jobs. No preview/crawl replay after restart. Native per-URL limit remains16384 characters, payload512KiB; desktop parser accepts32768-character URLs within total bounds. Cost: exceptionally long browser links need a desktop import and previews must be recreated after restart.
- Cancel discovery keeps existing jobs and current preview; submitting reports per-item errors and preserves successful jobs. Cost: partial success is possible and is shown explicitly.

## Automatic approval rejection

The automatic review rejected a test command that would temporarily remove UI epoch guards to demonstrate additional RED, with only reason blocked by policy. It was not applied or retried. Delayed preview/start tests were run against intact guards (GREEN validation only); separate missing-control, live-crawl staging, picker/queue and core regressions have natural RED→GREEN evidence. No requested feature was left incomplete by this rejection.
