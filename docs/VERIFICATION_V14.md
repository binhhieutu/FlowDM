# FlowDM 0.14.0 — cổng phát hành nguồn

Ngày 2026-10-26, Asia/Saigon; baseline `53f4bc8`. Phạm vi Task 10: **nguồn/extension public trên GitHub, Windows portable và Linux x64 tar kiểm thử cục bộ**. Binary công khai còn chờ gate nguồn tương ứng của third-party. [Runbook](RELEASE.md), [notices/gate](THIRD_PARTY_NOTICES.md), [review](release-v14-review.md), [evidence](evidence/v0.14/summary.json).

## Thay đổi

Sao lưu download-state khi app đã đóng: journal/preferences, HTTP partial và cache media có manifest SHA256/marker hoàn tất. Khôi phục vào thư mục mới, không ghi đè profile/file tải; app mới từ chối marker restore chưa xong. Không bao gồm native registration, credentials RAM hoặc file hoàn tất ngoài state. Chỉ rollback bằng binary tương thích schema.

GUI có thông tin cập nhật thủ công và mở trang GitHub cố định. Chưa có endpoint/khóa tin cậy nên không tải/cài tự động. Validator cho updater tương lai được test với Ed25519, version, hash/size, OS/architecture và URL phát hành; không có signing key/manifest tự cập nhật được triển khai.

Source/extension ZIP lấy file Git theo dõi theo allowlist, kiểm tra từng entry/byte, loại vendor/state/cache/logs/video; Git archives cũng dùng export-ignore. Fflate 0.8.3 là dev-only MIT. CI chỉ workflow_dispatch, không tự chạy khi push và không upload binary media. Lệnh backup/restore CLI cũng đã smoke-test bytes thật.

## Bằng chứng cuối

| Gate | Kết quả |
|---|---|
| Windows unit/integration | 489 tests: **483 pass, 0 fail, 6 native-Unix skip** |
| Linux unit/integration | 489 tests: **487 pass, 0 fail, 2 Windows-only skip** |
| Coverage Windows main+renderer | **93.32% lines/statements, 85.79% branches, 87.33% functions** |
| Audit | 0 vulnerabilities |
| Windows packaged toàn bộ | **33 tests: 24 pass, 0 fail, 9 skip**; Firefox riêng chạy bổ sung **1/1 pass**. Các skip còn lại là Internet YouTube/playlist opt-in và native-Unix gate |
| Windows thực tế | HTTP/HLS/DASH, đổi N, format/audio, SHA/full decode, Chrome capture/rebind, Firefox HTTP/HLS rebind, batch/crawl, queues/60s/fake OS, FTP, scan, crash recovery |
| Linux tar giải nén | 6 nhóm native gate đạt: integrity, 15 platform-unit tests, sandbox, HTTP, HLS/DASH resume, Chromium capture; 4 GUI tests pass, 1 YouTube opt-in skip |
| Nâng cấp/rollback Windows | Old 0.13 → new 0.14 giữ 90.112 byte; new tải đến 180.224 byte; restore snapshot về 90.112 byte, old binary tiếp tục đến 2 MiB/SHA đúng. Profile mới không đổi, schema 4 bị từ chối |
| Nâng cấp/rollback Linux | 98.304 → 196.608 byte; restore 98.304, old binary tải tiếp đúng 2 MiB/SHA; profile mới được giữ |
| Video Internet công khai | W3C Sintel trailer 4.372.373 byte, đổi N 1→4→1, pause/relaunch/resume, strong ETag, full decode và khớp bản tải liên tục độc lập; SHA b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254 |
| Portable Windows | Launcher HTTP 2 MiB pause/relaunch/resume và bundled tool hashes pass |
| Integrity | 70 runtime/assets/extension files + 16 basic-ftp JS/license files khớp cả hai ASAR; tar giải nén có 72 payload files khớp, ba executable mode 0755 |

ASAR Windows/Linux: `352480074faef281bc1a34021fb8f38e808b141f91e9bb22761916fbab28a515`.

- Windows local `FlowDM 0.14.0.exe`: 263.258.083 byte, SHA256 `2b296548bc57a6efebd1f879f2076412aba09168647b48443910ed551cbbc41c`.
- Linux local `flowdm-0.14.0.tar.gz`: 125.719.348 byte, SHA256 `d74528c57721e4e4fef61fd677d01511436b24ec5386ce4ab43078caed71591f`.
- Source/extension ZIP và checksum được tạo sau khi chốt nguồn; inventory trong `evidence/v0.14/bundles.json`. Không đưa hash source ZIP vào chính nội dung ZIP để tránh tự tham chiếu.

## Chẩn đoán và giới hạn

Review độc lập không có finding quan trọng cần sửa. TDD đã ghi nhận RED→GREEN cho snapshot/policy cập nhật/bundles; native Linux tái hiện root symlink bị nhận nhầm rồi sửa kiểm tra directory root. Lượt full packaged đầu phát hiện test concurrency cũ cố tải trùng URL mà chưa opt-in: thêm thao tác checkbox cho benchmark N4, giữ nguyên guard sản phẩm, rồi chạy lại toàn suite đạt 24/0/9.

Một URL archive Gyan trong CI trả 404 khi kiểm tra tĩnh; đã sửa sang asset của official release GyanD/codexffmpeg 8.1 và xác nhận HTTP 200. Hosted CI chưa chạy; không gán kết quả cục bộ cho GitHub runner. Không thay runtime sau build cuối; các sửa sau đó là test/script/docs/config export, và ASAR vẫn khớp.

WSL lượt mới từng lỗi HCS thiếu tài nguyên. Máy chỉ có distro FlowDM của task, đang stopped; `.wslconfig` chưa tồn tại. Đã tạo giới hạn RAM 3 GB, 2 processor, swap 1 GB để khởi động ổn mà không đóng ứng dụng chủ máy. Giữ cấu hình này và instance riêng để dùng lại; không ghi đè cấu hình cũ hoặc đổi sandbox/sysctl, proxy/AV policy/clipboard thật. Profile test riêng được đóng, đăng ký native host được khôi phục; hành động nguồn luôn fake.

macOS x64/arm64/Gatekeeper, Linux desktop ngoài WSL2/ARM64 chưa kiểm thử. YouTube qua proxy full-file vẫn bị HTTP 401 ở lượt trước, không thử vượt chặn; FAT/exFAT vẫn chưa hỗ trợ. Các test Internet YouTube/playlist không được bật trong gate này; video W3C và video fixture không thay bằng chứng YouTube. Chưa có installer/uninstaller hoặc binary public; nguồn tương ứng/notice phải hoàn tất trước phát hành binary. Journal giữ schema 8.
