# FlowDM 0.4

Kiểm chứng bản 0.4 và các giới hạn nền tảng: [VERIFICATION_V4.md](docs/VERIFICATION_V4.md).

Ứng dụng tải HTTP/HTTPS desktop với tiện ích Chromium tự bắt tải xuống và chọn tải video HLS VOD, DASH tĩnh giới hạn và YouTube công khai. Mã nguồn và nhận diện riêng; không dùng mã hay tài sản IDM và không tuyên bố đủ mọi tính năng IDM.

## Dùng trên Windows

Mở `dist/FlowDM 0.4.0.exe` hoặc `dist/win-unpacked/FlowDM.exe`. Bản Windows đóng gói không cần cài Node.js; kèm yt-dlp 2026.10.21, FFmpeg 8.1 và aria2 1.37.0 đã ghim hash cùng giấy phép trong private artifact. Nhấn **Thêm liên kết** để chọn URL, thư mục, tên tệp và số kết nối tối đa 1/2/4/8/16 cho mỗi lượt tải. Có tạm dừng/tiếp tục, hủy/thử lại, tìm kiếm/lọc, hẹn giờ, giới hạn tốc độ và SHA-256 sau tải. Không tự mở hay chạy tệp tải về; không ghi đè tệp có sẵn.

Tải tệp trực tiếp nhiều kết nối và resume giữ byte cần server hỗ trợ Range và validator an toàn. Khi không thể xác minh cùng phiên bản, ứng dụng tải lại an toàn hoặc báo lỗi thay vì trộn dữ liệu. HLS dùng tối đa số worker đã chọn, giữ một cửa sổ trượt hữu hạn và ghép các đoạn đúng thứ tự qua tệp tạm trên đĩa; không giữ toàn bộ video trong RAM. DASH dùng tải fragment native của yt-dlp với cùng giới hạn kết nối. HLS/DASH tiếp tục hoặc thử lại từ đầu toàn bộ video. Hủy xóa dữ liệu tạm; xóa lịch sử không xóa tệp đã hoàn tất.

Giới hạn tốc độ tính theo từng lượt tải, đơn vị KiB/s. Lịch hẹn dùng giờ máy; máy và FlowDM phải đang hoạt động. Không có dịch vụ nền tự đánh thức máy.

## Kết nối trình duyệt

1. Mở **Kết nối trình duyệt** trong FlowDM, chọn Chrome/Edge/Chromium phù hợp rồi nhấn **Mở thư mục tiện ích**.
2. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode, chọn **Load unpacked / Tải tiện ích đã giải nén** và chọn thư mục vừa xuất.
3. Sao chép ID 32 ký tự của tiện ích, dán vào FlowDM và nhấn **Kết nối**. Giữ ứng dụng đang mở.

Windows dùng runtime Electron/Node được sao chép vào vị trí ổn định dành cho native host; không cần Node.js ngoài. Đăng ký chỉ áp dụng cho tài khoản hiện tại. **Ngắt kết nối** hoàn lại đăng ký trước đó nếu mục đăng ký vẫn do FlowDM quản lý. Xem [hướng dẫn trình duyệt](docs/BROWSER.md).

Khi nâng cấp từ 0.3 hoặc bản cũ hơn, trường `connections` mới đã được thêm vào giao thức Native Messaging. Mở **Kết nối trình duyệt**, ngắt/kết nối lại native host, xuất lại thư mục tiện ích rồi nhấn **Reload / Tải lại** cho tiện ích unpacked trong `chrome://extensions` hoặc `edge://extensions`. Nếu bỏ qua bước này, bản tiện ích/host cũ có thể không chuyển đúng lựa chọn số kết nối.

Tự bắt tải HTTP(S) bật mặc định khi cài tiện ích và có thể tắt trong popup. Trình duyệt chỉ hủy lượt tải sau khi FlowDM kiểm tra truy cập, lưu tác vụ và trả xác nhận đúng ID. Cầu nối vắng mặt, lỗi truy cập/đăng nhập, phản hồi HTML không phù hợp hoặc hết thời gian chờ sẽ giữ/tiếp tục lượt tải trình duyệt. Timeout vẫn có thể tạo một tác vụ đến muộn; kiểm tra hàng đợi trước khi gửi lại.

Cookie, Authorization, Referer và User-Agent mặc định không được chuyển. Nếu cần đăng nhập, mở popup, chọn đúng tên miền của trang hoặc tài nguyên/CDN rồi bật quyền rõ ràng. Cookie được lấy theo URL với quyền tùy chọn; bearer token cần một yêu cầu mạng mới sau khi cấp quyền. Headers chỉ ở bộ nhớ và bị bỏ khi chuyển sang origin khác.

Tiện ích nhận diện video/audio/source động và các manifest mạng, kể cả player dùng blob. Nhấn **Tải video bằng FlowDM** cạnh media, nút YouTube trên trang, hoặc chọn mục trong popup; dán MPD/URL YouTube cũng tự nhận dạng loại phù hợp. Phát hiện media không tự tải mọi luồng. Hỗ trợ tệp trực tiếp, HLS VOD không mã hóa dạng MPEG-TS/fMP4, và DASH tĩnh không DRM có video/audio tách riêng để ghép MP4.

YouTube chỉ dành cho video công khai ở URL chuẩn `watch`, `shorts`, `youtu.be` hoặc bản mobile tương ứng. Mặc định ưu tiên video HLS native H.264 tối đa 1080p; aria2 tải phần âm thanh AAC/M4A qua HTTP và tải tệp HTTP thông thường khi phải dùng fallback, sau đó FFmpeg ghép MP4. Chưa có bộ chọn chất lượng và không hứa tải 4K. Không hỗ trợ DRM, live, video cần đăng nhập/age wall, PO token, plugin hoặc cơ chế vượt bảo vệ. DASH chỉ là tập con tĩnh: từ chối DRM, live, CDATA, tham chiếu namespace/remote, byte range và các manifest phức tạp ngoài parser hiện có. HLS/DASH/YouTube tạm dừng hoặc thử lại sẽ tải lại toàn bộ để tránh ghép sai nội dung. DASH/YouTube không gửi Cookie, Authorization, Referer hay User-Agent. Xem [phạm vi media](docs/media-report.md).

Nếu đang dùng IDM, tắt tích hợp IDM cho trình duyệt dùng FlowDM để tránh hai trình quản lý cùng bắt một tải. Kiểm thử thấy IDM vẫn can thiệp Chrome thường dù đã bỏ tiện ích IDM. Không cần thay đổi profile thật để thử bản này.

## Dữ liệu và tương thích

- `downloads.json` và dữ liệu tạm nằm ở `app.getPath('userData')/state`; đích mặc định là `Downloads/FlowDM`. Có thể đặt `FLOWDM_DATA_DIR` và `FLOWDM_DOWNLOAD_DIR` bằng đường dẫn tuyệt đối.
- URL, gồm signed query/token cần để resume, được lưu trong lịch sử. Không chia sẻ thư mục dữ liệu. Headers nhạy cảm không được lưu; tải cần đăng nhập có thể phải thêm lại sau khi khởi động.
- Với phần âm thanh hoặc fallback HTTP qua aria2, URL media CDN có chữ ký do yt-dlp trích xuất xuất hiện trong command line của tiến trình con trong thời gian tiến trình chạy và có thể được tiến trình cùng tài khoản hoặc quyền cao hơn quan sát. FlowDM không sao chép URL đó vào journal, log, giao diện, lỗi, ảnh hoặc bằng chứng test.
- Journal 0.4 tiếp tục ghi schema v3 và đọc được schema v1/v2. Sao lưu thư mục dữ liệu trước khi nâng cấp nếu cần quay lại binary cũ.
- Giới hạn mặc định 100 GiB/tệp, ba lượt tải đồng thời, tối đa ba lượt/host; UI chọn 1/2/4/8/16 kết nối. Đây là mức trần theo lượt tải; tệp nhỏ, playlist ít đoạn hoặc server/CDN hạn chế Range có thể dùng ít kết nối hơn. Server không hỗ trợ Range dùng một luồng. Cần chỗ trống cho dữ liệu tạm và tệp cuối.
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

Đóng gói bằng `npm run dist:win`, `npm run dist:linux` hoặc `npm run dist:mac`. Windows là nền tảng đã chạy kiểm thử desktop và trình duyệt thật; báo cáo 0.4 sẽ ở [VERIFICATION_V4.md](docs/VERIFICATION_V4.md). Linux x64/macOS có quy trình build nhưng chức năng media 0.4 chưa được chạy native trên hai hệ điều hành đó. Linux cần thư viện Electron, X11/Wayland và sandbox hoạt động; không tắt sandbox hoặc chạy root để bỏ qua lỗi môi trường. Bản chưa ký/notarize có thể cần phê duyệt theo chính sách hệ điều hành.

Source ZIP không kèm `vendor/media-tools`. Khi chuẩn bị bản Windows từ nguồn, dùng lệnh rõ ràng `node scripts/prepare-media-tools.cjs "C:\đường-dẫn\ffmpeg.exe"`; script chỉ chấp nhận FFmpeg 8.1 full build Gyan đúng hash và tải yt-dlp/aria2 đã ghim phiên bản/hash. Linux/macOS cần tự cài `yt-dlp`, `ffmpeg` và `aria2c` trên `PATH`; có thể dùng biến đường dẫn tuyệt đối `FLOWDM_YTDLP`, `FLOWDM_FFMPEG` và `FLOWDM_ARIA2C` khi chạy từ nguồn. Chưa có kiểm thử media native hai nền tảng này. CI đối chiếu hash đã ghim và sẽ từ chối binary khác; việc build archive trong CI không phải bằng chứng runtime native.

E2E trình duyệt thật dùng Chrome for Testing 156 và Electron, kiểm tra tự bắt tải, tắt bắt tải, host vắng mặt, đăng nhập khi chưa/có consent, nút media chống click giả, byte tệp trực tiếp/HLS TS/fMP4 và giải mã bằng FFmpeg. Profile thử dùng bản Chromium được đổi tên để tránh hook IDM; IDM và profile thật của chủ máy không bị chỉnh sửa. Bản sao tiện ích thử được cấp sẵn API cookies tùy chọn để tránh hộp quyền tự động, còn consent theo origin của sản phẩm vẫn được kiểm tra bật/tắt.

Có thể cấu hình E2E bằng `FLOWDM_BROWSER_EXECUTABLE`, `FLOWDM_FFMPEG` và `FLOWDM_EXECUTABLE`; FFmpeg trong biến này dùng xác minh fixture media. Kiểm thử nguồn 0.4 trên Windows đã tải Big Buck Bunny công khai từ YouTube ở N=4 trong 21,258 giây; toàn bộ E2E gồm xác minh hoàn tất trong 49,787 giây. Video dài 634,624 giây, 288.972.332 byte, H.264 1920×1080/AAC và qua bước giải mã toàn bộ riêng bằng FFmpeg. Fixture cục bộ có độ trễ 400 ms mỗi tài nguyên cho kết quả byte-exact: HLS N=1 mất 1.317 ms/peak 1, N=4 mất 457 ms/peak 3; DASH N=1 mất 5.132 ms/peak 1, N=4 mất 2.862 ms/peak 4. Đây là số đo của fixture/máy kiểm thử, không phải cam kết tăng tốc trên mọi server, CDN hoặc hệ điều hành. [VERIFICATION_V3.md](docs/VERIFICATION_V3.md), [VERIFICATION_V2.md](docs/VERIFICATION_V2.md) và [VERIFICATION.md](docs/VERIFICATION.md) là bằng chứng lịch sử, không phải xác nhận 0.4.

Kiến trúc: `src/core` tải/journal; `src/media` HLS; `src/browser` thiết lập và kiểm tra tiếp nhận; `src/bridge` Native Messaging/IPC; `src/ui` giao diện Electron sandbox. Xem [DESIGN.md](docs/DESIGN.md) và [browser-capture-report.md](docs/browser-capture-report.md).
