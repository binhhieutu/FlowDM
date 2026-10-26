# Cầu nối trình duyệt FlowDM 0.9

Tiện ích Chromium Manifest V3 và bản Firefox Manifest V2 riêng tự chuyển tải HTTP/HTTPS sang FlowDM và cho người dùng chọn tải video. Ứng dụng phải đang mở. Windows đóng gói không cần cài Node.js ngoài. Phạm vi kiểm chứng mới nhất: [VERIFICATION_V9.md](VERIFICATION_V9.md).

## Cài và gỡ bằng giao diện

1. Trong FlowDM, mở **Kết nối trình duyệt**, chọn Google Chrome, Microsoft Edge, Chromium hoặc Chrome for Testing tương ứng.
2. Nhấn **Mở thư mục tiện ích** để xuất bản tiện ích đi kèm ứng dụng.
3. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode, chọn **Load unpacked / Tải tiện ích đã giải nén**, rồi chọn đúng thư mục vừa mở.
4. Sao chép ID tiện ích gồm 32 ký tự a–p, dán vào FlowDM và nhấn **Kết nối**. Ghim tiện ích trên thanh công cụ nếu muốn mở popup nhanh.
5. Thử một tệp HTTP/HTTPS. Popup/huy hiệu và danh sách FlowDM hiển thị kết quả; kiểm tra tác vụ trong ứng dụng.

Với Firefox, chọn **Mozilla Firefox** trong FlowDM rồi xuất thư mục riêng `browser-extension-firefox`. Mở `about:debugging#/runtime/this-firefox`, chọn **Load Temporary Add-on** và chọn `manifest.json` trong thư mục đó. ID `flowdm@local.invalid` đã điền sẵn; nhấn **Kết nối**. Bản unsigned nạp tạm phải được nạp lại sau khi đóng Firefox; ký/phân phối là Task 10. Chromium và Firefox không dùng chung manifest hoặc ghi đè thư mục tiện ích của nhau.

**Nâng cấp lên 0.9:** xuất lại tiện ích, Reload (hoặc nạp lại Firefox), rồi ngắt/kết nối lại native host trong FlowDM. Host cũ không nhận các thao tác cấp lại phiên mới dù việc tải thông thường vẫn hoạt động.

Khi nâng cấp từ 0.3 hoặc cũ hơn, hãy ngắt/kết nối lại native host trong FlowDM, xuất lại thư mục tiện ích, rồi nhấn **Reload / Tải lại** cho tiện ích unpacked. Giao thức 0.4 thêm trường `connections`; dùng lẫn host và tiện ích cũ/mới có thể làm mất lựa chọn 1/2/4/8/16 của popup. Khi nâng cấp từ 0.4 lên 0.5, cũng xuất lại tiện ích, Reload và kết nối lại native host để dùng đúng bundle mới.

FlowDM chỉ đăng ký native host cho tài khoản hiện tại và đúng ID tiện ích. Trên Windows, ứng dụng tạo bản runtime Electron/Node ở vị trí ổn định trong dữ liệu người dùng; host không phụ thuộc đường dẫn giải nén tạm của portable hoặc Node.js cài riêng. Không đổi trang chủ hay sửa các tiện ích khác.

Để gỡ, chọn đúng trình duyệt rồi **Ngắt kết nối** trong FlowDM và gỡ tiện ích trong trình duyệt. Ngắt kết nối phục hồi đăng ký trước đó khi giá trị hiện tại vẫn thuộc FlowDM; nếu bên khác đã sửa, ứng dụng báo lỗi thay vì ghi đè. Giữ thư mục runtime/bundle khi đang kết nối. Firefox Windows chỉ sở hữu khóa Mozilla native host trong view32 HKCU, khôi phục giá trị trước đó và giữ view64 nguyên trạng. Thiết lập Linux/macOS có mã triển khai nhưng chưa được xác minh native.

Nếu dùng IDM, tắt tích hợp IDM ở trình duyệt dành cho FlowDM trước khi thử tải. Trên máy kiểm thử, IDM còn chặn Chrome thường dù không có tiện ích IDM. Kiểm thử FlowDM đã dùng bản Chrome for Testing đổi tên và profile riêng; không thay đổi IDM hay profile thật của chủ máy.

## Tự bắt tải và dự phòng

**Tự bắt tải xuống HTTP(S)** bật mặc định khi cài tiện ích. Tắt trong popup để trình duyệt tiếp tục tải bình thường; menu chuột phải **Tải bằng FlowDM** vẫn là thao tác chủ động.

Tiện ích bỏ qua incognito, URL blob/data/nội bộ trình duyệt, tải nguy hiểm, tải đã hoàn tất và yêu cầu không phải GET khi nhận diện được. Chromium tạm dừng rồi kiểm tra lại trạng thái; lỗi pause sớm lúc chưa gán tên tệp được thử lại trong khoảng 400 ms. Firefox giữ lượt tải trình duyệt đang chạy trong lúc chờ ACK: pause của Firefox có thể trở thành hủy khi chưa có partial, nên không áp dụng bước pause của Chromium.

Native host kiểm tra khả năng truy cập trước khi trả ACK: lỗi đăng nhập/HTTP hoặc phản hồi HTML không phù hợp bị từ chối. Thành công chỉ được công nhận khi response khớp request ID và có ID tác vụ đã lưu. Chromium chỉ hủy lượt gốc còn paused/in-progress; Firefox kiểm tra lại URL/trạng thái an toàn/quyền, chỉ hủy lượt vẫn đang chạy sau ACK và xác minh trạng thái hủy thực tế. Không có ACK hợp lệ, host vắng mặt hoặc timeout sẽ giữ/tiếp tục lượt trình duyệt. Firefox có thể truyền dữ liệu đồng thời trong lúc bàn giao; nếu trình duyệt đã hoàn tất hoặc ACK đến muộn, có thể có hai lượt tải. Lỗi server sau khi tác vụ được tiếp nhận thuộc hàng đợi FlowDM.

Timeout là kết quả chưa chắc chắn: tác vụ đến muộn có thể trùng lượt tải trình duyệt đã tiếp tục. Mở FlowDM kiểm tra hàng đợi trước khi gửi lại. Nếu người dùng tiếp tục tải hoặc trình duyệt hoàn tất trong lúc bàn giao, tiện ích không hủy kết quả đó.

## Video, DASH, YouTube và quyền đăng nhập

Tiện ích theo dõi video/audio/source động và phản hồi mạng để tìm tệp trực tiếp, HLS `.m3u8`, DASH `.mpd`/MIME tương ứng, và URL YouTube chuẩn. Player blob có thể dùng manifest tìm từ mạng hoặc nút YouTube của trang; bản thân URL blob không được chuyển cho engine. Phát hiện không tự tải media.

Nhấn **Tải video bằng FlowDM** cạnh media hoặc nút YouTube trên trang, hay chọn **Tải bằng FlowDM** trong danh sách popup. Nút trên trang chỉ nhận click thật của người dùng; click do JavaScript trang tạo bị bỏ qua. Dán URL MPD hoặc URL YouTube công khai vào FlowDM cũng tự nhận loại tải.

Popup cho phép chọn tối đa 1/2/4/8/16 kết nối cho lượt bàn giao tiếp theo và lưu lựa chọn này. Đây là mức trần: tệp nhỏ, playlist ít đoạn hoặc server/CDN hạn chế có thể tạo ít request song song hơn. HLS dùng cửa sổ worker hữu hạn và ghép đúng thứ tự qua đĩa; DASH dùng fragment downloader native của yt-dlp. Không có tài nguyên nào đồng thời bị nhân song song qua hai tầng.

HLS chỉ hỗ trợ VOD có ENDLIST, không mã hóa, các đoạn MPEG-TS hoặc fMP4 với một initialization map. Có thể chọn variant từ master. DASH chỉ hỗ trợ MPD tĩnh không DRM qua HTTP(S), video/audio tách riêng và ghép MP4; từ chối live, DRM/mã hóa, CDATA, tham chiếu namespace/remote, byte range và cấu trúc ngoài parser hiện có. Tác vụ mới giữ các fragment đã hoàn tất bằng checkpoint qua tạm dừng và đóng/mở bình thường. HLS đối chiếu SHA-256 của manifest media và từng tệp cache; DASH đối chiếu bytes MPD cùng trạng thái native. Tiếp tục dựng lại đầu ra từ cache đã kiểm tra, chỉ tải các fragment còn thiếu/dở.

YouTube chỉ nhận video công khai ở `youtube.com/watch`, `youtube.com/shorts`, `youtu.be` và dạng mobile được chuẩn hóa về URL video tương ứng. Mặc định ưu tiên HLS native H.264 tối đa1080p; aria2 tải AAC/M4A qua HTTP và tệp HTTP thông thường khi phải fallback, sau đó FFmpeg ghép MP4. Từ0.8 có bộ chọn chính xác chất lượng/codec/audio/phụ đề/playlist trong **Thêm liên kết** của desktop; 4K đã được thử bằng DASH do dự án tạo, YouTube công khai đã thử1080p. Không hỗ trợ video đăng nhập/private, age wall, DRM, live, PO token, plugin hay cách vượt bảo vệ website. YouTube trích xuất metadata mới, đối chiếu định dạng/cấu trúc HLS trước khi dùng lại fragment. Fragment hoàn tất giữ qua mở lại app; fragment dở và âm thanh HTTP thiếu validator có thể tải lại riêng. Nguồn/định dạng đổi hoặc cache hỏng/thiếu sẽ báo lỗi và giữ dữ liệu.

Mặc định không chuyển Cookie, Authorization, Referer hoặc User-Agent. Khi cần đăng nhập:

1. Mở popup, chọn **Trang được cấp quyền đăng nhập**. Danh sách gồm origin trang đang mở và origin tài nguyên media/CDN đã phát hiện.
2. Chọn đúng origin của URL tải rồi bật **Cho phép gửi thông tin đăng nhập cho tên miền đã chọn** và chấp thuận quyền cookies tùy chọn khi trình duyệt hỏi. Cấp quyền trang không tự cấp cho CDN khác.
3. Chọn tải lại media. Cookie hiện tại được lấy theo URL; User-Agent trình duyệt được bổ sung khi thiếu. Referer chỉ được chuyển khi đã quan sát thấy header do trình duyệt thực sự gửi; không dựng từ URL trang để tránh làm lộ query hoặc vượt Referrer-Policy. Bearer token chỉ lấy từ yêu cầu mạng đã quan sát sau khi consent, nên có thể phải tải lại trang/phát lại video.

Khi quan sát được Cookie/Authorization mà chưa có consent, tải tự động ở lại trình duyệt. Một số Chromium không cung cấp các header này cho webRequest; kiểm tra truy cập native trước ACK vẫn là lớp quyết định, không suy luận rằng header vắng mặt nghĩa là URL công khai. DASH và YouTube luôn bỏ mọi header trình duyệt, gồm Cookie, Authorization, Referer và User-Agent, kể cả khi origin đã được cấp quyền.

Headers chỉ trong bộ nhớ; không ghi vào lịch sử. Bỏ quyền/consent hủy bàn giao còn chờ bằng thế hệ quyền, kể cả khi bật lại ngay. Headers nhạy cảm bị loại khi redirect hoặc tài nguyên chuyển origin. URL có signed query vẫn cần để tải/resume và được lưu trong lịch sử desktop; không chia sẻ thư mục dữ liệu. Danh sách media session có giới hạn và hết hạn, xóa khi điều hướng/đóng tab.

Khi phần âm thanh hoặc fallback HTTP dùng aria2, URL CDN có chữ ký do yt-dlp trích xuất được truyền trong command line của tiến trình con trong thời gian tải. Tiến trình cùng tài khoản hoặc quyền cao hơn có thể quan sát nó. FlowDM không ghi URL CDN trích xuất vào metadata của ứng dụng, journal, log, lỗi, giao diện, ảnh chụp hoặc bằng chứng kiểm thử. Cache riêng còn chứa tệp trạng thái native của công cụ tải và có thể chứa URL nhạy cảm; không chia sẻ thư mục này. Đóng bình thường chờ tiến trình con và checkpoint hoàn tất; không có cam kết phục hồi mọi trường hợp mất điện hoặc kill cưỡng bức. Fragment được giữ làm tăng dung lượng đĩa tạm; workspace engine ngoài có trần ba lần giới hạn kích thước tác vụ.

## Cấp lại phiên sau khi mở lại FlowDM

1. Tạm dừng tác vụ HTTP/HLS rồi nhấn **Kết nối lại từ trình duyệt** trong FlowDM.
2. Mở trang đúng origin của tài nguyên bằng phiên đã đăng nhập. Trong popup, bật quyền cho origin đó rồi nhấn **Tìm tác vụ cần kết nối lại**.
3. Chọn đúng tên tệp và nhấn **Kết nối lại**. Sau xác nhận, về FlowDM nhấn **Tiếp tục**.

Yêu cầu hiệu lực2 phút, tối đa8 yêu cầu chờ; nhấn lại trong desktop thay yêu cầu cũ của cùng tác vụ. Tiện ích kiểm tra quyền và tab hiện tại trước/sau khi lấy Cookie và sau preflight; dùng hai bước prepare/commit. Cả headers và nonce chỉ ở RAM, không lưu vào journal/browser storage. HTTP phải còn đúng identity/range; HLS phải còn đúng manifest/cache. Không tự đổi nguồn, chất lượng, byte hoặc taskID, không tự resume. Nếu quyền đổi trước khi dispatch commit sẽ không commit; thu hồi quyền sau đó không thể rút lại credentials đã gửi/gắn vào tác vụ. Authenticated DASH/YouTube vẫn bị chặn rõ `blocked-by-adapter`.

## Kiểm chứng và giao thức

Bằng chứng lịch sử 0.4 đã chạy nguồn trên Windows với Chromium/Electron thật: native host sinh từ giao diện, capture, lựa chọn kết nối, video trực tiếp, HLS TS/fMP4, DASH và YouTube công khai. Big Buck Bunny N=4 tải trong 21,258 giây; toàn bộ E2E gồm xác minh mất 49,787 giây. Video dài 634,624 giây, 288.972.332 byte, H.264 1920×1080/AAC và qua bước giải mã toàn bộ riêng bằng FFmpeg. Fixture cục bộ 400 ms/tài nguyên đo HLS N=1 1.317 ms/peak 1, N=4 457 ms/peak 3; DASH N=1 5.132 ms/peak 1, N=4 2.862 ms/peak 4, đầu ra byte-exact. Đây không phải cam kết tốc độ trên mọi máy/CDN. Test dùng profile tạm; chưa có xác minh media native Linux/macOS. Bản 0.5 bổ sung checkpoint và journal v4 đọc v1–v3; tác vụ cũ không được coi là đã có cache resumable. Xem kết quả pause/đóng/mở/tiếp tục và giới hạn ở [VERIFICATION_V5.md](VERIFICATION_V5.md); các số đo 0.4 chỉ là lịch sử.

Windows đóng gói kèm yt-dlp 2026.10.21, FFmpeg 8.1 và aria2 1.37.0 đã ghim hash, không cần Node.js ngoài. Source ZIP không kèm binary; chuẩn bị bundle Windows bằng `node scripts/prepare-media-tools.cjs "C:\đường-dẫn\ffmpeg.exe"`. Linux/macOS cần `yt-dlp`, `ffmpeg` và `aria2c` trên `PATH` và chưa chạy kiểm thử media native. CI so hash ghim và từ chối binary khác.

Chạy `npm test`, `npm run test:coverage` và `npm run test:e2e`. `FLOWDM_BROWSER_EXECUTABLE` chọn Chromium thử; `FLOWDM_FFMPEG` chọn bộ giải mã fixture; `FLOWDM_EXECUTABLE` chọn ứng dụng đóng gói. Xem [browser-capture-report.md](browser-capture-report.md) cho contract UI và kiểm thử giả lập; xem [xác minh bản 0.5](VERIFICATION_V5.md).

Native Messaging dùng frame độ dài 4 byte theo byte order máy + JSON UTF-8, tối đa 1 MiB; stdout chỉ chứa frame. Request:

```json
{"schema":1,"request_id":"unique-id","op":"add","payload":{"url":"https://example.com/movie.m3u8","mediaType":"hls","connections":4}}
```

Payload còn cho phép `filename`, `headers` giới hạn và `connections` là số nguyên 1–16; `mediaType` là `direct`, `hls`, `dash` hoặc `youtube`. DASH/YouTube không nhận browser headers. ACK thành công là `{"request_id":"unique-id","ok":true,"payload":{"id":"task-id"}}`. Trường dư, URL có credentials, scheme khác HTTP(S), giá trị kết nối ngoài giới hạn hoặc headers ngoài danh sách cho phép bị từ chối.

Host chuyển tới named pipe Windows/Unix socket có secret ngẫu nhiên mỗi phiên; không mở API TCP quản trị. Request ID chống lặp trong bộ nhớ desktop, không phải bảo đảm exactly-once bền vững qua restart. Dùng thư mục dữ liệu riêng của tài khoản, không đặt trên share/public. Không tuyên bố bảo vệ khỏi mã độc chạy cùng tài khoản.

0.9 thêm `credentialRequests` (origin), `rebindCredentials` (taskId/origin/requestId/headers, chỉ chuẩn bị), `commitCredentials` và `cancelCredentials` (cùng binding, không headers). `requestId` của challenge khác `request_id` của từng frame. Cache replay tính cả operation và payload. Preflight được abort khi hết hạn hoặc client ngắt trong lúc chờ; commit kiểm tra binding/state và rollback nếu lưu journal thất bại. Các ACK không chứa headers.

### Nâng cấp 0.10

Journal desktop chuyển schema7 (tasks+queues); sao lưu tự động nguyên byte bản cũ trước ghi. Không mở state mới bằng FlowDM0.9/cũ hơn. Handoff trình duyệt và playlist mặc định vào queue Default; chuyển sang queue khác trong desktop sau khi dừng. Không thêm trường queue vào giao thức extension/native. Xuất/Reload tiện ích và kết nối lại host để dùng cùng bundle0.10. Xem [queue và lịch lặp](VERIFICATION_V10.md).

### Link trên trang — 0.11

Xuất/Reload tiện ích và ngắt/kết nối lại native host để cập nhật operation previewBatch. Trong popup nhấn Lấy link trên trang, lọc/chọn (mặc định unchecked), rồi Xem trước trong FlowDM. Chỉ thu anchor của tab HTTP(S) hiện tại, không incognito/credentials. Desktop chỉ mở text preview, phải chọn/submit tiếp mới tạo job; nativepayload≤1000URL/512KiB, mỗiURL≤16384ký tự. Trang thay đổi thì lấy lại. SiteGrabber desktop độc lập, không dùng phiên browser và không chạy JS. [Báo cáo0.11](VERIFICATION_V11.md).
