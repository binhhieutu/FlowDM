# FlowDM 0.10.0 — nhiều queue và lịch lặp

Ngày 2026-10-26 (Asia/Saigon), baseline 3c294f7. [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md) · [Review](queues-v10-review.md) · [Bằng chứng](evidence/v0.10).

## Cách dùng

Tạo/sửa/xóa queue trống, chọn queue khi thêm link, chuyển tác vụ đã dừng, sắp thứ tự bằng ↑/↓ và lọc theo queue. Mỗi queue có số lượt đồng thời, tốc độ KiB/s, ngày T2–CN, múi giờ IANA và khung giờ kể cả qua đêm. Tổng app vẫn tối đa ba lượt và ba lượt/host; số kết nối mỗi tác vụ vẫn 1–16. Tạm dừng queue trước khi sửa giới hạn hoặc lịch để chờ worker kết thúc.

Lịch chạy công việc còn chờ, không nhân bản tệp hoàn tất. Đến stop time, app lưu checkpoint rồi pause; phiên kế tiếp tiếp tục. Tác vụ đang chạy trong queue có lịch giữ quyền tự tiếp tục qua đóng/mở app hoặc journal còn trạng thái downloading sau ngắt. Tác vụ người dùng tự pause vẫn chờ nhấn tiếp tục. Máy/app phải đang hoạt động; không tự đánh thức máy và không chạy bù mọi cửa sổ đã bỏ lỡ. DST gap tiến tới phút hợp lệ đầu, fold dùng mốc đầu; watermark chặn clock lùi mở lại phiên đã đóng.

Băng thông queue chia cố định theo slot, cùng cách tính cho HTTP/HLS/DASH/YouTube. Slot trống không nhường băng thông, nên ít tác vụ có thể chạy dưới mức cap. Đây là giới hạn cấu hình trung bình, không bảo đảm byte tức thời do buffer. Giới hạn task nhỏ hơn vẫn được giữ.

Hành động **Không làm gì / Thông báo / Ngủ / Tắt máy** chỉ đủ điều kiện khi queue không rỗng và tất cả tác vụ thành công. Ngủ/tắt chờ toàn app hết công việc rồi đếm ngược tối thiểu 60 giây, có nút hủy. Nếu nhiều queue đủ điều kiện, queue hoàn tất trước được ưu tiên. Thêm/tiếp tục/thay đổi công việc hoặc cấu hình, đóng app và suspend/resume hủy hành động chờ. Lỗi ghi receipt được retry trong phiên; receipt được lưu trước khi arm và kiểm tra bền vững lại trước OS. Không replay hành động/đếm ngược sau restart. OS có thể từ chối quyền. **Mọi kiểm thử power dùng fake; chưa tắt/ngủ máy thật.**

Schema 7 lưu tasks và queues nguyên tử, kiểm tra assignment/order, giữ bản sao nguyên byte khi nâng từ v1–6. Queue Default giữ thứ tự cũ. Không mở state 7 bằng binary 0.9 hoặc cũ hơn. Browser handoff vẫn vào Default; xem [BROWSER](BROWSER.md).

## Kiểm thử cuối

| Phạm vi | Kết quả |
|---|---|
| Unit/integration | **354/354 pass**, 0 fail/skip; desktop 1/1, local media-selection 1/1; ba Internet opt-in skip trong gate coverage |
| Coverage toàn src/extension | **95,77% lines/statements; 86,64% branches; 91,31% functions** |
| Audit | **0 vulnerabilities**, không thêm dependency |
| Scheduler/coordinator/power | 13/24/12 focused tests; manager integration 19 cases gồm subtests; DST/clock lùi, cap/order, migration, lỗi ghi, hủy trong final validation |
| Queue GUI, Windows packaged 0.10 | **2/2 pass**, 133,45 giây; giữ lịch/order/move sau relaunch, HTTP/HLS đúng SHA, FFmpeg decode toàn bộ, peak hai lượt |
| Băng thông queue thật | Hai tệp tổng 512 KiB với cap 128 KiB/s mất 4.365 ms, gồm pause/resume; kiểm tra cả per-task rate không bị đổi |
| Power giả lập, thời gian thực | Đếm ngược đầu 60 giây; hủy rồi chờ 61 giây không thực thi; cohort mới gọi fake đúng một lần sau hơn 60 giây |
| HTTP/HLS/DASH và refresh, packaged | **5/5 pass**, 5 YouTube/playlist opt-in skip; HTTP public, đổi N 1→4→1, relaunch, reuse byte/fragment, DASH 4K/audio-only và full decode |
| Chrome/Firefox, packaged | Cấp lại phiên HTTP/HLS trên hai browser đều 1/1 exit 0, giữ byte/SHA và full decode; legacy capture/DASH/consent/host-down 1/1 exit 0 |
| Portable launcher | HTTP 2 MiB pause/relaunch/resume đúng byte/SHA; bundled tools verified, exit 0 |
| Integrity | Windows/Linux ASAR khớp **54 tệp**; ba công cụ Windows đúng pin/hash |

Nguồn queue E2E đầu 2/2 mất 133,54 giây, chạy trước final review fixes/version bump; source CRUD riêng xác minh 0.10.0. Final packaged nêu trên là gate sau các fix. Không relabel bằng chứng nguồn cũ thành lượt nguồn sau sửa.

Video Internet công khai [Sintel trailer trên W3C](https://media.w3.org/2010/05/sintel/trailer.mp4) trên packaged 0.10: đổi N 1→4→1, pause/đóng/mở/resume giữ 377.470 byte; file cuối 4.372.373 byte, SHA b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254, khớp bản tải liên tục độc lập và full decode. Không có server log W3C; bằng chứng không replay đến từ fixture dự án.

## Review và artifact

Một lượt review độc lập phát hiện ba lỗi High và một Medium: hủy power tới muộn trong final validation; mất hành động khi queue khác còn chạy; mất receipt khi ghi lỗi tạm thời; mất quyền tự resume lịch sau đóng/ngắt. Tất cả có RED→GREEN riêng, focused 43/43 và full suite cuối 354/354. [Chi tiết quyết định và chi phí](queues-v10-review.md).

Windows [FlowDM 0.10.0.exe](../dist/FlowDM%200.10.0.exe), 263.192.793 byte, SHA-256 **9e0088b629b6f6cf791a2785284e27094ef7d4676bc2b7cbafe11f07e707ed21**. Checksum tại dist/FlowDM-0.10.0-SHA256SUMS.txt. ASAR Windows/Linux **55fb623ec92fe3b5381afc1a3b591f8a09be72b312811d76f6de18053b034224**. Các GUI journey dùng Windows unpacked có ASAR này; launcher portable được thử riêng.

Linux chỉ build thư mục/integrity, chưa native GUI; macOS chưa build/chạy. Authenticated DASH/YouTube vẫn bị adapter chặn. Task 7–10 còn lại; không push/publish. Public YouTube dài/playlist không chạy lại trong gate 0.10; bằng chứng phiên bản trước giữ nguyên. Các tên report v6/v7/v8/v9 bên trong thư mục evidence/v0.10 là tên harness cũ, được map sang lượt packaged hiện tại bằng thời điểm, runner log và hash gói; không lấy report cũ để thay lượt chưa đạt.

Lượt legacy browser đầu timeout trước khi tạo DASH vì runner truyền FLOWDM_FFMPEG vào app đóng gói. App từ chối đúng chính sách không cho ghi đè bundled tools. Chẩn đoán ghi ADD_FAILED và không có tác vụ DASH; bỏ biến override trong runner con thì toàn bộ test đạt sau 19,34 giây, không đổi runtime, timeout hoặc assertion. Log lỗi ban đầu và lượt sửa cấu hình cùng được giữ. Native registrations và profile test được harness khôi phục/dọn; không đổi profile hằng ngày.

Preflight rộng đầu 328/332: bốn assertion writer còn kỳ vọng schema 6. Đã cập nhật kỳ vọng writer lên 7, giữ nguyên các fixture đầu vào legacy; full gate cuối 354/354 đạt. Text log versioned chỉ chuẩn hóa whitespace cuối dòng; raw log gốc giữ trong vùng tạm local.
