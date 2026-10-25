# FlowDM 0.6.0 — cập nhật link và tiếp tục HTTP media

Ngày 2026-10-25. Phạm vi: Task 1 và Task 2 trong [checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md). Báo cáo bản trước: [0.5](VERIFICATION_V5.md).

## Hành vi mới

- Tác vụ tạm dừng/thất bại có nút **Cập nhật liên kết**. Ứng dụng kiểm tra nguồn trước khi ghi URL mới; giữ ID, đường dẫn, bytes và checkpoint. Tác vụ vẫn tạm dừng sau cập nhật, nhấn **Tiếp tục** để tải phần còn thiếu. Mở lại app vẫn giữ URL và tiến độ mới.
- URL thay thế phải cùng origin với URL hiện tại. HTTP cần strong ETag, tổng kích thước, range, identity encoding và final origin phù hợp. Phụ thuộc server cung cấp validator chính xác; không cam kết phát hiện payload bị server thay nhưng cố tình giữ metadata/validator sai.
- HLS cần cùng bytes manifest đã chọn và cùng danh sách resource đã resolve. Không bỏ query để coi mọi signed resource URL là cùng nội dung; thay đổi manifest/resource có thể bị từ chối dù hình ảnh trông giống nhau.
- DASH cần cùng bytes MPD, selected metadata và final origin/path của MPD. Snapshot mới lưu hash vị trí manifest, không lưu thêm raw CDN URL. Query token mới được kiểm tra, đổi đường dẫn/base bị từ chối.
- YouTube cần cùng canonical video ID, selected formats và cấu trúc playlist. Sau preflight, lần resume vẫn kiểm tra lại identity và dùng chính metadata đã kiểm tra cho transfer. Không bật authenticated YouTube, DRM hay cơ chế vượt kiểm soát truy cập.
- Không cho đổi tên tệp/checkpoint/destination hoặc gửi arbitrary tool flags qua thao tác refresh. Desktop IPC chỉ nhận ID và URL. Headers API nội bộ được validate, chỉ trong RAM; không có chức năng khôi phục credentials trình duyệt trong Task 1–2.
- Lỗi lưu journal khi refresh sẽ khôi phục source/headers trước đó; preflight thất bại không sửa cache. Không tự resume trong lúc nguồn đang được kiểm tra.

## HTTP continuation

- Resume HTTP một file, bao gồm MP4 trực tiếp, yêu cầu strong ETag trùng, total bytes trùng, Range và encoding an toàn. Probe 206 phải trả đúng một byte, Content-Range/Content-Length hợp lệ.
- Mỗi range gửi If-Range. HTTP 200/416 cho yêu cầu range, sai origin/validator/Content-Range hoặc encoding không hợp lệ đều thất bại trước khi append phần sai; giữ bytes đã commit, không truncate rồi tự tải lại từ đầu.
- Partial missing/truncated, symlink/hardlink hoặc lớn hơn total bị từ chối. Segment chưa nhận byte không yêu cầu extent trên đĩa; partial nhiều luồng dạng sparse vẫn tiếp tục đúng.
- Thiếu validator hoặc chỉ có Last-Modified: tải mới vẫn dùng một stream; resume phần dở giữ bytes và báo lỗi. Muốn tải lại từ đầu phải chủ động tạo tác vụ mới.
- External HTTP fallback của yt-dlp chưa có durable validator/range contract, nên vẫn từ chối resume plain HTTP video/muxed hoặc audio độc lập đang dở. Không bật aria2 continuation chỉ vì có control file. Ngoại lệ cũ: M4A đang dở có thể tải lại riêng khi đã giữ MP4 hoàn tất.

## Tương thích cần biết

Journal vẫn schema v4, đọc v1–v4; thêm trường encoding và hash binding/base tùy loại. **DASH checkpoint 0.5 có dữ liệu nhưng thiếu manifest base hash bị giữ nguyên và từ chối resume/refresh**, vì không chứng minh được tài nguyên trước redirect. State DASH rỗng được thiết lập identity/base mới. Cần tạo tác vụ mới cho legacy cache không đủ bằng chứng; không âm thầm xóa cache cũ.

Headers mất sau khi mở lại app vẫn cần phiên được cấp quyền lại; Task 5 chưa triển khai. Không có expired-link refresh sang origin/CDN bất kỳ. Không có bảo đảm phục hồi mọi trường hợp mất điện/kill cưỡng bức. Task 3–10 của roadmap còn chờ.

## Kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| TDD source refresh | RED thiếu API → GREEN; sai nguồn giữ nguyên task/cache; rollback journal lỗi đạt |
| TDD HTTP | RED resume không validator vẫn tải lại → GREEN từ chối giữ bytes; RED partial dư bytes và sparse offset → GREEN |
| TDD DASH | RED đổi base/filename vẫn được chấp nhận và legacy thiếu base đi tới extractor → GREEN từ chối trước sửa cache |
| Unit/integration toàn bộ | 188/188 pass |
| Desktop tổng quát | 1/1 pass bằng Electron thật |
| Coverage toàn src + extension | 97,80% lines/statements; 86,53% branches; 94,79% functions |
| Dependency audit | 0 vulnerabilities; không đổi dependency versions |
| Source GUI HTTP/HLS/DASH refresh | Link cũ trả 410 → tạm dừng → đóng/mở → từ chối nguồn đổi → cập nhật link đúng → đóng/mở → resume; SHA và full decode đạt |
| Windows packaged HTTP/HLS/DASH refresh | Cùng flow đạt trên `dist/win-unpacked/FlowDM.exe` cuối; direct giữ 3.328 byte, HLS dùng lại 1 resource, DASH dùng lại 2 resource |
| Windows packaged HLS/DASH regression | Pause/đóng/mở/resume đạt; init/fragment đã commit chỉ GET một lần, fragment dở được retry riêng |
| Windows portable cuối | HTTP 2 MiB pause/đóng/mở/resume đúng bytes/SHA; tool integrity đạt |
| Browser packaged | Chromium thật với profile riêng → native host → HTTP/HLS/DASH, consent/fallback đạt; khôi phục native registration |
| ASAR Windows/Linux | 40 file src/assets/extension khớp source; 3 tool Windows khớp pin/hash |
| Review | [Báo cáo](source-refresh-v6-review.md): đóng hai P2; không còn P1/P2 trong phạm vi rà soát hữu hạn |

Fixture dùng **tệp video thực**, HTTP server cục bộ kiểm soát được expiry/range và request log. Đây là thử nghiệm network/socket + GUI thật, không phải video Internet bị làm hết hạn tự nhiên. Direct resume chỉ GET từ offset chưa tải (ngoài probe 1 byte); HLS `segment00.ts` và DASH init + fragment đầu không GET lại qua hai phiên app. File cuối:

- HTTP MP4: 41.899 byte, SHA-256 `87cbfbd36af5cc2c6d1e4fced4ec705f28d221ea2b5081ca7ae578278dba8e38`.
- HLS: 47.188 byte, SHA-256 `8fd49049fe73583d0e179541f59b57090178a412cd8676250cabbcb6f0bfbc4e`.
- DASH: 41.899 byte, SHA-256 `47486d3f87501c7cc371156ee296cfb3094e28768ef4ac413bc187003923717b`.

## YouTube công khai

Nguồn: [Big Buck Bunny — Blender Foundation](https://www.youtube.com/watch?v=aqz-KE-bpKQ), CC BY 3.0; [dự án](https://peach.blender.org/). Tải N=4, cap 4 MiB/s, chờ 12 resource hoàn tất → pause → đóng/mở app → nút Cập nhật liên kết (URL canonical cùng video, query mới) → đóng/mở lần nữa → resume → giải mã toàn file với FFmpeg `-xerror`.

Bản nguồn 0.6.0 đạt: paused/restored **32.821.878 byte**, dùng lại **12 resource / 26.444.080 byte**, file cuối **288.972.332 byte**, SHA-256 `fc6b9d58d1f91ebfba1e26f3968368ab4dce11d17b749a781e360688d08c44b4`; full decode exit 0, stderr rỗng. Query mới là thao tác refresh chủ động; không tuyên bố đã ép CDN YouTube hết hạn tự nhiên. Signed media URLs được trích xuất mới và kiểm tra lại identity.

Bản Windows packaged cuối cũng đạt cùng flow bằng GUI: paused/restored **32.822.887 byte**, dùng lại **12 resource / 26.444.080 byte**; file cuối cùng size/SHA với bản nguồn, FFmpeg giải mã toàn file exit 0, stderr rỗng. Test nguồn khoảng 127 giây, packaged khoảng 125 giây gồm tải, hai lần relaunch, refresh và decode; đây không phải benchmark tốc độ. Lượt portable kiểm tra HTTP và tool integrity; kiểm chứng YouTube refresh ở đây là bản Windows unpacked đóng gói, không suy thành đã chạy media refresh trực tiếp qua launcher portable.

Mẫu giữ lại: `downloads/verification-v6/YouTube-refresh-packaged-1792930157057.mp4`.

## Build và artifact

Windows portable 0.6.0: `dist/FlowDM 0.6.0.exe`; SHA-256 `09fe7a2b0547a70858bda69df2009ce4bfcf1d3226d7a28ca0ba03fd156e538d`.

ASAR Windows/Linux SHA-256 `781499e921307e2da05d8ff5a51a18f285d6d2ba392b5f8a4901bde7ba15bd43`. Linux mới chỉ build thư mục và đối chiếu ASAR, **chưa chạy native**; không tạo Linux release archive mới trong phạm vi này. macOS chưa build/chạy. Portable unsigned dùng riêng, chưa công bố/push; nghĩa vụ license/corresponding source để phân phối công khai vẫn là gate riêng.

## Chạy lại

```powershell
npm run test:coverage
npm audit
node --test tests/e2e/source-refresh.test.cjs
$env:FLOWDM_EXECUTABLE = (Resolve-Path 'dist/win-unpacked/FlowDM.exe').Path
$env:FLOWDM_LIVE_YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
node --test --test-name-pattern='public YouTube refresh' tests/e2e/source-refresh.test.cjs
Remove-Item Env:\FLOWDM_EXECUTABLE,Env:\FLOWDM_LIVE_YOUTUBE
node scripts/verify-package.cjs
node scripts/smoke-portable.cjs 'dist/FlowDM 0.6.0.exe'
```

Evidence lưu ở [evidence/v0.6](evidence/v0.6). Các lượt test dùng state/output/profile riêng và giữ ứng dụng IDM/profile hằng ngày của chủ máy.
