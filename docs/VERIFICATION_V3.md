# FlowDM 0.3.0 — DASH và YouTube

Ngày 2026-10-23, Windows 10 x64. Electron 45, Chromium for Testing 156, yt-dlp 2026.10.21, FFmpeg 8.1. Đây là build dùng riêng trên máy chủ sở hữu, chưa phát hành bên ngoài.

| Kiểm tra | Kết quả |
|---|---|
| Unit/integration | 122/122 pass |
| Coverage src + extension | 97,26% lines/statements; 85,46% branches; 95,26% functions; ngưỡng tổng 80% pass |
| Source Electron | Hành trình desktop, pause/restart/resume, lỗi/IPC/onboarding pass |
| Windows unpacked | 3/3 E2E pass: browser/native host, desktop và tải YouTube thật |
| Delta browser cuối | Sau sửa đồng bộ tab/SPA, Windows unpacked → trang YouTube thật → popup → native → MP4 đạt; cả HLS/DASH/direct/cookie fallback chạy lại đạt |
| Windows portable cuối | Chạy chính FlowDM 0.3.0.exe, pause → đóng/mở → resume đạt; media tools integrity đạt; YouTube thật tải đủ 288.738.744 byte và SHA khớp file đã giải mã toàn bộ |
| DASH thực thi | Popup Chromium phát hiện/chọn MPD static có hai AdaptationSet; yt-dlp tải, FFmpeg ghép MP4; ffprobe có video + audio và giải mã toàn bộ clip 3 giây pass |
| YouTube thật | Big Buck Bunny — Official Blender Foundation Short Film, `aqz-KE-bpKQ`; tải qua giao diện app source và Windows unpacked |
| File YouTube | 288.738.744 byte; 634,624 giây; H.264 1920×1080 + AAC; SHA-256 `84e2283f47859c3bb74b8e30e69d393733393cca6f4a3a110a3bae20754e0082` |
| Giải mã YouTube | FFmpeg giải mã toàn bộ hình + tiếng với `-xerror`: exit 0, stderr rỗng; bản source và packaged cho cùng SHA-256 |
| Package integrity | 34 file src/assets/extension mỗi ASAR Windows/Linux khớp source; ASAR SHA-256 `2236294de38af152720f38370b728a230df0daa4932df8e180b28d61ad18a8af`; hai binary media Windows khớp size/SHA manifest |
| Audit/review | npm audit: 0 vulnerabilities. [Rà soát](media-v3-review.md): không còn phát hiện P1/P2 trong phạm vi đã kiểm tra |
| Linux archive | 71 payload SHA khớp linux-unpacked, ba executable mode 0755; tạo tar/gzip level 6 bằng Python sau build-dir, không chạy native |

Video mẫu lấy từ https://www.youtube.com/watch?v=aqz-KE-bpKQ — Blender Foundation, Big Buck Bunny, CC BY 3.0; dự án gốc https://peach.blender.org/ . Chỉ dùng xác minh tải/ghép/phát, không đưa bản phim vào source ZIP. File kết quả được giữ tại `downloads/verification-v3/` cho chủ máy kiểm tra.

## Hành vi và giới hạn đã chốt

- DASH VOD static không mã hóa, ghép audio/video thành MP4. MPD được giữ đúng bytes đã kiểm tra qua relay loopback tạm; từ chối DRM/ContentProtection, live, entity/CDATA và dạng namespace tài nguyên ngoài tập con hỗ trợ. Đây không phải trình hỗ trợ mọi biến thể DASH.
- YouTube công khai dạng watch/shorts/youtu.be, kể cả host mobile, được chuẩn hóa trước khi tải. Ưu tiên H.264 đến 1080p + M4A/AAC. Chưa có bộ chọn từng chất lượng, playlist, live, DRM, video yêu cầu đăng nhập/tuổi/vùng hoặc cơ chế vượt bot/PO-token.
- DASH/YouTube không đọc/chuyển Cookie, Authorization, Referer hoặc User-Agent của trình duyệt. Pause/đóng app sẽ dừng tiến trình; resume tải lại từ đầu. Journal v3 đọc v1/v2; không mở bằng app cũ sau nâng cấp.
- Tải qua stdin, không đặt signed URL trên command line; không shell/config/plugin/remote-component/update tự động. Tiến trình nhận môi trường tối thiểu, output/scratch/stdio/timeout có giới hạn, FFmpeg kiểm tra có cả video/audio trước publish. Kiểm tra một giây trong engine không thay thế kiểm thử giải mã toàn file của bản phát hành.
- Các kiểm thử browser dùng profile riêng, bản Chromium đổi tên để tránh IDM đang chạy. Không dừng IDM, không sửa profile thường dùng. Đăng ký host tạm được khôi phục sau test. Để dùng FlowDM hàng ngày, chủ máy cần tránh chạy đồng thời hai tích hợp bắt tải.

Windows bundle dùng công cụ đã pin/hash, không cần Node/FFmpeg cài ngoài. Linux chỉ kiểm tra archive, chưa chạy media native; macOS chưa build/chạy. Linux/macOS cần yt-dlp + FFmpeg trên PATH. [Nguồn và giấy phép công cụ](MEDIA_TOOLS.md) nêu giới hạn build dùng riêng và công việc corresponding-source trước khi phân phối công khai.

## Lặp lại

`npm run test:coverage`; `node --test tests/e2e/browser.test.cjs` (cần Playwright Chromium/FFmpeg/ffprobe). Đặt FLOWDM_EXECUTABLE để thử bản đóng gói. Live test tự ngắt mặc định: đặt FLOWDM_LIVE_YOUTUBE thành URL Big Buck Bunny ở trên rồi chạy `node --test tests/e2e/media-live.test.cjs`; lệnh tải toàn bộ phim và giải mã toàn file. Browser E2E có thêm nhánh popup YouTube thật khi biến live được đặt. Không chạy live test mặc định trên CI.

Bằng chứng của build này ở [evidence/v0.3](evidence/v0.3); báo cáo 0.1/0.2 giữ nguyên làm lịch sử. Desktop và giải mã YouTube toàn file được kế thừa sau delta chỉ ở extension; browser và portable được chạy lại trên ASAR cuối. Smoke portable dùng window.close để đóng Electron thật vì CDP Target.closeTarget không ổn định với launcher này; tiến trình được đợi đóng trước khi dọn thư mục thử.
