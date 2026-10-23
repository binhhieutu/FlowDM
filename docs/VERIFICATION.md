# FlowDM 0.1.0 — kết quả xác minh

Ngày 2026-10-23. Máy thực thi: Windows 10 build 19045 x64; Node 23.6.0; Electron 45.0.0; Playwright 1.64.1; electron-builder 26.15.3. Mọi runtime source nằm trong `src/`; kết quả dịch ngược IDM giữ nguyên bên ngoài dự án.

## Kết quả bản cuối

| Hạng mục | Kết quả |
|---|---|
| Unit + integration | 38/38 pass: 29 engine, 9 bridge/extension |
| Electron E2E từ source | Pass thêm link → pause → đóng/mở lại → resume → hoàn tất; bytes + SHA khớp; URL sai; HTTP 404; lọc/tìm kiếm; chọn thư mục; hẹn giờ; hủy/xóa |
| E2E Windows unpacked `.exe` | Cùng hành trình pass trên binary đóng gói |
| Portable Windows `.exe` | Chạy chính file phân phối, pause → thoát → mở lại → resume; file 2 MiB so sánh toàn bộ byte pass |
| Coverage toàn `src/` | 96,70% lines/statements; 86,54% branches; 92,13% functions, có cả main/preload/UI; ngưỡng tổng 80% pass |
| HTTPS thật | RFC9110.txt, 502.941 byte, SHA256 `21c1cdce6ab0e5509b04d84a28000836c7a087cf786efe6f04877ebfff47232a`; so sánh toàn bộ bytes với fetch độc lập pass |
| Dependency audit | 0 vulnerabilities, 323 packages được npm audit tại lúc cài; lockfile giữ phiên bản |
| Rà soát độc lập | 1 P1 + 2 P2 đã tái hiện bằng RED, sửa và GREEN; reviewer xác minh không còn P1/P2 trong phạm vi |
| Mã trong gói | 17 source/asset files mỗi Windows/Linux ASAR khớp byte với source cuối |
| Linux tar.gz | Build thành công từ Windows; 71 payload files khớp thư mục unpacked; 3 executable có mode0755 sau sửa metadata tar |
| Linux runtime | **Chưa chạy trên Linux thật**; không có distro WSL/máy Linux trong môi trường. Cần kiểm tra thư viện và sandbox trên distro đích |
| macOS | **Chưa build/chạy**. Lệnh build trên Windows trả `Build for macOS is supported only on macOS`; có source/script/CI matrix để chạy trên Mac |
| Browser thật | Host subprocess + API extension giả lập pass; không đăng ký vào Chrome/Edge thật hoặc thay registry |

Coverage gộp từ Node V8, Electron main và Chromium renderer thực tế, không phải ước lượng. Đây là tỷ lệ tổng; các module nhỏ như preload/host vẫn có nhánh chưa đi qua. Không phải đảm bảo hết mọi lỗi hoặc đã test mất điện vật lý.

## Hành vi lỗi đã kiểm tra

Range bị bỏ qua, Content-Range sai, response thiếu/dư byte, không Content-Length, file rỗng, body bị ngắt, đổi ETag, Last-Modified trùng giây, timeout/retry có giới hạn, redirect/strip credential, hủy lúc limiter đang đợi, giới hạn global/per-host, checkpoint thiếu/ngắn, journal rename lỗi, đĩa đầy mô phỏng, crash snapshot quanh final publication, đích không hỗ trợ hardlink, không ghi đè tệp/symlink có sẵn. Đặc biệt: chỉ ETag mạnh cho phép resume giữ byte; Last-Modified-only tải lại an toàn.

Native Messaging: frame UTF8 chia nhỏ/nối tiếp, JSON/UTF8 sai, quá cỡ, schema/URL, xác thực local IPC, dedupe, host vắng mặt, callback lỗi/timeout, host subprocess thật. Extension không hủy lượt tải trình duyệt khi chưa có xác nhận.

## Lệnh tái lập

```sh
npm ci
npm run test:coverage
npm run dist:win
npm run dist:linux
node scripts/verify-package.cjs
node scripts/smoke-portable.cjs
node scripts/smoke-https.cjs
```

`verify-package.cjs` cần cả hai thư mục unpacked Windows/Linux. Lệnh tar Linux có hook sửa quyền executable khi đóng gói trên Windows; mỗi payload được đối chiếu SHA trong lần xác minh hiện tại. Native macOS chạy `npm run test:coverage` và `npm run dist:mac` trên Mac. CI mới chỉ là cấu hình local, chưa push hay chạy remote.

Log/JSON chọn lọc và screenshots nằm trong `docs/evidence/`. Xem thêm `core-report.md`, `bridge-report.md`, `review.md`, và `PROGRESS.md`. `dist/SHA256SUMS.txt` ghi checksum artifact. Không có chứng chỉ ký mã; Windows portable là bản chưa ký.

## Giới hạn còn lại

Đây là ứng dụng HTTP/HTTPS mới có các chức năng tải cốt lõi, chưa ngang toàn bộ IDM: không FTP, authenticated proxy, cookie UI, HLS/DASH assembly, DRM, site grabber hoặc tự bắt mọi download trình duyệt. Filesystem đích phải hỗ trợ hard link; FAT/exFAT bị từ chối trước tải. Journal giữ nguyên URL signed query để resume. Lịch cần ứng dụng/máy hoạt động. Một số crash snapshot có thể để lại `.part` thừa sau khi đã xác minh final; cleanup là cải thiện còn lại. Cần máy Linux/Mac để khép kín yêu cầu chạy ổn trên cả ba OS.
