# FlowDM — Implementation Plan & Checklist sau 0.5.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ngày:** 2026-10-25. **Trạng thái:** kế hoạch; chưa triển khai các mục chưa đánh dấu.

**Tiến độ 2026-10-26:** Task 1–2 hoàn tất ở 0.6.0, Task 3 hoàn tất ở 0.7.0. Task 4 và đổi N khi tải media đã qua kiểm thử nguồn và review trong phạm vi 0.8; final coverage/audit đã đạt; build/artifact cuối đang chờ. Task 5–10 chưa triển khai. Xem [VERIFICATION_V8.md](../../VERIFICATION_V8.md) và [review 0.8](../../media-selection-v8-review.md). Xem [VERIFICATION_V7.md](../../VERIFICATION_V7.md) và [review Task 3](../../dynamic-ranges-v7-review.md). Xem [VERIFICATION_V6.md](../../VERIFICATION_V6.md) và [review](../../source-refresh-v6-review.md). External HTTP fallback thiếu validator vẫn bị từ chối; legacy DASH thiếu base hash được giữ nguyên nhưng không resume an toàn.

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

**Files:** sửa `src/bridge/protocol.cjs`, `src/browser/admission.cjs`, `src/browser/registration.cjs`, `src/browser/setup.cjs`, `src/core/download-manager.cjs`, `extension/background.js`, `extension/popup.js`, `extension/manifest.json`; tạo `tests/browser/credential-rebind.test.cjs`, `tests/e2e/firefox.test.cjs`; mở rộng `tests/e2e/browser.test.cjs`.

**Interface mới:** native message `rebindCredentials` có `{ taskId, origin, requestId }`, header envelope giữ RAM-only và reuse consent policy hiện có. Desktop xác minh sender/origin và job binding trước `manager.rebindHeaders(id, headers)`. Firefox dùng manifest/registration riêng phù hợp Firefox, không cài đè bản Chromium.

- [ ] RED: test relaunch mất headers, consent bị thu hồi, origin sai, redirect khác origin, replay ACK và host vắng; journal/log không chứa secret.
- [ ] Chạy `node --test tests/browser/credential-rebind.test.cjs`; xác nhận FAIL.
- [ ] Implement “Kết nối lại từ trình duyệt” cho HTTP/HLS; người dùng mở trang hợp lệ và đồng ý cấp headers. DASH/YouTube authenticated là lane riêng: chỉ bật khi adapter hỗ trợ truyền bí mật an toàn và có review; chưa đạt thì giữ từ chối, ghi trạng thái blocked-by-adapter, không khai đã hỗ trợ.
- [ ] GREEN: Chromium và Firefox thật với profile riêng: capture → pause → đóng/mở app → rebind → resume; test fallback khi host down và xác minh khôi phục native registration.
- [ ] Review security/code rồi commit `feat: rebind browser sessions and support Firefox capture`.

## Task 6 — Nhiều queue, lịch lặp và hành động sau hoàn tất

**Files:** tạo `src/core/queue-scheduler.cjs`, `tests/core/queue-scheduler.test.cjs`, `tests/e2e/queues.test.cjs`; sửa `src/core/storage.cjs`, `src/core/download-manager.cjs`, main/preload/UI.

**Interface mới:** `evaluateQueues({ queues, tasks, now, timezone }) -> { runnableIds, pauseIds, nextWakeAt }` thuần. Queue cấu hình concurrency, order, speed cap, start/stop window, weekday và timezone IANA; injected clock để test. Mặc định một queue tương đương hành vi cũ.

- [ ] RED: test migration, đổi thứ tự, cap queue/per-host, app ngủ quá giờ chạy, DST và clock lùi; missed schedule chỉ chạy một lần khi trở lại trong cửa sổ hợp lệ, không replay mọi lần đã lỡ.
- [ ] Chạy `node --test tests/core/queue-scheduler.test.cjs`; xác nhận FAIL.
- [ ] Implement CRUD queue và UI lịch; tới stop time pause an toàn. Shutdown/sleep chỉ opt-in theo queue, có đếm ngược 60 giây và nút hủy; không shell interpolation từ input.
- [ ] GREEN: unit + `node --test tests/e2e/queues.test.cjs`; app relaunch giữ queue/order, lịch không nhân đôi. Test power adapter bằng fake, chỉ thử shutdown thật khi chủ máy yêu cầu riêng.
- [ ] Review rồi commit `feat: add persistent queues and recurring schedules`.

## Task 7 — Import hàng loạt, tải link trên trang, Site Grabber giới hạn

**Files:** tạo `src/core/batch-import.cjs`, `src/core/site-grabber.cjs`, `tests/core/batch-import.test.cjs`, `tests/core/site-grabber.test.cjs`, `tests/e2e/batch.test.cjs`; sửa extension popup/background và UI.

**Interfaces mới:** `parseUrlList(text) -> { urls, errors }`; `crawlLinks({ seed, maxDepth, maxPages, signal }) -> AsyncIterable<PageLinks>`. Mặc định same-origin, depth<=2, pages<=100, tối đa 1.000 URL/import, 2 crawl request đồng thời; chỉ HTTP(S), không chạy script tải về. Site Grabber không có nghĩa hỗ trợ mọi website.

- [ ] RED: duplicate URL, URL sai, tên Unicode, vòng lặp crawl, redirect ra origin, link vô hạn, cancel, trang cần đăng nhập; input quá giới hạn trả lỗi rõ.
- [ ] Chạy `node --test tests/core/batch-import.test.cjs tests/core/site-grabber.test.cjs`; xác nhận FAIL.
- [ ] Implement preview/filter/deduplicate trước khi tạo job; chọn queue và destination. Không tự crawl/tải toàn site ngay khi mở popup; không dò endpoint hay vượt access control.
- [ ] GREEN: unit + `node --test tests/e2e/batch.test.cjs`; chỉ các mục đã chọn được tạo, cancel dừng crawler và giữ job hiện có.
- [ ] Review rồi commit `feat: import download batches and bounded site links`.

## Task 8 — Phân loại, proxy/protocol và filesystem

Tách thành các deliverable nhỏ để không chặn toàn roadmap:

- [ ] **8a Categories:** tạo `src/core/categories.cjs`, `tests/core/categories.test.cjs`; sửa policy/UI. RED cho extension/MIME xung đột, đường dẫn traversal và trùng tên; GREEN xác nhận rule chỉ đổi destination trước tải, không di chuyển job đang chạy. Commit `feat: categorize download destinations`.
- [ ] **8b Antivirus:** tạo `src/tools/post-download.cjs`, `tests/tools/post-download.test.cjs`; gọi executable cố định + argv riêng sau publication, không shell string. RED/GREEN cho file Unicode, exit lỗi, timeout; UI phân biệt tải xong/scan thất bại. Không xóa file tự động. Commit `feat: scan completed downloads with configured antivirus`.
- [ ] **8c Proxy:** tạo `src/core/proxy.cjs`, `tests/core/proxy.test.cjs`; cấu hình HTTP CONNECT/SOCKS và auth trong RAM, áp dụng nhất quán HTTP/media/browser handoff. RED/GREEN cho proxy 407, sai credential, DNS, cancel, secret redaction; không auto đọc credentials máy. NTLM/Kerberos là milestone riêng có fixture và host test phù hợp. Commit từng adapter, không khai hoàn tất cả nhóm khi chỉ HTTP đạt.
- [ ] **8d FTP/FTPS:** module mới `src/core/ftp-download.cjs`, `tests/core/ftp-download.test.cjs`; chỉ chọn dependency sau rà soát upstream/license. RED/GREEN với server local cho listing, passive mode, REST resume và FTPS certificate; UI báo rõ FTP truyền không mã hóa. Không bật trước khi có kiểm thử thực tế.
- [ ] **8e FAT/exFAT:** tạo `src/core/publication.cjs`, `tests/core/publication.test.cjs`; giữ hardlink path hiện tại. Thiết kế publish trên filesystem thiếu hardlink bằng primitive no-overwrite của nền tảng; nếu không đảm bảo nguyên tử/chống ghi đè thì báo chưa hỗ trợ. RED/GREEN cho đĩa đầy, đích tồn tại/race, crash lúc publish và FAT32 file>4 GiB; không tick chỉ vì copy+rename chạy một lần.
- [ ] **8f Clipboard/duplicate:** tạo `src/core/clipboard-policy.cjs`, `tests/core/clipboard-policy.test.cjs`; sửa main/UI. Theo dõi clipboard chỉ opt-in, không lưu lịch sử; chỉ đề nghị thêm URL hợp lệ, không tự tải. RED/GREEN cho clipboard có token, nội dung không phải URL, trùng canonical source+selection và khác query có ý nghĩa; không xóa query để deduplicate nhầm.
- [ ] **8g Crash recovery:** tạo `tests/core/crash-recovery.test.cjs`, `tests/e2e/crash-recovery.test.cjs`; sửa storage/checkpoint nơi test xác định cần thiết. Fault injection sau data sync/trước rename/sau journal replace, ENOSPC và EACCES; kill chỉ child/app của test. Relaunch giữ phần commit bền vững, checkpoint mâu thuẫn phải từ chối an toàn. Phân biệt kiểm thử process crash với mất điện thật; không tuyên bố chịu mọi power loss.

## Task 9 — Kiểm thử native Linux/macOS

**Files:** tạo `tests/e2e/platform-smoke.test.cjs`, `docs/PLATFORM_VERIFICATION.md`; sửa `src/tools/media-tools.cjs`, `src/browser/registration.cjs`, `scripts/verify-package.cjs`, package build config nếu kết quả host test yêu cầu.

- [ ] RED/GREEN: unit cho tool lookup/permissions, paths có space/Unicode và registration trên từng OS; không suy kết quả Windows thành Linux/macOS.
- [ ] Chạy Linux native: mở GUI → HTTP/HLS/DASH → pause/đóng/mở/resume → SHA/decode; browser capture, native registration và cleanup bằng profile riêng. Kiểm tra sandbox không bị vô hiệu hóa để né lỗi.
- [ ] Build/chạy macOS trên host macOS: x64 và arm64 có bằng chứng riêng; cùng flow như Linux, thêm Gatekeeper và quyền executable. Máy/runner chưa có thì ghi BLOCKED kèm điều kiện, không giả lập thành PASS.
- [ ] Kiểm tra thiếu yt-dlp/FFmpeg/aria2, pin/hash và hướng dẫn cài; đóng gói tools theo platform hoặc phát hiện PATH theo chính sách được công bố.
- [ ] Review rồi commit `test: verify native desktop download flows across platforms`.

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

Task 1–2 đã qua RED/GREEN, review và kiểm thử thực tế trong 0.6.0; dùng chung một commit vì cùng hợp đồng HTTP identity/preflight (ruling tại PROGRESS.md). Task 3 đã qua RED/GREEN, review và kiểm thử GUI/HTTP Internet thật ở 0.7.0. Journal nâng schema 5 với backup trước migration; đọc được v1–v5. HTTP range pool dừng nhóm writer trước khi chia, tối thiểu 256 KiB mỗi nửa, tối đa 1.024 vùng. Task 4 và milestone đổi N media đã qua nguồn/review; final gate/artifact 0.8 còn chờ. Task 5–10 chưa triển khai. State mới dùng schema 6, đọc v1–v6 và backup trước migration.
