# FlowDM 0.9.0 — cấp lại phiên trình duyệt và Firefox

Ngày 2026-10-26 (Asia/Saigon). Baseline `9e7fd2a`. **Hoàn tất Task 5 theo phạm vi plan và kiểm tra hồi quy đổi kết nối đang tải.** [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md) · [Review](browser-rebind-v9-review.md) · [Bằng chứng](evidence/v0.9/summary.json).

## Khả năng và cách dùng

Tác vụ HTTP/HLS đã dừng có nút **Kết nối lại từ trình duyệt**. Mở trang đúng origin bằng phiên đã đăng nhập, bật quyền tương ứng trong popup FlowDM, nhấn **Tìm tác vụ cần kết nối lại** rồi **Kết nối lại**. Sau xác nhận, về desktop nhấn **Tiếp tục**. Giữ ID, đích lưu, byte/đoạn, số kết nối và identity của nguồn; không tự resume. Nguồn/validator/manifest đổi sẽ bị từ chối và giữ dữ liệu dở.

Yêu cầu bắt đầu từ desktop, có hiệu lực 2 phút, tối đa 8 yêu cầu chờ và mỗi tác vụ chỉ giữ yêu cầu mới nhất. Prepare kiểm tra truy cập/nội dung trước; popup kiểm tra lại tab hiện tại, consent và quyền rồi mới gửi commit. Headers và nonce chỉ ở RAM, không ghi journal/browser storage. Native timeout/ngắt kết nối khi đang chuẩn bị sẽ abort công việc. Commit kiểm tra lại trạng thái và rollback khi journal lỗi. Điểm chấp thuận là lần kiểm tra quyền cuối trước dispatch commit; thu hồi sau đó không thể rút lại credentials đã gửi/gắn. Authenticated DASH/YouTube vẫn `blocked-by-adapter`.

Firefox có manifest MV2/thư mục xuất riêng, Gecko ID cố định và native manifest `allowed_extensions`. Windows sở hữu riêng khóa Mozilla HKCU view32, khôi phục nguyên giá trị trước đó và giữ view64; Chromium tiếp tục dùng view64 của từng browser. Addon unsigned được nạp tạm và phải nạp lại sau khi đóng Firefox; ký/phân phối thuộc Task 10. [Hướng dẫn cài và nâng cấp](BROWSER.md). Khi lên 0.9 phải xuất/Reload tiện ích và ngắt/kết nối lại native host để cập nhật các operation mới. Journal tiếp tục schema6, không nâng schema thêm.

Chromium giữ bước pause → ACK → cancel. Firefox giữ tải trình duyệt đang chạy đến khi ACK khớp tác vụ đã lưu, kiểm tra lại URL/trạng thái/quyền rồi mới cancel và xác minh trạng thái hủy. Cách này tránh pause của Firefox trở thành hủy khi chưa có partial; đổi lại có byte truyền đồng thời và có thể tải trùng khi browser hoàn tất hoặc ACK đến muộn. Không nới kiểm tra safe/incognito/GET.

## Kiểm thử cuối

| Phạm vi | Kết quả |
|---|---|
| Unit/integration | **286/286 pass**, 0 fail/skip; desktop tổng quát 1/1 và local media-selection 1/1 |
| Coverage toàn src/extension | **96,15% lines/statements; 86,30% branches; 93,48% functions** |
| Audit | **0 vulnerabilities**, không đổi dependency versions |
| Chromium thực, Windows packaged0.9 | **1/1 exit0**, 26,80s; HTTP/HLS capture → pause → app restart → rotate cookie → popup rebind → manual resume; sameID/N1, SHA và full decode |
| Firefox149.0.2 thực, Windows packaged0.9 | **1/1 exit0**, 27,93s; cùng luồng HTTP/HLS; xác minh lượt Firefox gốc bị hủy USER_CANCELED/không paused sau native handoff |
| Headers/privacy/fallback | Không cookie value/challenge nonce trong journal/browser storage; host-down và chưa consent giữ browser download byte-exact; đăng ký Chrome/testing/chromium và Firefox32/64 khôi phục đúng |
| Browser hồi quy cũ, packaged0.9 | **1/1 exit0**, 21,70s; auto capture, disabled fallback, click giả bị chặn, direct video, HLS TS/fMP4, DASH, consent và host-down/full decode |
| Live-N/media/refresh, packaged0.9 | **5/5 pass**, 5 YouTube/playlist opt-in skip; HTTP dynamic/slow-tail, publicHTTP, HLS/DASH1→4→1/relaunch, DASH4K/audio-only và refresh HTTP/HLS/DASH đều đạt |
| Portable launcher | HTTP2MiB pause/relaunch/resume đúng bytes/SHA; bundled media tools verified; exit0 |
| Integrity | Windows/Linux ASAR khớp **50 file** src/assets/extension; 3 tool Windows đúng pin/hash |

Chromium giữ HTTP **81920 B**, Firefox giữ **65536 B** qua mở lại; file cuối 2097152 B, SHA `411e416f231a38296893d772490a30eaf07fcb6026a714934db87e95a30544db`. Cả hai giữ HLS **15416 B**, file cuối 47188 B, SHA `8fd49049fe73583d0e179541f59b57090178a412cd8676250cabbcb6f0bfbc4e`. Server log xác minh không yêu cầu lại byte/TS đã commit; FFmpeg giải mã toàn bộ. Core còn kiểm tra đổi N1→4→1 ngay sau cấp lại cookie và tiếp tục HTTP.

Video Internet công khai [Sintel trailer trên W3C](https://media.w3.org/2010/05/sintel/trailer.mp4) tải bằng đúng bản packaged0.9: N1→4→1 → pause → đóng/mở → resume; giữ **155819 B**, file4372373 B, SHA `b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254`; khớp nguyên byte bản tải liên tục độc lập và full decode. Không có server request log của W3C; bằng chứng không replay lấy từ fixture do dự án kiểm soát.

HLS/DASH fixture đổi1→4→1 có server peak4 và tài nguyên đã commit GET đúng một lần; output khớp baseline và full decode. 4K là DASH H.2643840×2160 do dự án tạo; không phải thử YouTube4K. Các lượt YouTube công khai0.8 là lịch sử, không chạy lại trong gate0.9. [HTTP dynamic](evidence/v0.9/http-dynamic-packaged.json), [publicHTTP](evidence/v0.9/http-live-public-packaged.json), [media liveN](evidence/v0.9/media-live-packaged.json), [4K/audio](evidence/v0.9/media-selection-packaged.json), [source refresh](evidence/v0.9/source-refresh-packaged.json).

Thử cấp lại phiên dùng server HTTP kiểm soát với video MP4/TS thật và cookie HttpOnly luân chuyển; trình duyệt/native host/network đều chạy thật. Không dùng tài khoản đăng nhập của website bên thứ ba. Profile thử cấp sẵn API cookies để tránh hộp quyền khi tự động hóa, nhưng consent theo origin vẫn được bật/tắt và kiểm tra. Source browser reports ban đầu ghi0.8.0 trước đổi metadata; packaged reports ghi thực tế0.9.0.

## Review và các lỗi bắt được

Review độc lập ban đầu không thấy P1/P2 có thể tái hiện; reviewer chạy riêng **34/34** test mới. Sau phát hiện khác biệt Firefox, review riêng delta ownership/manifest và chạy độc lập **17/17 Firefox**, **23/23 Chromium capture**, không có finding mới. Các lượt RED/GREEN còn kiểm tra thiếu API/service/operation, alias task/origin, expiry/replay, abort/rollback và MIME HTML có whitespace.

Firefox thực phát hiện ba khác biệt đã sửa: namespace Promise `browser` so với callback `chrome`, optional origin patterns của MV2, và pause là cancellation khi chưa có partial. Lượt unit rộng đầu274/275 chỉ thiếu contentType trong assertion DTO cũ; fixture được cập nhật với header video/mp4 và expected field tương ứng. Gate coverage đầu285/286 phát hiện counter của fixture aria2 còn đếm response đã đóng đến timer gửi kế tiếp; đổi counter theo close và dừng timer, giữ nguyên assertion maxN. Lượt coverage cuối286/286 đạt. Không sửa runtime để né các assertion này.

## Artifact và giới hạn

Windows: `dist/FlowDM 0.9.0.exe`, 263179670 B; SHA-256 `fa88fb5f6f620a45bce4ef9a1c85103160605acc251044c5436dd211e167bc5c`. Checksum: `dist/FlowDM-0.9.0-SHA256SUMS.txt`. Windows/Linux ASAR SHA `221342a6e55991f265fe00996e193753d12357b94a2e20361786eaf01207c417`. Các hành trình browser/media chạy trên Windows unpacked cuối cùng có ASAR này; launcher portable được thử HTTP/tools riêng.

Linux chỉ build thư mục và xác minh integrity, chưa xuất archive0.9 hoặc chạy native. macOS chưa build/chạy. Authenticated DASH/YouTube, ký addon và Task6–10 chưa triển khai; không tuyên bố ngang mọi tính năng IDM. Không push/publish.

E2E đã khôi phục native registrations và dọn profile của từng lượt. **Bốn thư mục probe chẩn đoán tạm được giữ lại** vì automatic approval review chặn việc xóa, chỉ trả lý do `blocked by policy`; không retry. Chúng chứa bản xuất tiện ích và một profile Firefox khởi động lỗi, không phải chỉ log. Việc này không chặn chức năng/gate phát hành.

Bằng chứng đầy đủ: [evidence/v0.9](evidence/v0.9), gồm exit JSON, ảnh, request log đã bỏ credential values, coverage/audit/build/integrity. Hướng dẫn API Firefox: [native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests), [background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).
