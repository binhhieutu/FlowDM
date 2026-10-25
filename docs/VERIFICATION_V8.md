# FlowDM 0.8.0 — lựa chọn media và đổi số kết nối media

Ngày 2026-10-26. Phạm vi: Task 4 và milestone bổ sung live N trong [checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md). **Trạng thái: hoàn tất Task 4 và milestone đổi N media; coverage/audit, build/integrity, portable và các lượt GUI Windows cuối đều đạt.** Các kết quả JSON dưới đây được giữ nguyên; không coi kết quả nguồn là PASS của bản đóng gói.

## Khả năng đã triển khai

- Kiểm tra DASH/YouTube rồi chọn chính xác ID video/audio, codec, độ phân giải và dung lượng ước lượng; audio-only; chọn container MP4/WebM/MKV theo codec. Định dạng biến mất hoặc actual format khác lựa chọn bị từ chối trước checkpoint/transfer.
- Chọn tối đa 8 phụ đề VTT/SRT thủ công/tự động để nhúng MKV. Giới hạn 2 MiB/track, 8 MiB tổng; fixed demuxer webvtt/srt, chỉ map subtitle stream; network/remux chịu deadline/abort.
- Playlist YouTube chuẩn cho preview/chọn tối đa 100 mục, mặc định chưa chọn; server xác minh entry trong catalog và tạo job riêng. Token catalog ràng buộc URL/type, hết hạn 10 phút, tối đa 16 catalog và 2 lượt inspect.
- HLS thay worker N trực tiếp; giảm N chờ request đang chạy xuống mức mới. Native DASH/YouTube đủ điều kiện thực hiện pause/settle/checkpoint → lưu N → resume cùng ID/selection. HTTP fallback/pha không có checkpoint an toàn từ chối live resize, giữ lượt tải đang chạy. N API 1–16; UI 1/2/4/8/16.
- Journal schema 6 đọc 1–6, backup nguyên byte trước nâng schema; selection vào identity của resume/refresh. State schema 6 không dùng với binary 0.7 trở về trước.

## Bằng chứng nguồn thực tế

Các link JSON/PNG là kết quả các lượt GUI trên Windows; reviewer đọc bằng chứng, không tự chạy lại các hành trình GUI này. Timestamp JSON nằm ngày 2026-10-25 UTC, tương ứng sáng 2026-10-26 tại Việt Nam.

| Hành trình | Kết quả | Bằng chứng |
|---|---|---|
| DASH do dự án tạo | H.264 3840×2160 + AAC; audio-only AAC; 2 giây, cả hai full decode; format sai bị từ chối | [JSON](evidence/v0.8/media-selection-v8-source.json), [PNG](evidence/v0.8/media-selection-v8-source.png) |
| YouTube Big Buck Bunny công khai | ID 312+140: 1920×1080 H.264/AAC, 268514873 byte; audio-only 140: 10264233 byte; 634.625 giây, cả hai full decode | [JSON](evidence/v0.8/media-selection-v8-public-source.json), [PNG](evidence/v0.8/media-selection-v8-public-source.png) |
| YouTube Sintel phụ đề công khai | ID 230+140 + manual:en → MKV 33854529 byte; H.264/AAC/SubRip, 888.093 giây, full decode | [JSON](evidence/v0.8/media-selection-v8-public-caption-source.json), [PNG](evidence/v0.8/media-selection-v8-public-caption-source.png) |
| Playlist công khai | 17 ID duy nhất; select-all, chọn một mục, ID ngoài catalog bị từ chối; downloadsCreated=0 | [JSON](evidence/v0.8/media-selection-v8-playlist.json), [PNG](evidence/v0.8/media-selection-v8-playlist.png) |
| HLS live N + relaunch | 1→4→1, peak request 4; paused/restored 109604 byte; 2 resource bền vững mỗi resource GET 1 lần; 224472 byte, SHA trùng baseline, full decode | [JSON](evidence/v0.8/media-live-v8-source.json), [PNG](evidence/v0.8/media-live-v8-source.png) |
| DASH live N + relaunch | 1→4→1, peak request 4; paused/restored 12834 byte; init + fragment đầu mỗi resource GET 1 lần; 205020 byte, SHA trùng baseline, full decode | [JSON](evidence/v0.8/media-live-v8-source.json) |
| YouTube Sintel native live N + relaunch | 1→4→1, ID 230+140 giữ nguyên; reuse 6 resource/621904 byte; final 34076192 byte, 888.094 giây, full decode | [JSON](evidence/v0.8/youtube-native-live-v8-source.json), [PNG](evidence/v0.8/youtube-native-live-v8-source.png) |

4K là fixture DASH tạo thực sự ở 3840×2160, không phải bằng chứng tải YouTube 4K. BBB không có track VTT/SRT phù hợp trong lần inspect; thử phụ đề chuyển sang nguồn Sintel và ghi báo cáo riêng. Playlist công khai có thử preview/chọn mục và lượt packaged tạo đúng một job qua nút submit, pause/relaunch giữ ID/URL/N2 rồi cancel; dừng ở 0 byte, chưa tải toàn batch. Lỗi từng entry được kiểm tra riêng bằng core integration.

Lượt native YouTube nguồn cuối ghi version=0.8.0, packaged=false và exit0 sau 534.77 giây. Paused 678368 byte và restored 751952 byte phản ánh worker settle khi đóng; N khôi phục=1. Mẫu ban đầu trước nâng metadata vẫn giữ riêng trong youtube-native-live-v8-source-initial.json. CDN request counts không thu được, nên chỉ xác nhận reuse do checkpoint báo cáo và full decode, không khẳng định không GET lại trên CDN.

### SHA-256 đã ghi

| Tệp thử | SHA-256 |
|---|---|
| Generated 4K MP4 | 46a232f7e8e67ab5857be01c093e73c1362abd3e69226f978e3d2ecba29381e1 |
| Generated audio M4A | 116e902b1ccc0a71a8948f3dc9eefdebe83940af5d23d14aebc89f061c40e7e0 |
| BBB selected 1080p MP4 | d6355e1b7785b8647f1fc09583b0c417a9b22381231b72440e3fbe9c8759fa46 |
| BBB selected audio M4A | a4a58b2407e8bfaf96cb70c4edb4d6928cdd699498f9b29679445b94b2aa5302 |
| Sintel English-subtitle MKV | d32de71c1b07326a3b6e58192a2ce78098ce2fbc5fa755e5957385dc24c216e7 |
| HLS live N output/baseline | 6a9e41ab4d4eb32883e12a163dda84e5dc2639cef5c81ce1b100f0b41fb28ea8 |
| DASH live N output/baseline | c88d42fffe773a09c8d834d436cd025aed8e16fbe792c4ae3b49a27e7c760da2 |
| Sintel native live N MP4 | e946cdb5a062fedb143dc8cf0411fbb841b2661bc24521090949d7455418b6d5 |

## Review và hồi quy

[Review độc lập](media-selection-v8-review.md) đóng 3 P2: selector alias/actual selected ID khác lựa chọn, subtitle work vượt deadline, và caption bị FFmpeg diễn giải thành concat input đọc fixture local. Không còn P1/P2 trong phạm vi delta đã review. Reviewer chạy độc lập 4/4 test, 0 fail/skip:

~~~sh
node --test tests/media/external-deadline.test.cjs tests/media/external-subtitle-security.test.cjs tests/media/selected-identity.test.cjs
~~~

Lệnh hành trình nguồn có kiểm soát:

~~~sh
node --test --test-concurrency=1 tests/e2e/media-selection.test.cjs tests/e2e/media-live-connections.test.cjs
~~~

Các nhánh public opt-in dùng FLOWDM_LIVE_YOUTUBE, FLOWDM_SUBTITLE_YOUTUBE/FLOWDM_SUBTITLE_ONLY và FLOWDM_LIVE_PLAYLIST. Với artifact, FLOWDM_EXECUTABLE phải trỏ đúng binary cuối; không lấy JSON nguồn để thay thế lượt packaged. Public/live-N JSON ban đầu được thu trước các sửa lỗi review cuối. Final source coverage gate đã chạy lại desktop/local media-selection; native YouTube nguồn cuối cũng chạy lại sau các fix và có exit0. Các lượt packaged nằm trong bảng cuối.

## Artifact và kiểm thử đóng gói 0.8.0

| Kiểm tra cuối | Kết quả |
|---|---|
| Unit/integration + coverage | 241/241; desktop 1/1 và local media-selection 1/1; tổng 96.75% lines/statements, 86.16% branches, 94.78% functions |
| Dependency audit | 0 vulnerabilities; không đổi dependency versions |
| Windows packaged GUI local | 4/4 pass, 5 public opt-in skip trong lệnh local; HTTP live N, HLS/DASH 1→4→1/relaunch, 4K/audio-only, refresh HTTP/HLS/DASH đều đạt |
| HLS/DASH resource log | Peak 4; hai resource đã commit mỗi loại chỉ GET 1 lần qua resize/relaunch; cùng SHA với baseline và full decode |
| Public BBB 1080p + audio-only | 1/1 pass exit0; cả hai SHA/byte khớp mẫu nguồn trong bảng trên; full decode |
| Public Sintel phụ đề | 1/1 pass exit0; 33854529 byte, H.264/AAC/SubRip; full decode 888.093 giây |
| Public playlist submit | 1/1 pass exit0; 17 preview, chọn 1, tạo 1 job canonical N2, pause/relaunch/cancel và cleanup đạt; [JSON](evidence/v0.8/media-playlist-batch-v8-packaged.json) |
| Public native live N | 1/1 pass exit0, 530.89 giây; 1→4→1, pause/relaunch giữ 6 resource/621904 byte; 34076192 byte, SHA khớp mẫu nguồn, full decode 888.094 giây; [JSON](evidence/v0.8/youtube-native-live-v8-packaged.json) |
| Portable launcher | HTTP 2 MiB pause/relaunch/resume đúng bytes/SHA, media tools verified; exit0 |
| Package integrity | Windows và Linux ASAR khớp 47 file src/assets/extension; 3 media tool Windows đúng pin/hash |

Bản Windows portable: `dist/FlowDM 0.8.0.exe`, 263172342 byte, SHA-256 `d2451f6627dd418a1a8b346f72e44a4355a12cf98d1e9d6ff4dc94f8887de796`. Checksum: `dist/FlowDM-0.8.0-SHA256SUMS.txt`. Windows/Linux ASAR SHA-256 `db57dbe3619be906cd231166a21be6aaf3cc85e1c6d996d32a2482312c3f15b9`.

Public caption MKV đóng gói SHA-256 `f9556e1e740f298562b76b4ba0f8ce12ceb20c33624fb3e287c9554ed9bb44c7`; track, duration và decode được kiểm tra riêng từng lượt.

Bằng chứng cuối tại [evidence/v0.8](evidence/v0.8), gồm JSON/PNG, log và [summary.json](evidence/v0.8/summary.json). Các file hồi quy mang tên dynamic-v7/source-refresh-v6 trong thư mục này là lượt chạy mới trên binary 0.8, được ghi bởi harness giữ tên phiên bản lịch sử. Lệnh local chạy đủ 4 test; public được chạy riêng và có exit log riêng.

Build đầu lỗi package-manager invocation do PATH/PATHEXT của môi trường công cụ; chạy lại bằng PATH/PATHEXT riêng cho lệnh đạt exit0, không sửa dependency/runtime. Linux 0.8 chỉ build thư mục và kiểm tra ASAR, chưa xuất archive mới hoặc chạy native; macOS chưa build/chạy. Portable smoke chỉ xác minh HTTP/tools; các hành trình media dùng Windows unpacked cuối có cùng ASAR.

Chưa ký/push/publish. Không tuyên bố tương đương mọi tính năng IDM, không hỗ trợ DRM/live/login challenge; không cam kết N kết nối tăng tốc N lần. Task 5–10 vẫn chưa triển khai.

Native YouTube nguồn cuối và Windows packaged cùng format230+140, cùng SHA `e946cdb5a062fedb143dc8cf0411fbb841b2661bc24521090949d7455418b6d5`. Cả hai giữ N1 và selection qua relaunch, restored751952 byte, tái sử dụng6resource/621904 byte. Audio HTTP N1 bị CDN giới hạn trong lượt này nên test mất khoảng9 phút; vẫn tiến triển và kết thúc exit0. Không có request log của CDN nên không suy thành bằng chứng không GET lại bên máy chủ công khai.
