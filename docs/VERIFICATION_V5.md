# FlowDM 0.5.0 — tiếp tục tải media sau khi mở lại app

Ngày 2026-10-24, Windows 10 x64. Build dùng riêng trên máy chủ sở hữu, không phát hành ra ngoài. Electron 45, yt-dlp 2026.10.21, FFmpeg 8.1, aria2 1.37.0; công cụ giữ nguyên pin/hash của 0.4.

## Hành vi

- HLS lưu từng resource hoàn tất, SHA-256/kích thước/container và hash manifest media được chọn. Khi tiếp tục, kiểm tra cache rồi ghép lại từ đĩa theo thứ tự, không yêu cầu lại các đoạn đã lưu.
- DASH/YouTube giữ file native `.part`, `.ytdl` và fragment; đợi child đóng trước khi sửa lại prefix theo index đã commit và lưu hash checkpoint. Metadata mới được trích xuất vào RAM, kiểm tra identity rồi chuyển cùng dữ liệu đó cho yt-dlp qua stdin. DASH pin bytes MPD; YouTube pin video/format và cấu trúc HLS, cho phép chữ ký URL CDN đổi.
- Tạm dừng/đóng app bình thường giữ checkpoint; mở lại hiện tác vụ tạm dừng và cho tiếp tục. Hủy xóa checkpoint thuộc tác vụ; publish file hợp lệ xong mới xóa cache. Không ghi đè file có sẵn.
- Đoạn đang ghi dở có thể tải lại riêng. Chỉ audio M4A dở có thể tải lại riêng khi video hoàn tất đã được giữ. Video/muxed HTTP một file hoặc audio chưa có video hoàn tất, nếu thiếu validator an toàn thì giữ bytes và từ chối tiếp tục; không âm thầm tải lại toàn bộ video. Không hứa tiếp tục byte-level mọi định dạng HTTP fallback.
- Manifest/format đã pin thay đổi, cache mất/hỏng hoặc file lạ thì giữ bytes và báo lỗi, không tự xóa rồi tải lại toàn bộ. Không cam kết phát hiện mọi thay đổi payload tại cùng URL nếu metadata của nguồn không thay đổi, hoặc khôi phục sau mọi tình huống mất điện/kill cưỡng bức.
- Journal schema v4 đọc v1-v3; checkpoint chỉ có cho tiến độ lưu bằng bản mới. Bản cũ đã xóa fragment thì không thể tạo lại tiến độ đó từ journal. Không mở journal v4 bằng binary 0.4.
- Headers đăng nhập vẫn chỉ ở RAM: HLS cần Cookie/Authorization không tự khôi phục phiên đăng nhập sau khi mở app; kiểm chứng relaunch ở đây dùng media công khai, không thay chính sách lưu credentials.

## Kiểm thử

| Kiểm tra | Kết quả |
|---|---|
| Unit/integration | 165/165 pass |
| Desktop nguồn | Hành trình tải, pause/restart/resume HTTP, UI/IPC/onboarding/isolation pass |
| Coverage toàn src + extension | 98,22% lines/statements; 86,36% branches; 94,84% functions; ngưỡng tổng 80% đạt |
| Audit | 0 vulnerabilities |
| HLS/DASH nguồn và Windows unpacked | GUI thêm tải → có đoạn hoàn tất → Tạm dừng → đóng Electron → mở lại cùng state → Tiếp tục → file đầy đủ, SHA đúng và giải mã toàn clip đạt |
| HLS request | `segment00.ts` chỉ GET một lần qua hai phiên app; segment01 đang dở được yêu cầu lại riêng. File 47.188 byte, SHA `8fd49049fe73583d0e179541f59b57090178a412cd8676250cabbcb6f0bfbc4e` |
| DASH request | Init + chunk video đầu giữ lại qua hai lần chạy native/relay port mới; resource dở được tải lại riêng. File 41.899 byte, SHA `47486d3f87501c7cc371156ee296cfb3094e28768ef4ac413bc187003923717b` |
| Browser đóng gói | Chromium thật → native host → HTTP/HLS/DASH, consent và host-down fallback pass |
| Rà soát | [Báo cáo](media-resume-v5-review.md): đóng bốn P2 về manifest identity, abort trước spawn, hard link và HTTP video fallback; không còn P1/P2 trong phạm vi |
| ASAR/tool integrity | 38 file src/assets/extension mỗi ASAR Windows/Linux khớp source; ba công cụ Windows khớp size/SHA manifest |
| Linux archive | 71 payload SHA khớp linux-unpacked; flowdm/chrome-sandbox/chrome_crashpad_handler quyền 0755; chưa chạy native |

Lượt phát hành cuối chạy đầy đủ `npm run test:coverage`: 165 unit/integration và desktop có V8 coverage đều đạt. Các lượt trước phát hiện metadata version tiện ích chưa đồng bộ và stub kiểm thử đăng ký abort trễ; đã sửa trước lượt cuối. Không thay dependency versions. Harness portable cũng được sửa: chờ trang Electron xuất hiện sau CDP endpoint, theo dõi PID app thật, giữ lỗi gốc khi cleanup thất bại và gọi đúng chữ ký `window.flow.action(id, action)`. Không sửa runtime để né các lỗi harness.

## YouTube thật

Nguồn [Big Buck Bunny — Official Blender Foundation Short Film](https://www.youtube.com/watch?v=aqz-KE-bpKQ), Blender Foundation, CC BY 3.0; [dự án gốc](https://peach.blender.org/). File kiểm tra không nằm trong source ZIP.

Ứng dụng nguồn: tải ở N=4 và cap 4 MiB/s → tạm dừng → đóng/mở app → tiếp tục. Checkpoint được dùng lại; file cuối **288.972.332 byte**, **634,624 giây**, **H.264 1920×1080 + AAC**. FFmpeg giải mã toàn bộ video/audio với `-xerror`: exit 0, stderr rỗng. SHA-256 `fc6b9d58d1f91ebfba1e26f3968368ab4dce11d17b749a781e360688d08c44b4`, khớp bản tải liên tục 0.4. Lượt nguồn tạm dừng sớm để kiểm tra; các số đếm reusedResources và reusedBytes trong JSON phản ánh checkpoint được dùng lại, không phải toàn bộ byte từng nhận qua mạng.

Windows unpacked: chờ ít nhất 12 resource hoàn tất rồi bấm Tạm dừng, đóng app và mở lại. Bản 0.5.0 **dùng lại 12 resource, 26.444.080 byte (~25,2 MiB)** từ checkpoint. File cuối cùng size/SHA như trên; giải mã toàn bộ A/V đạt, duration 634,624 giây. Bộ E2E packaged HLS/DASH và YouTube đạt **2/2**, khoảng 133 giây gồm toàn bộ thao tác tải, relaunch và decode; không dùng thời gian này làm benchmark tốc độ.

**Portable phát hành cuối:** chạy chính `FlowDM 0.5.0.exe` sau khi build lại guard HTTP. HTTP 2 MiB pause/đóng/mở/resume khớp bytes. YouTube thật pause → đóng portable → mở lại → tiếp tục: byte hiển thị được giữ ở 31.658.408, checkpoint dùng lại **12 resource / 26.444.080 byte**, file cuối **288.972.332 byte** cùng SHA với mẫu đã giải mã toàn bộ. Công cụ media integrity đạt. Đã đợi PID app thật và launcher thoát, dọn thư mục thử thành công; không suy kết quả từ bản unpacked.

Sau guard HTTP fallback cuối, đã build lại Windows/Linux và chạy lại E2E HLS/DASH trên final unpacked: đạt, tiếp tục không tải lại resource hoàn tất. ASAR Windows/Linux SHA-256: `4d0314dd13bfb285986c7f090ee7c848420240a98c6e6a38104a946778c384ae`. Đã đối chiếu lại 38 file runtime/assets/extension sau build.

## Phạm vi và chạy lại

HLS/DASH VOD không DRM và YouTube công khai theo phạm vi hiện có. Windows đã kiểm tra thực tế; Linux chỉ build/kiểm tra archive, macOS chưa build/chạy. Linux/macOS cần yt-dlp hỗ trợ EJS, FFmpeg và aria2c trên PATH. Cache cần đủ chỗ trống; external workspace có thể chứa bản assembled và fragment trùng nhau, bị chặn ở tối đa 3 lần maxBytes. Thư mục state/native continuation là dữ liệu riêng tư, không chia sẻ. Không lưu browser credentials hoặc raw extracted CDN URLs trong JSON checkpoint mới. Xem [media tools](MEDIA_TOOLS.md).

Lặp lại: `npm run test:coverage`; `node --test tests/e2e/media-resume.test.cjs`. Test thứ hai mặc định tắt khi chưa có `FLOWDM_LIVE_YOUTUBE`; đặt URL trên để tải video thật và giải mã toàn file. Đặt `FLOWDM_EXECUTABLE` thành Windows unpacked để kiểm tra bản đóng gói. Portable: đặt thêm `FLOWDM_TEST_MEDIA_RESUME=1`, `FLOWDM_EXPECTED_YOUTUBE_SHA256` là SHA trên rồi chạy `node scripts/smoke-portable.cjs "dist/FlowDM 0.5.0.exe"`.

Bằng chứng: [evidence/v0.5](evidence/v0.5). Test dùng state/profile/output riêng; khôi phục native registration sau browser test và giữ IDM/profile hằng ngày của chủ máy.
