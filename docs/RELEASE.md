# Phát hành và cập nhật FlowDM

## Phạm vi 0.14.0

Repository nguồn: https://github.com/binhhieutu/FlowDM. Phát hành nguồn/extension ZIP; các bản Windows portable và Linux x64 tar được build/test cục bộ. Chưa phát hành công khai các binary kèm công cụ media: xem [third-party gate](THIRD_PARTY_NOTICES.md). macOS và Linux desktop ngoài WSL2 chưa được xác minh. Không có installer/uninstaller; ứng dụng dùng dạng portable, không tự xóa dữ liệu tải khi bỏ binary.

**Cập nhật ứng dụng** trong GUI cho biết phiên bản và mở trang GitHub cố định khi người dùng nhấn. Chưa có endpoint/khóa ký tin cậy nên không tự tải/cài, không báo một phiên bản mới khi chưa kiểm tra. Validator Ed25519 và kiểm tra hash/OS/architecture/downgrade mới được thử bằng fixture cho một updater tương lai; không có private signing key hay updater đang bật.

## Sao lưu dữ liệu tải khi nâng cấp

Đóng FlowDM trước khi dùng các lệnh sau. Nếu vừa crash, mở rồi đóng bình thường trước để dọn marker bridge. Cần Node.js >=22 khi chạy script từ nguồn. Dùng đường dẫn tuyệt đối và một thư mục đích mới; thư mục cha phải có sẵn.

```text
node scripts/profile-backup.cjs create --data-dir ABS_STATE_DIR --output ABS_NEW_BACKUP --app-version 0.13.0
node scripts/profile-backup.cjs restore --snapshot ABS_BACKUP --output ABS_NEW_STATE_DIR --max-schema 8
```

Snapshot sao chép toàn bộ **download-state directory**, gồm journal, preferences, partial HTTP và cache media; kiểm tra từng SHA256, danh sách file và nguồn không đổi trước khi ghi marker hoàn tất. Từ chối bridge còn mở, tác vụ đang tải/quét, symlink, schema lạ và đích đã tồn tại. Không phải snapshot của toàn bộ Electron userData: không chứa đăng ký/native host trình duyệt, credentials trong RAM hoặc các tệp tải hoàn tất nằm ngoài state. Backup có dữ liệu riêng tư của download/cache; giữ trong thư mục cá nhân, ví dụ `.tmp`, không đưa lên GitHub/source ZIP.

Khôi phục tạo **state directory mới**; không ghi đè profile hiện có hoặc file đã tải. Dùng `FLOWDM_DATA_DIR=ABS_NEW_STATE_DIR` để kiểm tra bản khôi phục trước khi chuyển sang dùng. Windows PowerShell: đặt `$env:FLOWDM_DATA_DIR='C:\...\restored-state'` rồi chạy binary; Linux shell: `FLOWDM_DATA_DIR=/.../restored-state ./flowdm`. Cần kết nối lại native host nếu đổi state directory; proxy/tài khoản FTP/phiên browser phải cấp lại theo chính sách RAM-only.

Backup bị ngắt thiếu `complete.json` không dùng được. Restore bị ngắt giữ `.flowdm-restore-incomplete`; bản mới từ chối mở state đó. Không dùng một bản restore chưa hoàn tất với binary cũ. Không tự xóa các thư mục ngắt giữa chừng: nguồn và backup tốt vẫn được giữ. Chỉ quay về binary hỗ trợ schema của snapshot; 0.13/0.14 đọc schema 1–8, bản chỉ đọc schema 4 phải bị từ chối với snapshot schema 8. Đây là kiểm thử gián đoạn process, không bảo đảm mọi mất điện/hỏng đĩa.

## Đóng gói và kiểm tra

```text
npm ci
npm run test:coverage
npm audit
npm run dist:win
npm run dist:linux
node scripts/verify-package.cjs
npm run release:bundles
npm run release:verify-bundles
node scripts/hash-release.cjs
```

Build native Linux và test lại bằng `npm run test:native -- --platform linux` trên host Linux, với `FLOWDM_EXECUTABLE` trỏ đúng executable đã build. WSL2 có hướng dẫn ở [platform verification](PLATFORM_VERIFICATION.md). Không suy build thành runtime PASS. Build media Windows cần công cụ ghim đúng hash theo [MEDIA_TOOLS](MEDIA_TOOLS.md). Không đổi runtime sau build; nếu đổi phải build và kiểm thử lại.

Bundle chỉ lấy file **đã được Git theo dõi/stage**, theo allowlist mã nguồn/assets/docs/test scripts. Loại vendor, state/cache, `.tmp`, evidence logs, tệp video và binary media. Toàn bộ source app/build scripts vẫn có trong source ZIP; các video fixture tự sinh chỉ nằm trong Git repository, có lệnh tạo lại ở `tests/fixtures/video/README.md` và `tests/fixtures/dash/README.md` nếu muốn chạy tests từ source ZIP. Nên clone repository để có đủ fixture/evidence kiểm thử.

Mỗi entry ZIP được đối chiếu với nguồn; entry lạ, path traversal, trùng tên, byte khác hoặc dữ liệu mở rộng quá giới hạn bị từ chối trước ghi ra đĩa. `hash-release.cjs` xác minh hai ZIP rồi xuất SHA256SUMS cho gói cục bộ; checksum `source-SHA256SUMS` chỉ liệt kê source/extension ZIP dùng cho phát hành nguồn. Các checksum không thay thế chữ ký phát hành.

CI chỉ có `workflow_dispatch`, quyền contents:read, không chạy khi push/PR và không upload binary media. Chưa chạy hosted CI trong lượt này; các kết quả công bố là chạy cục bộ Windows/WSL2. macOS/Gatekeeper vẫn chưa kiểm thử.
