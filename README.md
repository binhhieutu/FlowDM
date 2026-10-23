# FlowDM

Ứng dụng tải HTTP/HTTPS desktop mới cho Windows, Linux và macOS, xây từ đặc tả hành vi đã rút ra trong dự án phân tích IDM. Không dùng mã nguồn, thư viện hay hình ảnh IDM. Bản 0.1 dành cho tải tệp trực tiếp; xem [thiết kế](docs/DESIGN.md) và [bằng chứng kiểm thử](docs/VERIFICATION.md).

## Dùng trên Windows

Mở `dist/FlowDM 0.1.0.exe` (portable), hoặc `dist/win-unpacked/FlowDM.exe`. Không cần Node.js để chạy bản đóng gói. Nhấn **Thêm liên kết**, dán URL, chọn thư mục/tên tệp, số kết nối và bắt đầu. Có thể tạm dừng, tiếp tục, hủy, mở vị trí tệp, tìm kiếm/lọc danh sách, hẹn giờ và giới hạn tốc độ. Hủy xóa dữ liệu tạm; xóa khỏi danh sách không xóa tệp đã hoàn tất.

Tải đang chạy được chuyển sang tạm dừng khi đóng/khởi động lại; nhấn **Tiếp tục** để phục hồi. Tải nhiều kết nối và giữ lại byte khi resume yêu cầu server hỗ trợ Range và ETag mạnh. Nếu ETag đổi, ứng dụng báo lỗi và yêu cầu thêm lại để không trộn hai phiên bản. Server chỉ có Last-Modified hoặc không có validator an toàn dùng một luồng; tiếp tục sẽ tải lại từ đầu. Không ghi đè tệp có sẵn; tên trùng được thêm số. SHA-256 được tính sau tải (giúp so sánh với hash nhà phát hành, không tự chứng minh tệp đáng tin).

Giới hạn tốc độ áp dụng mỗi lượt tải, đơn vị KiB/s; tổng tốc độ có thể lớn hơn khi tải nhiều tệp. Hẹn giờ theo giờ máy, lưu thành một thời điểm tuyệt đối; máy và ứng dụng phải đang hoạt động. Không tự đánh thức máy hoặc chạy dịch vụ nền. Dữ liệu tạm nằm trong thư mục dữ liệu ứng dụng nên cần đủ chỗ trên ổ đó và ổ đích.

## Chạy mã nguồn trên ba hệ điều hành

Cần Node.js 22 trở lên và môi trường desktop đồ họa. Từ thư mục này:

```sh
npm ci
npm start
```

Linux cần các thư viện hệ thống mà Electron/Chromium yêu cầu (GTK, NSS, libgbm, ALSA), phiên X11/Wayland và sandbox Chromium hoạt động. Không chạy bằng root. Một số distro hạn chế user namespaces cần quản trị viên cấu hình sandbox theo chính sách máy; không tắt sandbox để chạy. Gói tar chưa có trình cài thiết lập sandbox hệ thống; chưa được xác minh trên máy Linux thật. macOS cần phiên đồ họa của người dùng; bản chưa ký/notarize cần tự build từ nguồn hoặc phê duyệt theo chính sách hệ điều hành.

Đóng gói trên nền tảng tương ứng:

```sh
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Windows x64 portable; Linux x64 tar.gz (`tar -xzf ...`, chạy `./flowdm`); macOS ZIP Intel x64 và Apple Silicon arm64. Artifact chỉ được xác nhận tạo thành công khi có trong báo cáo kiểm thử. [CI matrix](.github/workflows/desktop.yml) chạy kiểm thử và build trên ba OS khi bạn đưa dự án lên repository riêng; chưa được gửi/chạy lên dịch vụ bên ngoài trong phiên làm việc này. Đóng gói macOS/ký mã phụ thuộc công cụ nền tảng; [electron-builder multi-platform](https://www.electron.build/docs/features/multi-platform-build/).

## Trình duyệt (tùy chọn)

Tiện ích MV3 có menu **Tải bằng FlowDM** cho liên kết/video/audio có URL HTTP/HTTPS trực tiếp. Cài bằng hướng dẫn [BROWSER.md](docs/BROWSER.md). Host cần Node.js 22+, ứng dụng đang mở và đăng ký thủ công; desktop không tự sửa registry/trình duyệt. Không tự hủy lượt tải của trình duyệt. Chưa xác minh cài host trên trình duyệt thật.

## Dữ liệu và phạm vi

- File tác vụ `downloads.json` và các `.part` nằm ở `app.getPath('userData')/state`; đích mặc định là `Downloads/FlowDM`. Có thể đặt `FLOWDM_DATA_DIR` và `FLOWDM_DOWNLOAD_DIR` thành đường dẫn tuyệt đối khi chạy để dùng thư mục riêng.
- URL nguyên gốc, bao gồm signed query/token trong URL, được lưu để resume. Không chia sẻ thư mục dữ liệu. HTTP không mã hóa; ưu tiên HTTPS. Headers nhạy cảm chỉ trong bộ nhớ; tải cần headers phải thêm lại sau khởi động. Giao diện và tiện ích chưa cung cấp nhập cookie/header.
- Hỗ trợ file đến 100 GiB (giới hạn engine), tối đa 3 lượt tải và 3 lượt tải mỗi host, mỗi lượt tối đa 16 kết nối (giao diện chọn 1/2/4/8). Server không hỗ trợ Range dùng một luồng. Không tự mở/chạy tệp tải về.
- Thư mục đích cần filesystem hỗ trợ hard link (NTFS, ext4, APFS…). FAT/exFAT chưa hỗ trợ; ứng dụng kiểm tra và báo `UNSUPPORTED_DESTINATION_FILESYSTEM` trước khi tải. Sau một số tình huống mất điện ngay khi công bố file, bản sao `.part` có thể còn lại dù lịch sử đã phục hồi hoàn tất; đây là khoản dọn dữ liệu tạm còn cần cải thiện, không ảnh hưởng nội dung file cuối.
- Chưa có FTP, proxy xác thực, site grabber, ghép HLS/DASH, tải DRM, bộ quy tắc riêng YouTube, import dữ liệu IDM, tự cập nhật hoặc tự bắt mọi lượt tải trình duyệt. Không tuyên bố tương đương đầy đủ IDM.

## Kiểm thử

```sh
npm test
npm run test:coverage
npm run test:e2e
```

E2E mở Electron thật, tải từ server fixture cục bộ, pause, đóng/mở lại, resume, so sánh byte và SHA-256, kiểm tra URL lỗi và cấu hình sandbox. Linux CI dùng `xvfb-run --auto-servernum npm run test:e2e`. Không cần truy cập IDM hoặc tài khoản bên ngoài. Kiểm thử bản đóng gói Windows bằng PowerShell:

```powershell
$env:FLOWDM_EXECUTABLE = (Resolve-Path '.\dist\win-unpacked\FlowDM.exe').Path
npm run test:e2e
Remove-Item Env:FLOWDM_EXECUTABLE
```

`npm run test:coverage` chạy cả unit/integration và Electron E2E, gộp V8 coverage của tiến trình chính và giao diện; ngưỡng tổng tối thiểu 80% dòng/statement/nhánh/hàm. Linux chạy lệnh này trong `xvfb-run --auto-servernum`. Kiểm tra portable thật bằng `node scripts/smoke-portable.cjs` trên Windows; script dùng cổng debug loopback tạm và đóng tiến trình sau khi so sánh byte. Kiểm tra HTTPS ngoài Internet tùy chọn: `node scripts/smoke-https.cjs`. Không đưa live-network smoke vào bộ test offline.

## Kiến trúc

`src/core`: HTTP, chia đoạn, state machine và journal. `src/main.cjs`: lifecycle/IPC. `src/ui`: giao diện tài nguyên nội bộ, CSP và DOM text an toàn. `src/bridge`: Native Messaging/IPC xác thực. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/) và [Playwright Electron](https://playwright.dev/docs/api/class-electron) là tài liệu tham chiếu kiểm thử desktop.
