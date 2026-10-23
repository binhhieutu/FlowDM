# FlowDM 0.4.0 — tải video nhiều kết nối

Kiểm tra ngày 2026-10-24 trên Windows 10 x64. Đây là build dùng riêng trên máy chủ sở hữu. Electron 45, Chromium for Testing 156, yt-dlp 2026.10.21, FFmpeg 8.1, aria2 1.37.0.

## Thay đổi

Desktop và popup trình duyệt cho chọn tối đa 1/2/4/8/16 kết nối mỗi tác vụ. HLS tải các đoạn qua worker pool, giữ cửa sổ chờ tối đa N tài nguyên, ghép đúng thứ tự trên đĩa. DASH dùng native fragment downloader. YouTube ưu tiên video HLS H.264 đến 1080p cùng AAC/M4A; tài nguyên HTTP thông thường dùng aria2 với giới hạn N. Không chồng N worker lên N kết nối của cùng một tài nguyên.

Số kết nối thực tế có thể thấp hơn lựa chọn do số đoạn, kích thước tài nguyên, giới hạn tốc độ hoặc máy chủ. Thử nghiệm không phải cam kết tăng tốc N lần. Giới hạn tốc độ áp dụng cho từng tác vụ; hàng đợi có thể chạy ba tác vụ cùng lúc. Media pause/resume vẫn tải lại từ đầu.

## Kiểm tra source

| Kiểm tra | Kết quả |
|---|---|
| Unit/integration | 138/138 pass |
| Coverage toàn src + extension | 98,02% lines/statements; 86,25% branches; 94,64% functions; vượt ngưỡng tổng 80% |
| Electron desktop | Hành trình GUI, pause/restart/resume HTTP, lỗi/IPC/onboarding pass |
| Browser/native host | Chromium thật, tự bắt HTTP, HLS TS/fMP4, DASH, cookie consent, host-down fallback và số kết nối popup pass |
| Công cụ HTTP | aria2 thật: N=1 peak=1, N=4 có nhiều request đồng thời và không vượt 4; file 32 MiB SHA khớp |
| Công cụ DASH | yt-dlp thật với MPD cục bộ: N=1/N=4 đạt, số request đồng thời có giới hạn |
| HLS chống lỗi | Cửa sổ chờ, thứ tự TS/fMP4, hủy/đợi worker, lỗi gốc, dọn scratch, giới hạn dung lượng/tốc độ đạt |
| Rà soát | Đã đóng 5 phát hiện P1/P2; [báo cáo](multiconnection-v4-review.md) không còn P1/P2 trong phạm vi kiểm tra |
| npm audit | 0 vulnerabilities |

Benchmark source điều khiển qua giao diện Electron, mỗi tài nguyên cố định trễ 400 ms:

| Loại | N | Request đồng thời cao nhất | Thời gian |
|---|---:|---:|---:|
| HLS | 1 | 1 | 1.317 ms |
| HLS | 4 | 3 | 457 ms |
| DASH | 1 | 1 | 5.132 ms |
| DASH | 4 | 4 | 2.862 ms |

N=1 và N=4 cho cùng bytes/SHA ở từng loại, giải mã toàn bộ clip đạt. Đây là fixture mạng có độ trễ kiểm soát, không đại diện mọi website.

## Kiểm tra bản đóng gói

Windows unpacked đạt 3/3 E2E: desktop, browser/native host và chọn số kết nối qua GUI. Benchmark đóng gói: HLS N=1 1.428 ms/peak 1, N=4 547 ms/peak 3; DASH N=1 5.137 ms/peak 1, N=4 2.522 ms/peak 4. Hai cấu hình cho file byte-exact và giải mã đạt.

Trang YouTube thật → popup chọn N=4 → native host → app đóng gói tải thành công, ffprobe có cả video và audio. Lượt Electron packaged riêng sau khi tách tên file tải/ghép trong **20.210 ms**, file 288.972.332 byte cùng SHA với source N=1/N=4; giải mã toàn bộ 634,624 giây hình/tiếng đạt, FFmpeg exit 0 và stderr rỗng. Tổng E2E khoảng 50 giây.

Chính `FlowDM 0.4.0.exe` portable chạy thành công: HTTP 2 MiB pause → đóng/mở → resume khớp bytes; ba công cụ media sẵn sàng và kiểm tra integrity đạt. YouTube thật tải đủ 288.972.332 byte, SHA-256 khớp mẫu đã giải mã toàn bộ. Portable được đợi đóng và dọn thư mục thử thành công.

35 file src/assets/extension trong mỗi ASAR Windows/Linux khớp source đã đóng băng. ASAR SHA-256: `7e31511f55cc0244330b0fae552e11057e5342f4e09a8d158915e8c19896c4f7`. Cả ba executable Windows khớp size/SHA manifest. Linux tar.gz có 71 payload hash khớp linux-unpacked và ba executable mang quyền 0755; chưa chạy native.

## YouTube thật

Nguồn: [Big Buck Bunny — Official Blender Foundation Short Film](https://www.youtube.com/watch?v=aqz-KE-bpKQ), Blender Foundation, CC BY 3.0; [dự án gốc](https://peach.blender.org/). Chỉ dùng kiểm chứng, không đưa phim vào source ZIP.

Ứng dụng source với N=4 tải và ghép trong **21.258 ms**. File 288.972.332 byte, 634,624 giây, H.264 1920×1080 + AAC. FFmpeg giải mã toàn bộ video/audio với `-xerror`: exit 0, stderr rỗng. Tổng lượt E2E gồm kiểm tra/giải mã mất khoảng 50 giây. SHA-256: `fc6b9d58d1f91ebfba1e26f3968368ab4dce11d17b749a781e360688d08c44b4`.

N=1 cũng tải đủ và giải mã toàn bộ đạt, cùng size/SHA; download/merge 330.486 ms, phần hình xong sớm nhưng audio HTTP từ CDN chậm. Đây là các lượt mạng Internet riêng, có thay đổi điều kiện CDN và một phần chồng với lượt kiểm tra khác; không dùng tỷ lệ này làm benchmark tốc độ kiểm soát.

Trong thử nghiệm lựa chọn transport, HTTP Range qua aria2 thực sự mở 4 TCP nhưng mất khoảng 97 giây. Video HLS native cùng chất lượng tải/ghép khoảng 19–21 giây và giải mã toàn file đạt, nên được ưu tiên trong sản phẩm. Không suy luận rằng nhiều kết nối luôn nhanh hơn một kết nối.

Lượt packaged live đầu tiên gặp `EEXIST`: hai instance kiểm thử cùng dùng output/tên file, cùng chọn hậu tố `(2)` trước khi file xuất hiện; N=1 publish trước, instance còn lại từ chối ghi đè. Journal, SHA và thời điểm tạo file xác nhận nguyên nhân. Đã tách tên file bài E2E theo source/packaged, N và run ID; không sửa runtime hoặc ghi đè file. Bằng chứng lỗi ban đầu được giữ để đối chiếu với lượt chạy lại.

## Giới hạn và lặp lại

Giữ giới hạn v0.3: HLS/DASH VOD static không DRM, DASH trong tập con MPD hỗ trợ; YouTube công khai, không playlist/live/đăng nhập/vượt bot. DASH/YouTube không nhận Cookie/Authorization/Referer/User-Agent trình duyệt. Watch URL vào yt-dlp qua stdin; khi dùng aria2, signed CDN URL tạm xuất hiện trong argv của tiến trình con, có thể được cùng người dùng hoặc quyền quản trị xem trong lúc chạy. App không sao chép URL đó vào journal/log/UI/bằng chứng.

Nâng cấp cần kết nối lại native host, xuất tiện ích mới và Reload trong trang Extensions để đồng bộ trường `connections`. Kiểm thử dùng profile riêng/Chromium đổi tên, khôi phục đăng ký native host và giữ IDM/profile hằng ngày.

Windows đóng gói ba công cụ pin size/SHA, không cần Node/FFmpeg cài ngoài. Linux archive chỉ kiểm tra nội dung/quyền thực thi, chưa chạy native. macOS chưa build/chạy. Linux/macOS cần yt-dlp hỗ trợ EJS, FFmpeg và aria2c trên PATH. Xem [nguồn/giấy phép](MEDIA_TOOLS.md) trước phân phối công khai.

Lặp lại: `npm run test:coverage`; `node --test tests/e2e/concurrency.test.cjs`; `node --test tests/e2e/browser.test.cjs`. Đặt `FLOWDM_EXECUTABLE` để kiểm tra bản đóng gói. Live test: đặt `FLOWDM_LIVE_YOUTUBE` là URL trên, `FLOWDM_LIVE_CONNECTIONS` là 1 hoặc 4, rồi chạy `node --test tests/e2e/media-live.test.cjs`; tải toàn bộ phim và giải mã toàn file. Live mặc định tắt trên CI.

Bằng chứng của build này: [evidence/v0.4](evidence/v0.4). Chỉ thay đổi bài kiểm thử để tách tên file sau khi build; runtime/ASAR giữ nguyên, đã đối chiếu byte với source.
