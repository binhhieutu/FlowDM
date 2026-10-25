# FlowDM 0.7.0 — chia lại vùng HTTP và đổi số kết nối khi tải

Ngày 2026-10-25. Phạm vi: Task 3 trong [checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md). Task 1–2 và giới hạn nguồn/identity xem [0.6](VERIFICATION_V6.md).

## Sử dụng

Chọn tác vụ HTTP trong danh sách → **Kết nối tối đa** ở phần chi tiết → chọn 1/2/4/8/16 → **Áp dụng kết nối**. Áp dụng được khi đang tải, đang chờ hoặc đã tạm dừng/thất bại; giữ ID, đích lưu và bytes đã commit. UI phân biệt số kết nối đang chạy/mức tối đa với số vùng dữ liệu trên đĩa. Giá trị đang chọn chưa gửi không bị progress update ghi đè.

Máy chủ phải hỗ trợ Range và strong ETag phù hợp để chia byte an toàn. Với máy chủ không đủ điều kiện, mức tối đa có thể thay đổi nhưng stream hiện tại tiếp tục một kết nối, không bị ngắt rồi tải lại. HLS/DASH/YouTube vẫn dùng fragment workers và cấu hình tại lúc khởi chạy; **chưa đổi N trực tiếp cho các adapter media này**. Task 3 không áp dụng range HTTP lên fragment hay tiến trình yt-dlp đang chạy.

## Cơ chế và ràng buộc

- Khi có worker rảnh, chọn vùng chưa commit lớn nhất và chia phần còn thiếu thành hai nửa. Mỗi nửa mới tối thiểu **256 KiB**; vì vậy file/vùng nhỏ có thể không dùng đủ N kết nối.
- Trước khi thay ownership, dừng nhóm worker HTTP bằng signal riêng rồi chờ request, ghi file, fsync và journal settle. Tính lại offset mới nhất sau khi dừng, coalesce các vùng hoàn tất liền kề, chia và đánh index mới theo thứ tự.
- Ghi sơ đồ mới thành công trước khi khởi chạy request thay thế. Lưu lỗi thì khôi phục sơ đồ/N cũ và không khởi chạy vùng chưa được commit. Đây là điểm dừng ngắn cho cả nhóm HTTP, không phải chia ngay trên worker còn ghi.
- Pause/cancel/close được kiểm tra lại sau bước async; đợi scheduler dừng trước khi đóng shared file handle. Phân biệt abort điều khiển với lỗi validator/protocol/storage thật.
- Giữ nguyên bộ đếm byte nhận và đồng hồ tính rate trong cùng phiên tải qua mọi lần chia/đổi N; không tạo ngân sách tốc độ riêng cho mỗi worker. Queue/max-per-host vẫn là giới hạn số tác vụ như trước, mỗi tác vụ có mức trần kết nối riêng.
- N API là số nguyên 1–16; UI có 1/2/4/8/16. Worker active không vượt N; sơ đồ tối đa **1.024 vùng**, kể cả vùng đã hoàn tất, rồi ngừng chia thêm nếu đạt giới hạn. Không cam kết mọi tác vụ sử dụng đủ N hoặc nhanh N lần.
- Giữ các guard 0.6: response Range 200/416/sai validator, nguồn đổi, cache mất/hỏng/dư size không được âm thầm truncate/tải lại toàn bộ. Đoạn đang nhận nhưng chưa commit có thể được yêu cầu lại sau ngắt worker.

## Journal schema 5

Đọc schema 1–5; giới hạn 16 vùng của reader cũ được giữ khi kiểm tra schema 1–4. Schema 5 cho tối đa 1.024 vùng, kiểm tra vùng liên tục, byte count và finite coverage tới total. Luồng một kết nối chưa biết length vẫn tương thích.

Trước khi ghi schema 5 từ journal cũ, tạo/flush bản sao **nguyên byte** `downloads.v<version>.<UUID>.backup.json` trong thư mục state, quyền file 0600 trên hệ hỗ trợ POSIX. Backup lỗi thì chặn migration, không đổi journal gốc. Backup chứa URL lịch sử như journal và là dữ liệu riêng. Không mở state schema 5 bằng binary 0.6 hoặc cũ hơn; muốn quay lại cần bản sao state/partial phù hợp, không chỉ đổi trường version trong JSON.

## Kiểm thử

| Phạm vi | Kết quả |
|---|---|
| Unit/integration toàn bộ | **206/206 pass** |
| Desktop tổng quát | **1/1 pass** bằng Electron thật |
| Coverage toàn src + extension | **97,38% lines/statements; 86,81% branches; 94,82% functions** |
| Dependency audit | **0 vulnerabilities**, không đổi dependency versions |
| Helper split | RED thiếu module → 6/6 GREEN: offset nhỏ/lớn, overflow, min-size, không mutate và chia lặp không overlap/gap |
| Control HTTP | 1→4→1, aggregate rate cap, retry backoff bị resize ngắt, invalid input, server không Range configured16/actual1 đạt |
| Ownership | Pause khi journal vùng mới đang chờ; lỗi journal rollback trước request thay thế; sparse partial và relaunch đạt |
| Migration | Backup nguyên byte trước v5; backup lỗi giữ journal; từ chối finite coverage thiếu tail; giữ unknown-length single-stream đạt |
| Source GUI | 1→4→1, server peak4; 10 mẫu sau giảm đều configured/active/server1; pause/relaunch giữ 253.952 byte, không replay vùng commit |
| Windows packaged GUI cuối | Cùng flow đạt, pause/relaunch giữ 221.184 byte; đủ 10 mẫu sau giảm đều <=1, peak4 và không replay vùng commit |
| Video fixture | MP4 thật 41.899 byte cộng box ISO-BMFF `free` để kiểm soát payload 4.194.304 byte; SHA đúng và FFmpeg giải mã toàn file đạt |
| Hồi quy Windows packaged | HTTP/HLS/DASH đổi link, pause/relaunch/resume; HLS/DASH N1/N4, checkpoint reuse và decode đều đạt: 4 test pass, 2 test YouTube tùy chọn skip |
| HTTP Internet thật | Video W3C 4.372.373 byte: GUI 1→4→1 → pause/đóng/mở/resume → đối chiếu tải liên tục độc lập → full decode đạt |
| Portable cuối | HTTP 2 MiB pause/relaunch/resume đúng bytes/SHA, bundled media tool integrity đạt |
| Package integrity | Windows/Linux ASAR khớp **42** file src/assets/extension; cả 3 media tool Windows đúng pin/hash |
| Review | [Review hữu hạn](dynamic-ranges-v7-review.md): không phát hiện P1/P2 chưa xử lý trong phạm vi |

Lượt coverage đầu đạt 204/205: test vùng chậm theo timer không đảm bảo còn đủ byte để chia khi máy chạy nhiều test/fsync đồng thời. Fixture core được sửa để giữ request đầu sau một chunk cho tới khi scheduler chia, kiểm tra hành vi bằng sự kiện thay vì tốc độ máy. Không nới assertion và không đổi runtime để né lỗi. Lượt cuối, sau thêm test non-range, chạy mới toàn bộ 206 test và desktop đều đạt. Trong RED/GREEN ban đầu còn bắt được Node trả ECONNRESET cho response chủ động abort và finite-coverage guard từ chối nhầm unknown-length stream; đã sửa và kiểm tra hồi quy trước build cuối.

## So sánh vùng cố định và vùng động

Cùng payload MP4 + padding 4 MiB và cùng server: một phần tư đầu truyền 8 KiB/40 ms mỗi kết nối; ba phần tư còn lại 64 KiB/5 ms. Baseline dùng harness bốn request range cố định ghép vào RAM; dynamic dùng GUI app, ghi đĩa/fsync, hash và publication. Các phép đo gồm overhead khác nhau, không phải benchmark cô lập mọi chi phí của hai engine.

| Lượt | Fixed 4 | Dynamic tối đa 4 | Tỷ lệ trong fixture |
|---|---:|---:|---:|
| Source candidate | 5.985 ms | 3.304 ms | 1,81× |
| Windows packaged 0.7.0 cuối | 5.989 ms | 3.269 ms | 1,83× |

Cả hai peak4 và cùng SHA-256 `d6081daf4fa5aba1f01aa25d510439301b6ef798eb05b21875e50602a53dff0f`. Request log chứng minh worker rảnh yêu cầu nửa mới trong vùng chậm, không yêu cầu lại prefix đã commit. Đó là lợi ích trong điều kiện server có vùng chậm và cho phép thêm range; không suy thành mức tăng tốc tương tự trên mọi website/mạng. Không dùng YouTube Internet làm benchmark Task 3.

## Video HTTP công khai

Nguồn thử [Sintel trailer được W3C lưu trữ](https://media.w3.org/2010/05/sintel/trailer.mp4). Bản Windows packaged **0.7.0** dùng cap 512 KiB/s để đảm bảo đủ thời gian thao tác, đổi N1→4→1, pause rồi đóng/mở app. Giữ nguyên **349.345 byte** và cấu hình1 qua relaunch; file cuối **4.372.373 byte**, SHA-256 `b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254`. So sánh nguyên byte với một bản HTTP 200 tải liên tục độc lập đạt; FFmpeg `-xerror` giải mã toàn file exit0, stderr rỗng. Không có request log bên server công khai; bằng chứng không replay vùng commit lấy từ fixture server do dự án kiểm soát.

Mẫu giữ lại: `downloads/verification-v7/HTTP-live-packaged-1792931852783.mp4`. Hai URL ứng viên khác bị HTTP403/404 lúc probe và không được dùng làm bằng chứng tải thành công.

## Artifact và giới hạn nền tảng

Windows: `dist/FlowDM 0.7.0.exe`. Hash/size tại [evidence/v0.7/summary.json](evidence/v0.7/summary.json) và `dist/FlowDM-0.7.0-SHA256SUMS.txt`.

ASAR Windows/Linux SHA-256 `369be4ce27e30d0de6ee62ba377f099f70787339696afee6789382c918daba29`. Linux chỉ build thư mục và đối chiếu integrity; **chưa chạy native**, chưa xuất release archive mới. macOS chưa build/chạy. Portable test riêng kiểm tra HTTP và tools; live N/benchmark/full decode được kiểm tra trên Windows unpacked đóng gói cuối, không tuyên bố đã thao tác live N qua launcher portable. Bản dùng riêng, chưa ký/push/publish; public redistribution/license gate vẫn chưa làm.

## Chạy lại

```powershell
npm run test:coverage
npm audit
node --test tests/e2e/dynamic-concurrency.test.cjs
$env:FLOWDM_EXECUTABLE = (Resolve-Path 'dist/win-unpacked/FlowDM.exe').Path
$env:FLOWDM_LIVE_HTTP = 'https://media.w3.org/2010/05/sintel/trailer.mp4'
node --test --test-name-pattern='public HTTP video' tests/e2e/dynamic-concurrency.test.cjs
Remove-Item Env:\FLOWDM_EXECUTABLE,Env:\FLOWDM_LIVE_HTTP
node scripts/verify-package.cjs
node scripts/smoke-portable.cjs 'dist/FlowDM 0.7.0.exe'
```

Evidence: [v0.7](evidence/v0.7), gồm request logs, cap samples, các lượt RED và kết quả cuối. Tất cả app test dùng state/output riêng. Task 4–10 chưa triển khai.
