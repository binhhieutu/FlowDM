# FlowDM — Implementation Plan & Checklist sau 0.5.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ngày:** 2026-10-25. **Trạng thái:** kế hoạch; chưa triển khai các mục chưa đánh dấu.

**Tiến độ 2026-10-26:** Task 1–2 hoàn tất ở 0.6.0, Task 3 hoàn tất ở 0.7.0. Task 4 và đổi N khi tải media hoàn tất ở 0.8.0, Task 5 hoàn tất ở 0.9.0, Task 6 hoàn tất ở 0.10.0, Task 7 hoàn tất ở 0.11.0. Task 8a/8b/8d/8f/8g hoàn tất ở0.12;8c còn YouTubeproxyfullfile bịHTTP401,8eFAT/exFATchưa hỗ trợ. Task 9 đã đạt Linux x64/WSL2 trong 0.13, macOS chưa có host/chưa kiểm thử; Task 10 chưa triển khai. Xem [VERIFICATION_V12](../../VERIFICATION_V12.md). Xem [VERIFICATION_V11.md](../../VERIFICATION_V11.md) và [review Task7](../../batch-v11-review.md). Xem [VERIFICATION_V10.md](../../VERIFICATION_V10.md) và [review Task 6](../../queues-v10-review.md). Xem [VERIFICATION_V9.md](../../VERIFICATION_V9.md) và [review Task5](../../browser-rebind-v9-review.md). Xem [VERIFICATION_V8.md](../../VERIFICATION_V8.md) và [review 0.8](../../media-selection-v8-review.md). Xem [VERIFICATION_V7.md](../../VERIFICATION_V7.md) và [review Task 3](../../dynamic-ranges-v7-review.md). Xem [VERIFICATION_V6.md](../../VERIFICATION_V6.md) và [review](../../source-refresh-v6-review.md). External HTTP fallback thiếu validator vẫn bị từ chối; legacy DASH thiếu base hash được giữ nguyên nhưng không resume an toàn.

**Goal:** Hoàn thiện những khả năng tải xuống còn thiếu theo hướng sử dụng tương tự IDM, giữ được dữ liệu tải dở và kiểm chứng thực tế trên Windows/Linux/macOS.

**Architecture:** Giữ Electron/CommonJS và các adapter HTTP, HLS, DASH/YouTube hiện có. Tách identity, kế hoạch byte range, lựa chọn media và scheduler thành module nhỏ; manager điều phối trạng thái và persistence. Mỗi giai đoạn có thể phát hành độc lập sau khi qua cổng kiểm thử.

**Tech Stack:** Node.js >=22, Electron, Chromium/Firefox WebExtensions, yt-dlp, FFmpeg, aria2, node:test và Playwright; phiên bản thực tế theo package/tool manifest tại lúc triển khai.

**Spec/baseline:** [VERIFICATION_V5.md](../../VERIFICATION_V5.md), [MEDIA_TOOLS.md](../../MEDIA_TOOLS.md), [BROWSER.md](../../BROWSER.md) và danh sách khoảng trống bên dưới. Đây là roadmap nội bộ, không phải tuyên bố đã ngang tính năng IDM.

## Global Constraints

- Giữ journal schema v4 đọc được; mọi nâng schema sau này cần migration có test và backup trước ghi. Không mở state mới bằng binary cũ.
- Không âm thầm xóa bytes hoặc tải lại toàn bộ khi nguồn thay đổi, validator thiếu hay checkpoint lỗi. UI phải cho người dùng lựa chọn bắt đầu tác vụ mới khi không thể tiếp tục an toàn.
- Credentials chỉ ở RAM theo mặc định; không ghi Cookie, Authorization, signed CDN URL vào checkpoint/log/evidence. Lưu credentials nếu có là phạm vi riêng dùng kho bí mật của OS.
- Không vượt DRM, kiểm soát truy cập hoặc bot challenge. Test video công khai được phép tải và fixture do dự án kiểm soát.
- Không thay profile trình duyệt hằng ngày/IDM; test state, native registration và output riêng, khôi phục sau test.
- TDD: RED → GREEN → refactor; coverage tổng lines/branches/functions >=80%; review code và security trước phát hành. Không yêu cầu coverage tăng bằng test chỉ lặp lại implementation.
- Không push/publish, ký bằng tài khoản, thay cấu hình bên thứ ba hoặc dùng dịch vụ trả phí nếu chưa được cho phép.
- Không cam kết tăng tốc N lần. Đo throughput/latency và số kết nối thật trên cùng nguồn có kiểm soát.

## Review Focus

1. URL mới trỏ sang nội dung khác dù cùng tên/kích thước: từ chối ghép, giữ checkpoint (Task 1–2).
2. Pause/cancel/đóng app đúng lúc ghi journal hoặc chia range: không ghi chồng, không mất vùng đã commit (Task 2–3).
3. Video đổi format, audio track hoặc manifest trong lúc URL hết hạn: không trộn fragment khác identity (Task 1, 4).
4. Redirect đổi origin hoặc browser reconnect: không chuyển credentials ngoài origin đã đồng ý (Task 5).
5. Thiếu đĩa, filesystem không hỗ trợ hardlink, đường dẫn Unicode và clock/DST thay đổi: báo lỗi rõ, bảo toàn state, không chạy schedule hai lần (Task 6, 8–9).

## Baseline đã có — không triển khai lại

- [x] HTTP/HTTPS nhiều kết nối, lựa chọn tối đa 16 kết nối/tác vụ, giới hạn tốc độ.
- [x] Có `startAt` cho lịch bắt đầu một lần; Task 6 bổ sung queue tùy chỉnh và lịch lặp, không viết lại khả năng hiện có.
- [x] HLS/DASH/YouTube công khai tải song song, ghép và kiểm tra media.
- [x] Media checkpoint giữ fragment hoàn tất qua pause → đóng → mở lại app.
- [x] Extension Chromium tự bắt HTTP và cung cấp thao tác tải media.
- [x] Windows portable đã chạy thực tế theo bằng chứng 0.5.0.
- [x] Linux build/archive đã kiểm tra; mục này không có nghĩa đã chạy native. macOS chưa build/chạy.

## Thứ tự triển khai

| Giai đoạn | Task | Phụ thuộc | Kết quả sử dụng được |
|---|---|---|---|
| A — tiếp tục tải tin cậy | 1, 2 | Baseline | Thay link hết hạn, resume HTTP media khi có bằng chứng identity |
| B — hiệu năng & lựa chọn video | 3, 4 | 2; 4 dùng 1 | Chia range động; chọn chất lượng/audio/phụ đề/playlist |
| C — trình duyệt & điều phối | 5, 6 | 1; 6 dùng 4 cho playlist | Gắn lại phiên trình duyệt, Firefox, queues và lịch |
| D — tiện ích còn thiếu | 7, 8 | 6 cho batch | Import/crawl có giới hạn, phân loại và xử lý sau tải |
| E — đa nền tảng & phát hành | 9, 10 | Các task được chọn cho bản phát hành | Bản có bằng chứng chạy native và bộ cài kiểm tra được |

Các task tùy chọn 7–8 không chặn bản phát hành A/B. Không mở tất cả các lane cùng lúc; chốt và review interface phụ thuộc trước.

## Task 1 — Làm mới link hết hạn cho tác vụ hiện có

**Files:** tạo `src/core/source-refresh.cjs`, `tests/core/source-refresh.test.cjs`; sửa `src/core/download-manager.cjs`, `src/media/external-metadata.cjs`, `src/media/hls-checkpoint.cjs`, `src/main.cjs`, `src/preload.cjs`, `src/ui/app.js`, `src/ui/index.html`; tạo `tests/e2e/source-refresh.test.cjs`.

**Interface mới:** `validateReplacement({ taskIdentity, candidateIdentity }) -> { compatible, reason }` là hàm thuần; `manager.refreshSource(id, { url, headers }) -> Promise<TaskSnapshot>`. Chỉ cho cập nhật tác vụ đã dừng, sau khi worker/child thoát; chạy preflight trước mutation. YouTube giữ canonical source và trích xuất URL mới trong RAM. HLS chỉ chấp nhận URL đổi khi xác minh được cùng tài nguyên; không tự bỏ query rồi coi là cùng nội dung.

- [x] RED: test link cũ trả 403/410, link mới cùng identity; task ID/output/checkpoint giữ nguyên. Cùng size nhưng khác ETag/manifest/format phải từ chối, bytes cũ giữ nguyên.
- [x] Chạy `node --test tests/core/source-refresh.test.cjs`; xác nhận FAIL do interface chưa có.
- [x] Implement preflight/identity và cập nhật source nguyên tử; thêm nút “Cập nhật liên kết”, lỗi hướng dẫn cụ thể. Không tự retry vô hạn khi xác thực thất bại.
- [x] GREEN: chạy test trên; `node --test tests/e2e/source-refresh.test.cjs` chứng minh pause → link hết hạn → thay link → relaunch → resume; resource đã commit không GET lại, file cuối đúng SHA và decode toàn file.
- [x] Review rồi commit `feat: refresh expired sources without losing checkpoints`.

## Task 2 — Resume byte cho HTTP media có validator

**Files:** tạo `src/core/http-resume.cjs`, `tests/core/http-resume.test.cjs`; sửa `src/core/http-client.cjs`, `src/core/download-manager.cjs`, `src/media/external.cjs`, `src/media/external-checkpoint.cjs`; mở rộng `tests/e2e/media-resume.test.cjs`.

**Interface mới:** `assessHttpResume({ saved, probed }) -> { allowed, reason }`; saved/probed gồm strong ETag, total bytes, range support và representation encoding. Không coi Last-Modified hay trùng filename/size là đủ bằng chứng. Áp dụng cho direct HTTP trước; external fallback chỉ dùng khi có validator và range contract được ghi/kiểm tra, chưa đủ thì giữ guard từ chối hiện tại.

- [x] RED: validator trùng tiếp tục đúng offset; ETag đổi/yếu/thiếu, sai Content-Range, server trả 200/416 cho Range, truncate, redirect và encoding đổi đều giữ bytes và từ chối nối sai.
- [x] Chạy `node --test tests/core/http-resume.test.cjs`; xác nhận FAIL.
- [x] Implement manifest byte-range và guard chung; không bật aria2 continuation chỉ vì có `.part`.
- [x] GREEN: test trên và E2E HTTP video có request log; pause giữa file → mở lại → request chỉ phần thiếu, SHA khớp tải liên tục, FFmpeg full decode đạt. Thiếu validator hiển thị không thể resume an toàn.
- [x] Review rồi commit `feat: validate HTTP media byte continuation`.

## Task 3 — Chia lại range động và đổi số kết nối

**Files thực tế:** tạo `src/core/range-scheduler.cjs`, `src/core/http-range-pool.cjs` và core tests; sửa manager/storage/main/preload/UI. Thêm `tests/e2e/dynamic-concurrency.test.cjs`; giữ `tests/e2e/concurrency.test.cjs` làm hồi quy HLS/DASH. Schema 5 có backup nguyên byte trước migration, đọc v1–v5.

**Interface mới:** `splitPendingRange(range, minBytes) -> { retained, pending } | null`. Range là inclusive `[start,end]`, offset committed được lưu riêng. Chỉ split vùng chưa commit sau khi khóa/settle worker sở hữu; checkpoint lưu ownership mới nguyên tử. Native yt-dlp không áp dụng thuật toán HTTP này; HLS/DASH tiếp tục dùng fragment workers.

**Interface đã giao:** `manager.setConnections(id, connections) -> Promise<TaskSnapshot>`, N nguyên 1–16 cho direct HTTP; UI chọn 1/2/4/8/16. `activeConnections` phản ánh worker thực tế, không phải số vùng đã lưu. Tối thiểu mỗi nửa mới 256 KiB, tối đa 1.024 vùng; dừng nhóm writer trước chia/đổi ownership.

- [x] RED: test range rất nhỏ/lớn, worker nhanh/chậm, retry, pause khi split, đổi N từ 1→4→1; hợp vùng luôn đúng `[0,total-1]`, không overlap/gap và active <=N<=16.
- [x] Chạy `node --test tests/core/range-scheduler.test.cjs`; xác nhận FAIL.
- [x] Implement work stealing cho phần còn lại; đổi N chỉ tăng/giảm worker ở điểm an toàn; giữ aggregate rate cap và per-host cap.
- [x] GREEN: test trên và `node --test tests/e2e/dynamic-concurrency.test.cjs tests/e2e/concurrency.test.cjs`; fixture có một range chậm, so sánh fixed/dynamic cùng điều kiện server/payload, log số kết nối, byte và SHA. Bản Windows cuối đạt 1→4→1/relaunch, không replay byte commit; tải W3C HTTP thật khớp bản tải liên tục và full decode. Không dùng mạng YouTube biến động làm benchmark chính.
- [x] Review rồi commit `feat: redistribute unfinished HTTP ranges`.

## Task 4 — Chọn video/audio, phụ đề và playlist

**Files:** tạo `src/media/catalog.cjs`, `tests/media/catalog.test.cjs`, `tests/e2e/media-selection.test.cjs`; sửa `src/media/external.cjs`, `src/media/external-metadata.cjs`, `src/core/policy.cjs`, `src/core/download-manager.cjs`, `src/main.cjs`, `src/preload.cjs`, UI.

**Interface mới:** `inspectMedia({ url, signal }) -> Promise<{ sourceId, formats, subtitles, entries }>`; format DTO chứa ID/codec/container/resolution/estimate, không trả raw CDN URL. `selection={videoFormatId,audioFormatId,subtitleIds,mode}` được validate và pin vào identity trước khi tạo job; `mode` chỉ `video` hoặc `audio`.

- [x] RED: test H264/VP9/AV1, 720p/1080p/4K, audio-only, thiếu audio, format biến mất, phụ đề thủ công/tự động và playlist trùng entry. Không đổi format âm thầm khi resume.
- [x] Chạy `node --test tests/media/catalog.test.cjs`; xác nhận FAIL.
- [x] Implement inspect/select và mux container tương thích; UI hiển thị codec/container/dung lượng ước lượng. Playlist hiện danh sách chọn trước khi tạo batch, giới hạn 100 mục/lần; một entry lỗi không hủy các job khác.
- [x] GREEN: test trên và `node --test tests/e2e/media-selection.test.cjs`; tải thật nguồn công khai cho video+audio, audio-only và phụ đề; dùng FFmpeg kiểm tra track/duration/full decode. Fixture kiểm chứng 4K nếu nguồn thật không có 4K; ghi rõ khác biệt.
- [x] Review code/security: đóng 3 P2 về selector alias/actual format ID, deadline phụ đề và nhầm demuxer phụ đề; không còn P1/P2 trong phạm vi. Reviewer chạy độc lập 4/4 hồi quy.
- [x] Review và commit `feat: select media formats and resize native media connections` sau coverage/build/kiểm thử artifact cuối.

**Bằng chứng nguồn:** GUI chọn DASH H.264 3840×2160 do dự án tạo + audio-only; YouTube Big Buck Bunny 1080p + audio-only; Sintel manual English vào MKV, FFmpeg decode toàn file. Playlist công khai preview17 mục, từ chối ID ngoài catalog; bản packaged submit đúng1jobN2, pause/relaunch giữ job rồi cancel/cleanup. Chưa tải toàn bộ batch công khai. Container MP4/WebM/MKV theo codec, phụ đề vào MKV; tối đa 8 track phụ đề và 100 mục playlist. Schema 6 backup trước migration, đọc v1–v6.

### Milestone bổ sung — đổi số kết nối media khi đang tải

- [x] HLS đổi worker trực tiếp; giảm N chờ số request đang chạy xuống mức mới, giữ cap và thứ tự ghép.
- [x] DASH/YouTube native fragment đủ điều kiện: pause → chờ child kết thúc/checkpoint → lưu N → resume cùng task/selection; HTTP fallback hoặc pha không an toàn từ chối đổi khi đang chạy.
- [x] GUI nguồn HLS/DASH 1→4→1 → pause/đóng/mở/resume: peak request 4, phần đã commit không GET lại, SHA khớp baseline và full decode.
- [x] YouTube công khai native nguồn 1→4→1 → pause/đóng/mở/resume: giữ 6 resource/621904 byte, full decode 888.094 giây. Không có CDN request counts nên không suy thành bằng chứng không GET lại trên CDN.
- [x] Final coverage 241/241 unit/integration + desktop 1/1 + local media-selection 1/1: lines 96.75%, branches 86.16%, functions 94.78%; audit 0. Hai nhánh public optional skip trong lượt coverage.
- [ ] Build, ASAR/tool hash và đúng Windows artifact 0.8 cuối; packaged media-selection/live-N chưa xác nhận ở checkpoint tài liệu này.

## Task 5 — Gắn lại phiên trình duyệt và Firefox

**Files thực tế:** thêm `src/browser/credential-rebind.cjs`, `src/core/header-rebind.cjs`, `src/browser/firefox-manifest.cjs`; sửa manager/source-refresh/probe, native protocol/server/host/install, registration/setup, main/preload/desktop UI và extension capture/background/popup/content. Thêm các test credential core/challenge/extension/bridge, Firefox setup, E2E Chromium và Firefox cùng fixture/driver riêng.

**Interface:** desktop `requestCredentials(id)` tạo challenge RAM `{taskId,origin,requestId,url,filename,expiresAt}`; native `credentialRequests` tìm theo origin, `rebindCredentials` chuẩn bị headers/identity, `commitCredentials` gắn vào RAM, `cancelCredentials` bỏ staging. Frame request_id riêng cho mỗi operation. `manager.rebindHeaders(id,headers)` và prepare/commit nội bộ giữ cùng tác vụ đã dừng. Không tự resume.

- [x] RED: thiếu API/service/operation; test mất headers khi relaunch, nonce cũ/hết hạn/nhầm task/origin, consent/permission/navigation đổi, ACK sai/replay, native timeout/disconnect, HTML/identity/redirect đổi và rollback journal. Không ghi headers/nonce vào journal/browser storage.
- [x] Chạy `node --test tests/browser/credential-rebind.test.cjs` xác nhận RED trước implement; core6/6 GREEN, challenge5/5, bridge4/4; 72/72 extension regressions đạt.
- [x] Implement **Kết nối lại từ trình duyệt** cho HTTP/HLS: explicit desktop nonce, hai bước preflight/commit, TTL2phút/max8, giữ checkpoint/ID/N; authenticated DASH/YouTube giữ trạng thái rõ `blocked-by-adapter`.
- [x] Firefox export MV2/thư mục/native manifest/GeckoID riêng; Windows Mozilla HKCU view32 backup/restore đúng, view64 giữ nguyên. Namespace Promise và optional origins được kiểm tra trên Firefox thật.
- [x] GREEN nguồn và Windows packaged0.9: Chromium156/Firefox149.0.2 thật, profile riêng; capture → pause → đóng/mở app → đổi cookie → popup rebind → manual resume. HTTP2MiB/HLS3TS đúng bytes/SHA/full decode, không replay phần commit; no-consent/host-down fallback đạt và native registrations khôi phục đúng.
- [x] Review độc lập không có P1/P2 có thể tái hiện: 34/34 ban đầu, delta Firefox mới17/17+Chromium23/23. Final full286/286, coverage96.15% lines/86.30% branches/93.48% functions, audit0. Windows portable/Linuxdir build, 50file ASAR/tool integrity, portable smoke và hồi quy browser/media/refresh đạt.
- [x] Commit `feat: rebind browser sessions and support Firefox capture`.

**Milestone đổi kết nối:** đã triển khai ở0.8 và giữ nguyên trong0.9; kiểm thử core HTTP có cookie sau rebind đổi1→4→1 đạt. Windows packaged HTTP/HLS/DASH1→4→1/relaunch có peak4; video HTTP Internet W3C4372373B khớp tải liên tục và full decode. Không triển khai trùng engine.

**Quyết định Firefox:** không pause lượt trình duyệt vì Firefox có thể hủy khi chưa có partial. Giữ stream đến durableACK, kiểm tra lại safe/URL/quyền rồi cancel và xác minh USER_CANCELED. Cầu nối lỗi giữ lượt gốc; có thể truyền byte đồng thời/tải trùng khi ACK muộn. Chromium giữ protocol pause trướcACK. Addon Firefox unsigned nạp tạm; signed distribution và Linux/macOS native thuộc Task9–10.

**Bằng chứng:** [VERIFICATION_V9.md](../../VERIFICATION_V9.md), [evidence/v0.9](../../evidence/v0.9). CookieAPI được pregrant trong fixture tự động hóa, consent theo origin vẫn được kiểm tra. Bốn thư mục probe tạm giữ lại do auto-review chặn cleanup (`blocked by policy`); không ảnh hưởng các gate, E2E registrations đã khôi phục.

## Task 6 — Nhiều queue, lịch lặp và hành động sau hoàn tất

**Files:** tạo `src/core/queue-scheduler.cjs`, `tests/core/queue-scheduler.test.cjs`, `tests/e2e/queues.test.cjs`; sửa `src/core/storage.cjs`, `src/core/download-manager.cjs`, main/preload/UI.

**Interface mới:** `evaluateQueues({ queues, tasks, now, timezone }) -> { runnableIds, pauseIds, nextWakeAt }` thuần. Queue cấu hình concurrency, order, speed cap, start/stop window, weekday và timezone IANA; injected clock để test. Mặc định một queue tương đương hành vi cũ.

- [x] RED: test migration, đổi thứ tự, cap queue/per-host, app ngủ quá giờ chạy, DST và clock lùi; missed schedule chỉ chạy một lần khi trở lại trong cửa sổ hợp lệ, không replay mọi lần đã lỡ.
- [x] Chạy `node --test tests/core/queue-scheduler.test.cjs`; xác nhận FAIL.
- [x] Implement CRUD queue và UI lịch; tới stop time pause an toàn. Shutdown/sleep chỉ opt-in theo queue, có đếm ngược 60 giây và nút hủy; không shell interpolation từ input.
- [x] GREEN: unit + `node --test tests/e2e/queues.test.cjs`; app relaunch giữ queue/order, lịch không nhân đôi. Test power adapter bằng fake, chỉ thử shutdown thật khi chủ máy yêu cầu riêng.
- [x] Review rồi commit `feat: add persistent queues and recurring schedules`.

**Bằng chứng 0.10.0:** [VERIFICATION_V10](../../VERIFICATION_V10.md), [review](../../queues-v10-review.md), [summary](../../evidence/v0.10/summary.json). Full 354/354; coverage 95,77/86,64/91,31; audit 0. Windows packaged queue 2/2, media 5/5 (5 Internet opt-in skip), Chrome/Firefox/legacy mỗi 1/1; portable HTTP 2 MiB/tools; 54 tệp ASAR khớp Windows/Linux. Đếm ngược 60 giây và hủy được thử với fake OS, không tắt/ngủ thật. Linux native/macOS vẫn thuộc Task 9.

## Task 7 — Import hàng loạt, tải link trên trang, Site Grabber giới hạn

**Files:** tạo `src/core/batch-import.cjs`, `src/core/site-grabber.cjs`, `tests/core/batch-import.test.cjs`, `tests/core/site-grabber.test.cjs`, `tests/e2e/batch.test.cjs`; sửa extension popup/background và UI.

**Interfaces mới:** `parseUrlList(text) -> { urls, errors }`; `crawlLinks({ seed, maxDepth, maxPages, signal }) -> AsyncIterable<PageLinks>`. Mặc định same-origin, depth<=2, pages<=100, tối đa 1.000 URL/import, 2 crawl request đồng thời; chỉ HTTP(S), không chạy script tải về. Site Grabber không có nghĩa hỗ trợ mọi website.

- [x] RED: duplicate URL, URL sai, tên Unicode, vòng lặp crawl, redirect ra origin, link vô hạn, cancel, trang cần đăng nhập; input quá giới hạn trả lỗi rõ.
- [x] Chạy `node --test tests/core/batch-import.test.cjs tests/core/site-grabber.test.cjs`; xác nhận FAIL.
- [x] Implement preview/filter/deduplicate trước khi tạo job; chọn queue và destination. Không tự crawl/tải toàn site ngay khi mở popup; không dò endpoint hay vượt access control.
- [x] GREEN: unit + `node --test tests/e2e/batch.test.cjs`; chỉ các mục đã chọn được tạo, cancel dừng crawler và giữ job hiện có.
- [x] Review rồi commit `feat: import download batches and bounded site links`.

**Bằng chứng0.11.0:** [VERIFICATION_V11](../../VERIFICATION_V11.md), [review](../../batch-v11-review.md), [summary](../../evidence/v0.11/summary.json). Unit389/389,coverage93,51/86,49/87,52,audit0. Packagedbatch7/7,browsers3/3,queues2/2,media5/5 (5opt-in skip),portableHTTP/tools;60ASARfilesverified. CrawlerUTF8/suffixsubset/caps được công bố; không vượt trang bị chặn. Linuxnative/macOS vẫnTask9.

## Task 8 — Phân loại, proxy/protocol và filesystem

Tách thành các deliverable nhỏ để không chặn toàn roadmap:

- [x] **8a Categories:** tạo `src/core/categories.cjs`, `tests/core/categories.test.cjs`; sửa policy/UI. RED cho extension/MIME xung đột, đường dẫn traversal và trùng tên; GREEN xác nhận rule chỉ đổi destination trước tải, không di chuyển job đang chạy. Commit `feat: categorize download destinations`.
- [x] **8b Antivirus:** tạo `src/tools/post-download.cjs`, `tests/tools/post-download.test.cjs`; gọi executable cố định + argv riêng sau publication, không shell string. RED/GREEN cho file Unicode, exit lỗi, timeout; UI phân biệt tải xong/scan thất bại. Không xóa file tự động. Commit `feat: scan completed downloads with configured antivirus`.
- [ ] **8c Proxy:** tạo `src/core/proxy.cjs`, `tests/core/proxy.test.cjs`; cấu hình HTTP CONNECT/SOCKS và auth trong RAM, áp dụng nhất quán HTTP/media/browser handoff. RED/GREEN cho proxy 407, sai credential, DNS, cancel, secret redaction; không auto đọc credentials máy. NTLM/Kerberos là milestone riêng có fixture và host test phù hợp. Commit từng adapter, không khai hoàn tất cả nhóm khi chỉ HTTP đạt.
- [x] **8d FTP/FTPS:** module mới `src/core/ftp-download.cjs`, `tests/core/ftp-download.test.cjs`; chỉ chọn dependency sau rà soát upstream/license. RED/GREEN với server local cho listing, passive mode, REST resume và FTPS certificate; UI báo rõ FTP truyền không mã hóa. Không bật trước khi có kiểm thử thực tế.
- [ ] **8e FAT/exFAT:** tạo `src/core/publication.cjs`, `tests/core/publication.test.cjs`; giữ hardlink path hiện tại. Thiết kế publish trên filesystem thiếu hardlink bằng primitive no-overwrite của nền tảng; nếu không đảm bảo nguyên tử/chống ghi đè thì báo chưa hỗ trợ. RED/GREEN cho đĩa đầy, đích tồn tại/race, crash lúc publish và FAT32 file>4 GiB; không tick chỉ vì copy+rename chạy một lần.
- [x] **8f Clipboard/duplicate:** tạo `src/core/clipboard-policy.cjs`, `tests/core/clipboard-policy.test.cjs`; sửa main/UI. Theo dõi clipboard chỉ opt-in, không lưu lịch sử; chỉ đề nghị thêm URL hợp lệ, không tự tải. RED/GREEN cho clipboard có token, nội dung không phải URL, trùng canonical source+selection và khác query có ý nghĩa; không xóa query để deduplicate nhầm.
- [x] **8g Crash recovery:** tạo `tests/core/crash-recovery.test.cjs`, `tests/e2e/crash-recovery.test.cjs`; sửa storage/checkpoint nơi test xác định cần thiết. Fault injection sau data sync/trước rename/sau journal replace, ENOSPC và EACCES; kill chỉ child/app của test. Relaunch giữ phần commit bền vững, checkpoint mâu thuẫn phải từ chối an toàn. Phân biệt kiểm thử process crash với mất điện thật; không tuyên bố chịu mọi power loss.


**Kết quả0.12:** [VERIFICATION_V12](../../VERIFICATION_V12.md), [review](../../task8-v12-review.md), [summary](../../evidence/v0.12/summary.json). Full461/461, coverage93.22/85.92/87.24, audit0. FinalpackagedGUI2, crash2, browser3, batch7, queue2, media5PASS(5opt-in skip), portable/integrity68+16files.

- [x] 8c HTTP CONNECT/Basic và SOCKS5 USER/PASS/remoteDNS; HTTP/HLS/DASH/browser đi cùng gateway, không leak upstreamauth, không directfallback, restartguard đã test.
- [ ] 8c YouTube qua proxy fullfile/SHA/decode: **BLOCKED externalHTTP401**, đã truyền partial nhưng không tínhPASS; không vượt kiểm soát truy cập. NTLM/Kerberos là milestone riêng chưa triển khai.
- [ ] 8e nativeFAT/exFAT/no-overwriteatomicfallback: **UNSUPPORTED/UNVERIFIED**, mọi volume hiện cóNTFS; guard/probe/faulttests không thay bằng chứng targetnative. Không format/mount volume người dùng.

## Task 9 — Kiểm thử native Linux/macOS

**Files:** tạo `tests/e2e/platform-smoke.test.cjs`, `docs/PLATFORM_VERIFICATION.md`; sửa `src/tools/media-tools.cjs`, `src/browser/registration.cjs`, `scripts/verify-package.cjs`, package build config nếu kết quả host test yêu cầu.

- [x] RED/GREEN: unit cho tool lookup/permissions, paths có space/Unicode và matrix registration Linux/macOS. Quyền execute/launcher đã chạy thật trên Linux WSL2; macOS native còn ở mục chưa kiểm thử bên dưới.
- [x] Chạy Linux native (Ubuntu x64 trên WSL2/WSLg): mở GUI → HTTP/HLS/DASH → pause/đóng/mở/resume → SHA/decode; browser capture, native registration và cleanup bằng profile riêng. Kiểm tra sandbox không bị vô hiệu hóa để né lỗi.
- [ ] Build/chạy macOS trên host macOS: x64 và arm64 có bằng chứng riêng; cùng flow như Linux, thêm Gatekeeper và quyền executable. Máy/runner chưa có thì ghi BLOCKED kèm điều kiện, không giả lập thành PASS.
- [x] Kiểm tra thiếu yt-dlp/FFmpeg/aria2, pin/hash và hướng dẫn cài; đóng gói tools theo platform hoặc phát hiện PATH theo chính sách được công bố.
- [x] Review rồi commit `test: verify native Linux download flows on WSL2`.

**Kết quả 0.13:** [PLATFORM_VERIFICATION](../../PLATFORM_VERIFICATION.md), [review](../../task9-platform-review.md), [summary](../../evidence/v0.13/summary.json). Linux 473 pass/0 fail/2 Windows-only skip; 6 nhóm native gate đạt trên bản giải nén tar (4 GUI tests pass, 1 YouTube opt-in skip). HTTP giữ 114.688 byte qua mở lại, HLS/DASH reuse + SHA/full decode, Chromium capture và native registration restoration; sandbox bật. HTTPS Internet 502.941 byte đúng SHA. Windows 471 pass/0 fail/4 Unix-only skip, coverage 93.18/85.95/87.24, audit 0; portable HTTP/tools pass.

- [x] Linux x64 trên WSL2: build và chạy lại chính gói tar sau giải nén, 71 payload files/68 runtime + 16 dependency files khớp.
- [ ] macOS x64/arm64/Gatekeeper: **CHƯA KIỂM THỬ — không có host Mac**. Test đường dẫn/verifier giả lập không thay bằng chứng native.
- [ ] Linux desktop độc lập ngoài WSL2 và Linux ARM64: chưa kiểm thử.

## Task 10 — Cổng phát hành và cập nhật ứng dụng

**Files:** sửa `scripts/verify-package.cjs`, `scripts/hash-release.cjs`, `scripts/smoke-portable.cjs`, README và docs hiện có; tạo báo cáo `docs/VERIFICATION_VNEXT.md`. Auto-update nếu triển khai tách `src/tools/update-manifest.cjs`, `tests/tools/update-manifest.test.cjs`.

- [ ] Chọn phạm vi bản phát hành theo task đã GREEN; mọi mục hoãn còn unchecked với lý do cụ thể.
- [ ] Chạy `npm run test:coverage`, `npm audit`; test tích hợp/E2E bị tác động. Coverage >=80% lines/branches/functions và không có lỗi security nghiêm trọng chưa xử lý.
- [ ] Review độc lập toàn diff, security headers/native IPC/path/child process; sửa vấn đề rồi chạy lại đúng kiểm tra bị ảnh hưởng.
- [ ] Build Windows/Linux/macOS theo host sẵn có; đối chiếu source-ASAR/tool hash, chạy đúng artifact cuối. Đổi runtime sau build bắt buộc build và xác minh lại.
- [ ] HTTP/HLS/DASH fixture phải đúng SHA, log không yêu cầu lại vùng/resource đã commit; media decode toàn file. Video thật chứng minh chọn format, pause/relaunch/resume; thất bại mạng được báo thật, không chuyển thành fixture PASS.
- [ ] Xuất evidence có artifact hash, OS, command, kết quả, request counts, bytes reuse và giới hạn. Không lưu secrets hoặc file video vào source ZIP.
- [ ] Auto-update: trước hết kiểm tra manifest version/hash/signature bằng unit fixture, chống downgrade và package sai OS/arch; chưa có endpoint/ký tin cậy thì chỉ tạo thông báo cập nhật thủ công. Publish endpoint, ký/notarize và phát hành công khai cần quyền phù hợp; không tự tạo credentials.
- [ ] Installer/update migration: test profile cũ → bản mới, backup journal và cập nhật bị ngắt; phục hồi binary cũ chỉ với snapshot schema tương thích. Uninstall cho chọn giữ dữ liệu, không tự xóa download; chưa có installer thì ghi rõ portable-only.
- [ ] Rà soát license/corresponding source của bundled tools trước public redistribution; tạo source/extension ZIP và SHA256SUMS, kiểm tra từng file; commit release docs khi tất cả gate trong phạm vi đạt.

## Checklist nghiệm thu dùng cho MỖI task

- [ ] Có test RED đã ghi nhận, implementation GREEN và kiểm thử tích hợp tương ứng.
- [ ] Pause/cancel/relaunch, lỗi mạng/đĩa và dữ liệu đầu vào sai được kiểm tra theo phạm vi task.
- [ ] Review code/security hoàn tất; không còn lỗi nghiêm trọng chưa xử lý trong phạm vi.
- [ ] UI có trạng thái/lỗi dễ hiểu; không mất bytes, ghi đè file hoặc lộ credentials.
- [ ] Docs nêu tính năng thực sự hỗ trợ, bằng chứng và giới hạn; không tick chỉ vì code đã viết.
- [ ] Commit riêng có thể review; ghi artifact/evidence khi task ảnh hưởng bản đóng gói.

## Điểm bắt đầu thực thi

Task 1–7 đã có implementation và báo cáo nghiệm thu theo từng phiên bản. Bản hiện tại 0.12.0 hoàn tất các mục 8a, 8b, 8d, 8f, 8g. Mục 8c đã đạt HTTP CONNECT/SOCKS5 và HTTP/HLS/DASH/browser, còn tải YouTube qua proxy bị HTTP 401; mục 8e chưa hỗ trợ FAT/exFAT. Hai mục này tiếp tục để mở. Task 9 đã đạt Linux x64/WSL2 trong 0.13, macOS chưa có host/chưa kiểm thử; Task 10 chưa triển khai. Journal hiện tại schema 8, đọc schema 1–8 và backup dữ liệu cũ trước migration; xem VERIFICATION_V12 để biết giới hạn và bằng chứng của artifact cuối.
