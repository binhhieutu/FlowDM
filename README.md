# FlowDM 0.2

Ứng dụng tải HTTP/HTTPS desktop với tiện ích Chromium tự bắt tải xuống và chọn tải video HLS VOD. Mã nguồn và nhận diện riêng; không dùng mã hay tài sản IDM và không tuyên bố đủ mọi tính năng IDM.

## Dùng trên Windows

Mở `dist/FlowDM 0.2.0.exe` hoặc `dist/win-unpacked/FlowDM.exe`. Bản đóng gói không cần cài Node.js. Nhấn **Thêm liên kết** để chọn URL, thư mục, tên tệp và số kết nối. Có tạm dừng/tiếp tục, hủy/thử lại, tìm kiếm/lọc, hẹn giờ, giới hạn tốc độ và SHA-256 sau tải. Không tự mở hay chạy tệp tải về; không ghi đè tệp có sẵn.

Tải tệp nhiều kết nối và resume giữ byte cần server hỗ trợ Range và validator an toàn. Khi không thể xác minh cùng phiên bản, ứng dụng tải lại an toàn hoặc báo lỗi thay vì trộn dữ liệu. HLS tiếp tục/thử lại từ đầu toàn bộ video. Hủy xóa dữ liệu tạm; xóa lịch sử không xóa tệp đã hoàn tất.

Giới hạn tốc độ tính theo từng lượt tải, đơn vị KiB/s. Lịch hẹn dùng giờ máy; máy và FlowDM phải đang hoạt động. Không có dịch vụ nền tự đánh thức máy.

## Kết nối trình duyệt

1. Mở **Kết nối trình duyệt** trong FlowDM, chọn Chrome/Edge/Chromium phù hợp rồi nhấn **Mở thư mục tiện ích**.
2. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode, chọn **Load unpacked / Tải tiện ích đã giải nén** và chọn thư mục vừa xuất.
3. Sao chép ID 32 ký tự của tiện ích, dán vào FlowDM và nhấn **Kết nối**. Giữ ứng dụng đang mở.

Windows dùng runtime Electron/Node được sao chép vào vị trí ổn định dành cho native host; không cần Node.js ngoài. Đăng ký chỉ áp dụng cho tài khoản hiện tại. **Ngắt kết nối** hoàn lại đăng ký trước đó nếu mục đăng ký vẫn do FlowDM quản lý. Xem [hướng dẫn trình duyệt](docs/BROWSER.md).

Tự bắt tải HTTP(S) bật mặc định khi cài tiện ích và có thể tắt trong popup. Trình duyệt chỉ hủy lượt tải sau khi FlowDM kiểm tra truy cập, lưu tác vụ và trả xác nhận đúng ID. Cầu nối vắng mặt, lỗi truy cập/đăng nhập, phản hồi HTML không phù hợp hoặc hết thời gian chờ sẽ giữ/tiếp tục lượt tải trình duyệt. Timeout vẫn có thể tạo một tác vụ đến muộn; kiểm tra hàng đợi trước khi gửi lại.

Cookie, Authorization, Referer và User-Agent mặc định không được chuyển. Nếu cần đăng nhập, mở popup, chọn đúng tên miền của trang hoặc tài nguyên/CDN rồi bật quyền rõ ràng. Cookie được lấy theo URL với quyền tùy chọn; bearer token cần một yêu cầu mạng mới sau khi cấp quyền. Headers chỉ ở bộ nhớ và bị bỏ khi chuyển sang origin khác.

Tiện ích nhận diện video/audio/source động và các manifest mạng, kể cả player dùng blob. Nhấn **Tải video bằng FlowDM** cạnh media hoặc chọn mục trong popup. Phát hiện media không tự tải mọi luồng. Hỗ trợ tệp trực tiếp và HLS VOD không mã hóa dạng MPEG-TS hoặc fMP4. Chưa hỗ trợ live, DRM/mã hóa, DASH, audio/video tách riêng hay quy tắc trích xuất riêng cho từng website. HLS ghép theo thứ tự nguồn, không chuyển mã/remux; xem [phạm vi media](docs/media-report.md).

Nếu đang dùng IDM, tắt tích hợp IDM cho trình duyệt dùng FlowDM để tránh hai trình quản lý cùng bắt một tải. Kiểm thử thấy IDM vẫn can thiệp Chrome thường dù đã bỏ tiện ích IDM. Không cần thay đổi profile thật để thử bản này.

## Dữ liệu và tương thích

- `downloads.json` và dữ liệu tạm nằm ở `app.getPath('userData')/state`; đích mặc định là `Downloads/FlowDM`. Có thể đặt `FLOWDM_DATA_DIR` và `FLOWDM_DOWNLOAD_DIR` bằng đường dẫn tuyệt đối.
- URL, gồm signed query/token cần để resume, được lưu trong lịch sử. Không chia sẻ thư mục dữ liệu. Headers nhạy cảm không được lưu; tải cần đăng nhập có thể phải thêm lại sau khi khởi động.
- Journal 0.2 ghi schema v2 và đọc được schema v1. Bản 0.1 từ chối v2: sao lưu thư mục dữ liệu trước khi nâng cấp nếu cần quay lại bản cũ.
- Giới hạn mặc định 100 GiB/tệp, ba lượt tải đồng thời, tối đa ba lượt/host; UI chọn 1/2/4/8 kết nối. Server không hỗ trợ Range dùng một luồng. Cần chỗ trống cho dữ liệu tạm và tệp cuối.
- Đích cần filesystem hỗ trợ hard link như NTFS/ext4/APFS; FAT/exFAT chưa hỗ trợ. Không có FTP, proxy xác thực, site grabber, nhập dữ liệu IDM hay tự cập nhật.

## Chạy nguồn, build và kiểm thử

Cần Node.js 22+ và phiên desktop đồ họa:

```sh
npm ci
npm start
npm test
npm run test:coverage
npm run test:e2e
```

Đóng gói bằng `npm run dist:win`, `npm run dist:linux` hoặc `npm run dist:mac`. Windows là nền tảng đã chạy kiểm thử desktop và trình duyệt thật; xem kết quả tại [VERIFICATION_V2.md](docs/VERIFICATION_V2.md). Linux x64 tar.gz đã build nhưng chưa chạy native trên Linux; macOS chưa build/chạy. Linux cần thư viện Electron, X11/Wayland và sandbox hoạt động; không tắt sandbox hoặc chạy root để bỏ qua lỗi môi trường. Bản chưa ký/notarize có thể cần phê duyệt theo chính sách hệ điều hành.

E2E trình duyệt thật dùng Chrome for Testing 156 và Electron, kiểm tra tự bắt tải, tắt bắt tải, host vắng mặt, đăng nhập khi chưa/có consent, nút media chống click giả, byte tệp trực tiếp/HLS TS/fMP4 và giải mã bằng FFmpeg. Profile thử dùng bản Chromium được đổi tên để tránh hook IDM; IDM và profile thật của chủ máy không bị chỉnh sửa. Bản sao tiện ích thử được cấp sẵn API cookies tùy chọn để tránh hộp quyền tự động, còn consent theo origin của sản phẩm vẫn được kiểm tra bật/tắt.

Có thể cấu hình E2E bằng `FLOWDM_BROWSER_EXECUTABLE`, `FLOWDM_FFMPEG` và `FLOWDM_EXECUTABLE`; FFmpeg chỉ dùng xác minh fixture media, không phải phụ thuộc chạy FlowDM. Nguồn fixture: [video/README.md](tests/fixtures/video/README.md). Kết quả bản 0.2 nằm trong [VERIFICATION_V2.md](docs/VERIFICATION_V2.md); [VERIFICATION.md](docs/VERIFICATION.md) là bằng chứng lịch sử 0.1, không phải xác nhận 0.2.

Kiến trúc: `src/core` tải/journal; `src/media` HLS; `src/browser` thiết lập và kiểm tra tiếp nhận; `src/bridge` Native Messaging/IPC; `src/ui` giao diện Electron sandbox. Xem [DESIGN.md](docs/DESIGN.md) và [browser-capture-report.md](docs/browser-capture-report.md).
