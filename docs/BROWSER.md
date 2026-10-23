# Cầu nối trình duyệt FlowDM 0.2

Tiện ích Manifest V3 dành cho Chromium tự chuyển tải HTTP/HTTPS sang FlowDM và cho người dùng chọn tải video. Ứng dụng phải đang mở. Windows đóng gói không cần cài Node.js ngoài.

## Cài và gỡ bằng giao diện

1. Trong FlowDM, mở **Kết nối trình duyệt**, chọn Google Chrome, Microsoft Edge, Chromium hoặc Chrome for Testing tương ứng.
2. Nhấn **Mở thư mục tiện ích** để xuất bản tiện ích đi kèm ứng dụng.
3. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode, chọn **Load unpacked / Tải tiện ích đã giải nén**, rồi chọn đúng thư mục vừa mở.
4. Sao chép ID tiện ích gồm 32 ký tự a–p, dán vào FlowDM và nhấn **Kết nối**. Ghim tiện ích trên thanh công cụ nếu muốn mở popup nhanh.
5. Thử một tệp HTTP/HTTPS. Popup/huy hiệu và danh sách FlowDM hiển thị kết quả; kiểm tra tác vụ trong ứng dụng.

FlowDM chỉ đăng ký native host cho tài khoản hiện tại và đúng ID tiện ích. Trên Windows, ứng dụng tạo bản runtime Electron/Node ở vị trí ổn định trong dữ liệu người dùng; host không phụ thuộc đường dẫn giải nén tạm của portable hoặc Node.js cài riêng. Không đổi trang chủ hay sửa các tiện ích khác.

Để gỡ, chọn đúng trình duyệt rồi **Ngắt kết nối** trong FlowDM và gỡ tiện ích trong trình duyệt. Ngắt kết nối phục hồi đăng ký trước đó khi giá trị hiện tại vẫn thuộc FlowDM; nếu bên khác đã sửa, ứng dụng báo lỗi thay vì ghi đè. Giữ thư mục runtime/bundle khi đang kết nối. Firefox chưa được hỗ trợ. Thiết lập native trên Linux/macOS có mã triển khai nhưng chưa được xác minh native trong đợt này.

Nếu dùng IDM, tắt tích hợp IDM ở trình duyệt dành cho FlowDM trước khi thử tải. Trên máy kiểm thử, IDM còn chặn Chrome thường dù không có tiện ích IDM. Kiểm thử FlowDM đã dùng bản Chrome for Testing đổi tên và profile riêng; không thay đổi IDM hay profile thật của chủ máy.

## Tự bắt tải và dự phòng

**Tự bắt tải xuống HTTP(S)** bật mặc định khi cài tiện ích. Tắt trong popup để trình duyệt tiếp tục tải bình thường; menu chuột phải **Tải bằng FlowDM** vẫn là thao tác chủ động.

Tiện ích bỏ qua incognito, URL blob/data/nội bộ trình duyệt, tải nguy hiểm, tải đã hoàn tất và yêu cầu không phải GET khi nhận diện được. Với tải phù hợp, tiện ích tạm dừng rồi kiểm tra lại trạng thái. Lỗi pause sớm lúc Chromium chưa gán tên tệp được thử lại trong khoảng 400 ms; không lấy quyền sở hữu khi chưa xác nhận pause.

Native host kiểm tra khả năng truy cập trước khi trả ACK: lỗi đăng nhập/HTTP hoặc phản hồi HTML không phù hợp bị từ chối. Thành công chỉ được công nhận khi response khớp request ID và có ID tác vụ đã lưu. Tiện ích chỉ hủy tải gốc nếu nó vẫn đang pause/in-progress sau ACK. Không có ACK hợp lệ, host vắng mặt hoặc timeout sẽ giữ/tiếp tục tải trình duyệt. Lỗi server phát sinh sau khi tác vụ đã được tiếp nhận thuộc hàng đợi FlowDM.

Timeout là kết quả chưa chắc chắn: tác vụ đến muộn có thể trùng lượt tải trình duyệt đã tiếp tục. Mở FlowDM kiểm tra hàng đợi trước khi gửi lại. Nếu người dùng tiếp tục tải hoặc trình duyệt hoàn tất trong lúc bàn giao, tiện ích không hủy kết quả đó.

## Video và quyền đăng nhập

Tiện ích theo dõi video/audio/source động và phản hồi mạng để tìm tệp trực tiếp, HLS `.m3u8` hoặc MIME tương ứng. Player blob có thể dùng manifest tìm từ mạng; bản thân URL blob không được chuyển cho engine. Phát hiện không tự tải media.

Nhấn **Tải video bằng FlowDM** cạnh media hoặc chọn **Tải bằng FlowDM** trong danh sách popup. Nút trên trang chỉ nhận click thật của người dùng; click do JavaScript trang tạo bị bỏ qua. DASH xuất hiện như chẩn đoán chưa hỗ trợ.

HLS chỉ hỗ trợ VOD có ENDLIST, không mã hóa, các đoạn MPEG-TS hoặc fMP4 với một initialization map. Có thể chọn variant từ master; không ghép audio/video phục vụ riêng, không live, DRM/AES, DASH, chuyển mã hay vượt cơ chế bảo vệ website. Tạm dừng/tiếp tục/thử lại HLS tải lại toàn bộ VOD. Xem [media-report.md](media-report.md) để biết các cấu trúc bị từ chối.

Mặc định không chuyển Cookie, Authorization, Referer hoặc User-Agent. Khi cần đăng nhập:

1. Mở popup, chọn **Trang được cấp quyền đăng nhập**. Danh sách gồm origin trang đang mở và origin tài nguyên media/CDN đã phát hiện.
2. Chọn đúng origin của URL tải rồi bật **Cho phép gửi thông tin đăng nhập cho tên miền đã chọn** và chấp thuận quyền cookies tùy chọn khi trình duyệt hỏi. Cấp quyền trang không tự cấp cho CDN khác.
3. Chọn tải lại media. Cookie hiện tại được lấy theo URL; User-Agent trình duyệt được bổ sung khi thiếu. Referer chỉ được chuyển khi đã quan sát thấy header do trình duyệt thực sự gửi; không dựng từ URL trang để tránh làm lộ query hoặc vượt Referrer-Policy. Bearer token chỉ lấy từ yêu cầu mạng đã quan sát sau khi consent, nên có thể phải tải lại trang/phát lại video.

Khi quan sát được Cookie/Authorization mà chưa có consent, tải tự động ở lại trình duyệt. Một số Chromium không cung cấp các header này cho webRequest; kiểm tra truy cập native trước ACK vẫn là lớp quyết định, không suy luận rằng header vắng mặt nghĩa là URL công khai.

Headers chỉ trong bộ nhớ; không ghi vào lịch sử. Bỏ quyền/consent hủy bàn giao còn chờ bằng thế hệ quyền, kể cả khi bật lại ngay. Headers nhạy cảm bị loại khi redirect hoặc tài nguyên chuyển origin. URL có signed query vẫn cần để tải/resume và được lưu trong lịch sử desktop; không chia sẻ thư mục dữ liệu. Danh sách media session có giới hạn và hết hạn, xóa khi điều hướng/đóng tab.

## Kiểm chứng và giao thức

E2E đã chạy trên Windows với Chrome for Testing 156 và Electron thật: native host sinh từ giao diện, capture tự động, tắt capture, host vắng mặt, fallback đăng nhập, consent cookie, video trực tiếp, HLS TS/fMP4 đúng byte và FFmpeg giải mã. Test dùng profile tạm và bản sao tiện ích cấp sẵn API cookies tùy chọn; consent theo origin của sản phẩm vẫn được bật/tắt và kiểm tra. Điều này không chứng minh hộp xin quyền tương tác đã được tự động hóa trên mọi bản Chrome/Edge.

Chạy `npm test`, `npm run test:coverage` và `npm run test:e2e`. `FLOWDM_BROWSER_EXECUTABLE` chọn Chromium thử; `FLOWDM_FFMPEG` chọn bộ giải mã fixture; `FLOWDM_EXECUTABLE` chọn ứng dụng đóng gói. Xem [browser-capture-report.md](browser-capture-report.md) cho contract UI và kiểm thử giả lập; xem [xác minh bản 0.2](VERIFICATION_V2.md).

Native Messaging dùng frame độ dài 4 byte theo byte order máy + JSON UTF-8, tối đa 1 MiB; stdout chỉ chứa frame. Request:

```json
{"schema":1,"request_id":"unique-id","op":"add","payload":{"url":"https://example.com/movie.m3u8","mediaType":"hls"}}
```

Payload còn cho phép `filename` và `headers` giới hạn; `mediaType` là `direct` hoặc `hls`. ACK thành công là `{"request_id":"unique-id","ok":true,"payload":{"id":"task-id"}}`. Trường dư, URL có credentials, scheme khác HTTP(S) hoặc headers ngoài danh sách cho phép bị từ chối.

Host chuyển tới named pipe Windows/Unix socket có secret ngẫu nhiên mỗi phiên; không mở API TCP quản trị. Request ID chống lặp trong bộ nhớ desktop, không phải bảo đảm exactly-once bền vững qua restart. Dùng thư mục dữ liệu riêng của tài khoản, không đặt trên share/public. Không tuyên bố bảo vệ khỏi mã độc chạy cùng tài khoản.
