# FlowDM 0.11.0 — nhập hàng loạt và Site Grabber giới hạn

Ngày 2026-10-26 (Asia/Saigon), baseline1314956. [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md) · [Review](batch-v11-review.md) · [Bằng chứng](evidence/v0.11/summary.json).

## Cách dùng

Nhấn **Nhập link hàng loạt**, dán mỗi dòng một URL rồi **Xem trước**. Lọc danh sách, chọn từng link hoặc các mục đang hiện, chọn queue/thư mục/số kết nối rồi tạo các lượt tải đã chọn. Mặc định không chọn mục nào; mở popup hoặc xem trước không tạo job. URL trùng fragment được gộp, query có ý nghĩa được giữ. Giới hạn1000 dòng/512KiB raw và canonical; URL sai được báo theo dòng. Không deduplicate toàn lịch sử (Task8f).

Trong tiện ích Chrome/Firefox, nhấn **Lấy link trên trang**, lọc/chọn rồi **Xem trước trong FlowDM**. Chỉ đọc anchor của trang HTTP(S) đang hoạt động, không đọc incognito hay gửi credentials. Desktop mở danh sách nhưng chưa tải: tiếp tục chọn và submit ở desktop. Tab/navigation đã đổi sẽ bị từ chối. Cần xuất/Reload tiện ích và kết nối lại native host0.11; host cũ không có operation previewBatch.

**Site Grabber giới hạn**: nhập seed và nhấn lấy link, cùng origin, sâu tối đa2, tối đa100 HTTP requests kể cả redirect,1000 link/512KiB. Một request đang hoạt động (dưới trần hai); HTML UTF-8 tối đa2MiB,10giây/trang và60giây/crawl. Đi qua route không extension, HTML/XHTML/PHP/ASP/ASPX/JSP/CGI/CFM; suffix lạ hoặc file binary chỉ hiện để chọn. Không chạy script, tải subresource hoặc dùng browser cookie/header. Link do JavaScript tạo có thể lấy từ trang đã render trong tiện ích. HTTP401/403, form password, redirect khác origin, HTML vượt giới hạn/charset không phù hợp được báo lỗi; không vượt access control. Đây là tập con có giới hạn, không hỗ trợ mọi website.

Dừng crawl hoặc đóng dialog sẽ abort discovery và giữ job đã có. Mở preview trình duyệt mới hủy crawl cũ; epoch/request tokens chặn preview, picker, queue và start ACK cũ sửa danh sách mới. Preview/crawl chỉ ở RAM; journal vẫn schema7 của0.10. Job đã submit giữ URL/query cần tải trong lịch sử như trước; không chia sẻ state riêng tư.

## Kiểm thử cuối

| Phạm vi | Kết quả |
|---|---|
| Unit/integration | **389/389 pass**,0fail/skip; desktop1/1 và localmedia-selection1/1;3Internet opt-in skip trong coverage |
| Coverage toàn src/extension | **93,51% lines/statements;86,49% branches;87,52% functions** |
| Audit | **0 vulnerabilities**, không thêm dependency |
| Task7 GUI, Windows packaged0.11 | **7/7 cases pass**,9,53giây; selected-only, Unicode, customqueue/folder/N2, SHA hai tệp64KiB, hủy/redirect/async-race |
| Crawl fixture thật |3kết quả trang,6link; redirect ra ngoài bị chặn, outside server0request; cancel dừng request đang dở và giữ hai job |
| Chrome thật, packaged |3link→lọc/chọn1→nativepreview0job→desktopsubmit1→2MiB đúngSHA; legacycapture/HLS/DASH/consent/host-down đều đạt |
| Firefox149.0.2 thật, packaged | Lấy/chọn1link→desktoppreview0job; HTTP/HLS rebind sau app restart đúngSHA/full decode, registrations restored |
| Browser gate tổng | **3/3 suites exit0**: Chromecredential, Chromelegacy+links, Firefoxcredential+links |
| Hồi quy queue | **2/2 pass**,133,94giây; lịch/order/rate/HTTP/HLS/relaunch; countdown60giây và hủy/fake OS |
| Hồi quy media | **5/5 pass**,5YouTube/playlist opt-in skip; publicHTTP, N1→4→1, HLS/DASH resume/refresh, DASH4K/audio-only/full decode |
| Portable | HTTP2MiB pause/relaunch/resume đúngbyte/SHA; bundledtoolsverified |
| Build/integrity | Windowsportable+Linuxdirectory exit0; **60files** khớp haiASAR,3Windows tools đúngpin/hash |

Nhập URL video Internet công khai W3C qua parser→preview→chọn1→submit nguồn0.11 đã tải4.372.373byte, SHA b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254 và full FFmpeg decode. Directory W3C từ chối truy cập, được ghi nhận và không vượt chặn; video URL được nhập riêng, không tuyên bố crawler đã lấy được directory đó. Crawl thật được chứng minh bằng HTTP fixture do dự án kiểm soát và các ca dynamic/redirect/loop/timeout.

## Artifact và giới hạn

Windows: dist/FlowDM 0.11.0.exe, **263204800byte**, SHA-256 **c4c66ccc3466e5a52081b36bf0250b0149f8fce107b48bd591c432320ea1ddcf**; checksum tại dist/FlowDM-0.11.0-SHA256SUMS.txt. ASAR Windows/Linux **9f9decfd8a99ce277ad3e95d366d683d2d31a764cbf4c369d5a81afe314065a9**. GUI/browser tests dùng Windows unpacked có ASAR này; portablelauncher được thử riêng.

Source report giữ appVersion thực tế của từng lượt (một số lượt đầu trước bump0.11); final packaged sau review fixes là gate quyết định. Tên report v6/v7/v8/v9/v10 trong evidence0.11 giữ tên harness cũ, được đối chiếu bằng version/time/runner và ASAR. Text logs chỉ chuẩn hóa trailing whitespace; raw logs local giữ nguyên.

Linux mới builddirectory/integrity, chưa native GUI. macOS chưa build/chạy. PublicYouTube dài/playlist không chạy lại trong gate này; authenticatedDASH/YouTube vẫn ngoài khả năng adapter. Task8–10 chưa triển khai. Không push/publish, không sửa profile hằng ngày, không thực thi power thật. [Quyết định và chi phí](batch-v11-review.md) ghi rõ các giới hạn và lần automatic approval rejection của một thao tác kiểm thử bổ sung.
