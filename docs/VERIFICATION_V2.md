# FlowDM 0.2.0 — xác minh bản trình duyệt/video

Ngày 2026-10-23, Windows 10 x64; Node 23.6.0, Electron 45.0.0, Playwright 1.64.1, Chrome for Testing 156.0.8078.4 và FFmpeg 8.1. Mã runtime đã chốt trước khi build; không thay đổi IDM hay profile Chrome đang dùng của chủ máy.

| Hạng mục | Kết quả |
|---|---|
| Unit/integration | 102/102 pass, gồm engine, HLS, protocol, extension, đăng ký host và admission |
| Coverage toàn src + extension | 97,88% lines/statements; 88,54% branches; 96,06% functions; ngưỡng tổng 80% pass |
| Electron từ source | Thêm/pause/đóng mở/resume, bytes + SHA, lỗi URL/404, thư mục, hẹn giờ/hủy, lọc và onboarding trình duyệt pass |
| Windows unpacked | 2/2 E2E pass: desktop và Chromium → native host → manager thật |
| Windows portable | Chạy chính FlowDM 0.2.0.exe; pause → đóng/mở → resume, so sánh toàn bộ tệp 2 MiB pass |
| Capture trình duyệt | Tự nhận file HTTP, hủy bản tải gốc sau ACK; tắt capture, host vắng và thiếu quyền đăng nhập đều cho trình duyệt hoàn tất |
| Video | Nút trên video động yêu cầu click thật; popup thật chọn HLS TS/fMP4; so sánh toàn bộ byte và FFmpeg giải mã cả ba đầu ra pass |
| Quyền đăng nhập | Checkbox popup thật bật consent theo origin; cookie chỉ chuyển sau consent; journal không chứa cookie. Origin/CDN và revoke/regrant có kiểm thử hồi quy |
| Rà soát độc lập | Sáu phát hiện P1/P2 đã sửa và reviewer kiểm tra lại; xem browser-v2-review.md |
| Mã đóng gói | 31 file src/assets/extension trong mỗi ASAR Windows/Linux khớp byte source; ASAR SHA-256 `6240809659b4f8ab7f243fbad13ca78487c2cbf67be646a1292236129a8724e9` |
| Dependency audit | 0 vulnerabilities |
| Linux tar.gz | 71 payload khớp SHA với linux-unpacked; flowdm/chrome-sandbox/chrome_crashpad_handler có mode 0755; chưa chạy native |

Bằng chứng nằm trong [evidence/v0.2](evidence/v0.2). Báo cáo [0.1](VERIFICATION.md) được giữ làm lịch sử, không mô tả tính năng hiện tại.

## Giới hạn của phép thử

Chromium dùng profile tạm và bản sao extension cấp sẵn API cookies tùy chọn để tránh hộp xin quyền native trong test; consent sản phẩm vẫn mặc định tắt và được bật qua checkbox thật. Chưa tự động hóa hộp xin optional permission trên mọi bản Chrome/Edge. Native host thực sự được đăng ký tạm, khởi chạy, tải file rồi khôi phục giá trị đăng ký trước đó; không dùng mock cho cầu nối trong E2E.

IDM có sẵn trên máy can thiệp cả lượt tải Chrome for Testing không cài FlowDM. Vì vậy phép thử dùng bản sao Chromium đổi tên executable, cùng engine thật và profile riêng. Không dừng IDM hay sửa cấu hình của chủ máy. Khi sử dụng hàng ngày, chủ máy cần tắt tích hợp bắt tải của IDM/công cụ khác để tránh tranh lượt tải.

Kiểm thử video dùng clip tự tạo testsrc/sine ba giây, không dùng tài khoản hay nội dung bên ngoài. Điều này chứng minh các luồng direct/TS/fMP4 đã kiểm tra, không chứng minh mọi website/codec. Không hỗ trợ DRM, HLS mã hóa/live/byte-range/discontinuity, audio/video rời, DASH, quy tắc riêng YouTube, FTP hoặc proxy xác thực.

Native admission kiểm tra quyền truy cập trước khi trả ACK; lỗi/HTML đăng nhập giữ lượt tải trong trình duyệt. Đây không phải giao dịch phân tán exactly-once: timeout không chắc chắn có thể dẫn tới tác vụ đến muộn và bản tải trùng. Không tự hủy bản tải browser khi chưa nhận ACK đúng ID.

HLS tiếp tục từ đầu toàn bộ VOD. Journal mới ghi version 2 và đọc version 1 để nâng cấp; không mở lại journal version 2 bằng FlowDM 0.1. Headers nhạy cảm chỉ trong RAM, cần cấp lại sau khởi động. URL có signed query vẫn nằm trong journal, cần giữ riêng tư.

Linux chỉ được build/kiểm tra archive từ Windows, chưa chạy native. macOS chưa build/chạy vì cần máy Mac. Có workflow ba OS trong repository nhưng chưa push hoặc chạy CI bên ngoài. Bản Windows chưa ký mã.

## Lệnh lặp lại

`npm run test:coverage` chạy unit/integration + Electron và gộp V8 main/renderer. `node --test tests/e2e/browser.test.cjs` cần Playwright Chromium và FFmpeg trên PATH; có thể đặt FLOWDM_BROWSER_EXECUTABLE, FLOWDM_FFMPEG. Đặt FLOWDM_EXECUTABLE thành đường dẫn Windows unpacked để kiểm tra bản đóng gói. `node scripts/smoke-portable.cjs` kiểm tra launcher portable thật qua cổng debug loopback tạm và đóng sau kiểm thử.
