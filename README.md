# FlowDM 0.13

Task 9: Linux x64/WSL2 đã kiểm thử GUI HTTP/HLS/DASH, tải tiếp sau mở lại và bắt link Chromium; macOS chưa có host. Xem [PLATFORM_VERIFICATION](docs/PLATFORM_VERIFICATION.md). Task 8: phân loại/quét/proxy/FTP/clipboard/crash 0.12: [VERIFICATION_V12.md](docs/VERIFICATION_V12.md) (8c/8e chưa đóng toàn bộ). Nhập hàng loạt, link trên trang và Site Grabber giới hạn 0.11: [VERIFICATION_V11.md](docs/VERIFICATION_V11.md). Queue, lịch lặp và hành động hoàn tất 0.10: [VERIFICATION_V10.md](docs/VERIFICATION_V10.md). Cấp lại phiên HTTP/HLS và Firefox 0.9: [VERIFICATION_V9.md](docs/VERIFICATION_V9.md). Lựa chọn media và đổi kết nối media 0.8: [VERIFICATION_V8.md](docs/VERIFICATION_V8.md). Coverage/audit, build, portable và GUI Windows 0.12 đã kiểm tra; số liệu và phạm vi bằng chứng trong báo cáo. Kiểm chứng chia range động/đổi kết nối 0.7: [VERIFICATION_V7.md](docs/VERIFICATION_V7.md). Làm mới link 0.6: [VERIFICATION_V6.md](docs/VERIFICATION_V6.md). Lịch sử checkpoint 0.5: [VERIFICATION_V5.md](docs/VERIFICATION_V5.md).

Ứng dụng tải HTTP/HTTPS desktop với tiện ích Chromium tự bắt tải xuống và chọn tải video HLS VOD, DASH tĩnh giới hạn và YouTube công khai. Mã nguồn và nhận diện riêng; không dùng mã hay tài sản IDM và không tuyên bố đủ mọi tính năng IDM.

## Dùng trên Windows

Bản dùng trên Windows: `dist/FlowDM 0.13.0.exe`; checksum tại `dist/FlowDM-0.13.0-SHA256SUMS.txt`. Bản 0.13 đã kiểm tra GUI HTTP trên `dist/win-unpacked/FlowDM.exe`; portable đã qua launcher, HTTP pause/relaunch/resume và công cụ đi kèm. Các gate Windows media/queue/browser đầy đủ của 0.12 nằm trong báo cáo tương ứng. Bản Windows đóng gói không cần cài Node.js; kèm yt-dlp 2026.10.21, FFmpeg 8.1 và aria2 1.37.0 đã ghim hash cùng giấy phép trong private artifact. Nhấn **Thêm liên kết** để chọn URL, thư mục, tên tệp và số kết nối tối đa 1/2/4/8/16 cho mỗi lượt tải. Có tạm dừng/tiếp tục, hủy/thử lại, tìm kiếm/lọc, hẹn giờ, giới hạn tốc độ và SHA-256 sau tải. Không tự mở hay chạy tệp tải về; không ghi đè tệp có sẵn.

Khi đang tải HTTP, chọn tác vụ → **Kết nối tối đa** → **Áp dụng kết nối** để đổi N và giữ tiến độ. Worker rảnh tự chia phần còn thiếu; phần mới tối thiểu 256 KiB nên vùng nhỏ có thể dùng ít kết nối hơn mức chọn. Chi tiết phân biệt số kết nối đang chạy với số vùng dữ liệu. Giới hạn tốc độ tổng không bị reset khi đổi N. Máy chủ không hỗ trợ chia byte an toàn vẫn dùng một stream liên tục. HLS đổi số worker ngay trong lượt tải; khi giảm N sẽ chờ request đang chạy đạt mức mới. DASH/YouTube native fragment đủ điều kiện sẽ tạm dừng, chờ child kết thúc/lưu checkpoint rồi tiếp tục cùng tác vụ với N mới. HTTP fallback và pha không thể xác minh checkpoint an toàn sẽ khóa thao tác đổi N khi đang chạy.

Tải tệp trực tiếp nhiều kết nối và resume giữ byte cần server hỗ trợ Range và strong ETag phù hợp. Khi phần dở không thể xác minh cùng phiên bản hoặc cache mất/hỏng/dư bytes, ứng dụng giữ tiến độ và báo lỗi; không tự tải lại toàn bộ. HLS dùng tối đa số worker đã chọn, giữ một cửa sổ trượt hữu hạn và ghép các đoạn đúng thứ tự qua tệp tạm trên đĩa; không giữ toàn bộ video trong RAM. DASH dùng tải fragment native của yt-dlp với cùng giới hạn kết nối. HLS/DASH/YouTube dùng checkpoint để giữ các đoạn đã hoàn tất qua tạm dừng, đóng bình thường và mở lại ứng dụng. Khi tiếp tục, HLS dựng lại tệp ghép từ các đoạn đã kiểm tra trên đĩa; DASH/YouTube dùng trạng thái fragment native đã đối chiếu. Chỉ đoạn đang dở có thể phải tải lại. Hủy xóa dữ liệu tạm; xóa lịch sử không xóa tệp đã hoàn tất.

Nếu link hết hạn: **Tạm dừng → Cập nhật liên kết → dán link mới → Kiểm tra và cập nhật → Tiếp tục**. Tác vụ giữ ID, vị trí lưu và tiến độ qua mở lại app. Link mới phải cùng origin; HTTP cần strong ETag/kích thước/range phù hợp, HLS cần đúng manifest và resource identity, DASH cần đúng MPD và final origin/path, YouTube cần cùng video/format. Link CDN khác origin, manifest thay đổi hoặc credentials đã mất sẽ bị từ chối. Checkpoint DASH 0.5 thiếu thông tin resource base vẫn giữ bytes nhưng không thể resume/refresh an toàn trong 0.6; tạo tác vụ mới nếu không đủ bằng chứng. HTTP fallback của yt-dlp thiếu validator vẫn giữ guard từ chối nối, chưa có byte-resume cho mọi định dạng.

Giới hạn tốc độ từng lượt tải và từng queue dùng KiB/s. Chọn **Tạo hàng đợi** để đặt tên, số lượt đồng thời, tốc độ, ngày trong tuần, múi giờ IANA và khung giờ; giờ kết thúc sớm hơn giờ bắt đầu nghĩa là qua đêm. Chọn queue khi thêm link, chuyển tác vụ đã dừng bằng menu trên dòng và đổi thứ tự bằng ↑/↓. Tổng app vẫn tối đa ba lượt và ba lượt/host. Tạm dừng queue trước khi sửa giới hạn/lịch. Băng thông queue chia cố định theo số slot: slot trống không tự nhường tốc độ, tốc độ tức thời có thể dao động do buffering.

Lịch lặp chỉ chạy công việc còn chờ, không tạo bản tải mới của tệp đã hoàn tất. Đến giờ dừng, app lưu checkpoint rồi pause; phiên kế tiếp tiếp tục. Tác vụ đang chạy trong queue có lịch giữ quyền tự tiếp tục sau mở lại app; tác vụ bạn tự pause vẫn chờ bạn nhấn tiếp tục. Máy và FlowDM phải đang hoạt động; không có dịch vụ tự đánh thức máy và không chạy bù mọi khung giờ đã lỡ. DST và clock lùi có guard không mở lại phiên đã đóng.

Mỗi queue có **Không làm gì / Thông báo / Tắt máy / Ngủ**. Chỉ queue không rỗng, tất cả tác vụ thành công mới đủ điều kiện. Tắt/ngủ chờ toàn app hết công việc rồi đếm ngược ít nhất 60 giây, có nút hủy; nếu nhiều queue đủ điều kiện thì hành động của queue hoàn tất trước được ưu tiên. Thêm/tiếp tục/chuyển/sửa công việc, đóng app hoặc suspend/resume sẽ hủy hành động chờ. Không khôi phục đếm ngược sau restart; OS có thể từ chối quyền. Kiểm thử dùng bộ giả lập, chưa thực hiện tắt/ngủ máy thật.

## Dùng trên Linux x64 / WSL2

Gói `dist/flowdm-0.13.0.tar.gz` được build trong Ubuntu WSL2, giải nén rồi kiểm thử GUI HTTP/HLS/DASH, pause/đóng/mở/resume, SHA/decode và bắt link Chromium. Cần Electron libraries, X11/Wayland và yt-dlp/FFmpeg/aria2c trên PATH; chạy user thường với sandbox bật. Instance thử `FlowDM-Task9-20261026` được giữ để dùng lại. [Cách mở và chạy lại test](docs/PLATFORM_VERIFICATION.md). macOS và Linux desktop độc lập ngoài WSL2 chưa kiểm thử.

## Thiết lập tải xuống 0.12

Bật phân loại theo extension/MIME trước khi tạo job; thư mục chọn rõ ràng được ưu tiên. Quét antivirus opt-in bằng executable/argv riêng không shell, sau publication; lỗi quét vào Cần xử lý, tệp được giữ và có Quét lại. MicrosoftDefender customscan với DisableRemediation đã thử trên tệp lành tính. Không coi exit0 của scanner là bảo đảm an toàn tuyệt đối.

Proxy HTTP/CONNECT Basic hoặc SOCKS5 USER/PASS(remoteDNS), auth chỉRAM; dừng hoạt động trước đổi. Tác vụ từng dùng proxy phải cấu hình lại hoặc chọn Cho phép trực tiếp sau restart. HTTP/HLS/DASH/browser qua proxy đã đạt; YouTubeproxyfull file bị CDN401 nên8c chưa tick toàn bộ. Không hỗ trợ NTLM/Kerberos hay FTPquaProxy; không fallback trực tiếp.

FTP/ftps URL tệp không userinfo, explicitTLS/default21/passive/N1. FTP không mã hóa; FTPS xác minh cert. REST resume dựa SIZE+MDTM và principalhash, không phải remotecontenthash; tài khoản chỉRAM/cấp lại rồi tự resume. Clipboard opt-in chỉ đề nghị, origin được hiện thay vì token/path/query; không lịch sử hay tự tải. Guardtrùngsource+format+query áp dụng cảdesktop/batch/native, có manualoverride/settings tắt.

FAT/exFAT vẫn bị từ chối;8e chưa chứng minh fallbacknative. Crash process đã thử thật, không có bảo đảm mọi powerloss. [Chi tiết và bằng chứng0.12](docs/VERIFICATION_V12.md).

## Nhập hàng loạt và lấy link

**Nhập link hàng loạt** → mỗi dòng một URL → **Xem trước** → lọc/chọn → chọn queue, thư mục và kết nối → tạo các lượt đã chọn. Mặc định không chọn mục nào; tối đa1.000URL/512KiB, loại trùng trong danh sách, giữ query. Trong popup Chrome/Firefox dùng **Lấy link trên trang** → chọn → **Xem trước trong FlowDM**, rồi xác nhận tải ở desktop.

Site Grabber chỉ chạy khi nhấn bắt đầu: cùng origin, sâu≤2, HTTPrequests≤100 kể cả redirect, UTF-8HTML≤2MiB/trang,10s/trang,60s/crawl, một request đồng thời. Không JS/credentials/subresources; route không extension hoặc HTML/PHP/ASP/JSP/CGI/CFM được đi tiếp, file/suffix khác chỉ để chọn. Dừng giữ các job đã tạo. Đây là tập con giới hạn; xem [báo cáo0.11](docs/VERIFICATION_V11.md).

## Kết nối trình duyệt

Với Firefox, chọn **Mozilla Firefox**, xuất thư mục riêng rồi nạp `manifest.json` bằng **Load Temporary Add-on** tại `about:debugging#/runtime/this-firefox`. ID được điền sẵn; nhấn **Kết nối**. Addon unsigned nạp tạm phải nạp lại khi đóng Firefox. [Hướng dẫn trình duyệt](docs/BROWSER.md) mô tả các bước cho từng browser.

**Nâng cấp lên 0.13:** xuất lại tiện ích, Reload/nạp lại và ngắt/kết nối lại native host để dùng cùng bundle mới và các thao tác cấp lại phiên. Journal nâng schema 8 và backup nguyên byte trước ghi; không dùng binary0.11/cũ hơn mở state 8.

**HTTP/HLS cần đăng nhập sau mở lại app:** tạm dừng tác vụ → **Kết nối lại từ trình duyệt** → mở trang đúng origin trong phiên đã đăng nhập → popup FlowDM bật quyền cho origin đó → **Tìm tác vụ cần kết nối lại** → **Kết nối lại** → về desktop nhấn **Tiếp tục**. Yêu cầu có hiệu lực 2 phút; headers/nonce chỉ nằm trong RAM. Giữ nguyên ID/byte/đoạn tải, không tự resume; nguồn thay đổi sẽ bị từ chối. Authenticated DASH/YouTube vẫn bị chặn bởi adapter.


1. Mở **Kết nối trình duyệt** trong FlowDM, chọn Chrome/Edge/Chromium phù hợp rồi nhấn **Mở thư mục tiện ích**.
2. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode, chọn **Load unpacked / Tải tiện ích đã giải nén** và chọn thư mục vừa xuất.
3. Sao chép ID 32 ký tự của tiện ích, dán vào FlowDM và nhấn **Kết nối**. Giữ ứng dụng đang mở.

Windows dùng runtime Electron/Node được sao chép vào vị trí ổn định dành cho native host; không cần Node.js ngoài. Đăng ký chỉ áp dụng cho tài khoản hiện tại. **Ngắt kết nối** hoàn lại đăng ký trước đó nếu mục đăng ký vẫn do FlowDM quản lý. Xem [hướng dẫn trình duyệt](docs/BROWSER.md).

Khi nâng cấp từ 0.3 hoặc bản cũ hơn, trường `connections` mới đã được thêm vào giao thức Native Messaging. Mở **Kết nối trình duyệt**, ngắt/kết nối lại native host, xuất lại thư mục tiện ích rồi nhấn **Reload / Tải lại** cho tiện ích unpacked trong `chrome://extensions` hoặc `edge://extensions`. Nếu bỏ qua bước này, bản tiện ích/host cũ có thể không chuyển đúng lựa chọn số kết nối. Khi nâng cấp từ 0.4 lên 0.5, cũng xuất lại tiện ích, Reload và kết nối lại native host để dùng đúng bundle mới.

Tự bắt tải HTTP(S) bật mặc định khi cài tiện ích và có thể tắt trong popup. Trình duyệt chỉ hủy lượt tải sau khi FlowDM kiểm tra truy cập, lưu tác vụ và trả xác nhận đúng ID. Cầu nối vắng mặt, lỗi truy cập/đăng nhập, phản hồi HTML không phù hợp hoặc hết thời gian chờ sẽ giữ/tiếp tục lượt tải trình duyệt. Timeout vẫn có thể tạo một tác vụ đến muộn; kiểm tra hàng đợi trước khi gửi lại.

Cookie, Authorization, Referer và User-Agent mặc định không được chuyển. Nếu cần đăng nhập, mở popup, chọn đúng tên miền của trang hoặc tài nguyên/CDN rồi bật quyền rõ ràng. Cookie được lấy theo URL với quyền tùy chọn; bearer token cần một yêu cầu mạng mới sau khi cấp quyền. Headers chỉ ở bộ nhớ và bị bỏ khi chuyển sang origin khác.

Tiện ích nhận diện video/audio/source động và các manifest mạng, kể cả player dùng blob. Nhấn **Tải video bằng FlowDM** cạnh media, nút YouTube trên trang, hoặc chọn mục trong popup; dán MPD/URL YouTube cũng tự nhận dạng loại phù hợp. Phát hiện media không tự tải mọi luồng. Hỗ trợ tệp trực tiếp, HLS VOD không mã hóa dạng MPEG-TS/fMP4, và DASH tĩnh không DRM có video/audio tách riêng để ghép MP4.

YouTube chỉ dành cho video công khai ở URL chuẩn `watch`, `shorts`, `youtu.be` hoặc bản mobile tương ứng. Mặc định ưu tiên video HLS native H.264 tối đa 1080p; aria2 tải phần âm thanh AAC/M4A qua HTTP và tải tệp HTTP thông thường khi phải dùng fallback, sau đó FFmpeg ghép MP4. Trong **Thêm liên kết**, dán DASH/YouTube rồi **Kiểm tra chất lượng / playlist** để chọn chính xác video/audio theo ID, codec và độ phân giải hoặc chọn chỉ âm thanh; dung lượng là ước lượng nếu nguồn cung cấp. 4K phụ thuộc định dạng công khai có sẵn; 0.8 đã kiểm chứng 4K bằng DASH do dự án tạo, nguồn YouTube thật đã kiểm chứng 1080p. Có thể chọn tối đa 8 phụ đề VTT/SRT thủ công/tự động; phụ đề được nhúng vào MKV. Video không phụ đề dùng MP4/WebM/MKV theo codec, audio-only giữ container tương thích. Khi định dạng đã chọn biến mất hoặc thay đổi không tương thích, ứng dụng từ chối thay vì tự chọn định dạng khác. URL playlist YouTube chuẩn cho xem trước tối đa 100 mục và chỉ tạo job cho mục đã chọn; lỗi một mục được báo riêng. Phép thử playlist công khai 0.8 đã kiểm chứng preview/chọn mục, submit đúng một job và giữ job qua pause/mở lại; chưa tải toàn batch. Không hỗ trợ DRM, live, video cần đăng nhập/age wall, PO token, plugin hoặc cơ chế vượt bảo vệ. DASH chỉ là tập con tĩnh: từ chối DRM, live, CDATA, tham chiếu namespace/remote, byte range và các manifest phức tạp ngoài parser hiện có. Checkpoint HLS pin SHA-256 của toàn bộ manifest media đã chọn; DASH pin bytes MPD; YouTube pin định dạng và cấu trúc HLS ổn định qua lần trích xuất mới. Khi nội dung/định dạng đổi, metadata thiếu hoặc cache hỏng, tác vụ báo lỗi và giữ cache để kiểm tra thay vì âm thầm tải lại toàn bộ hay ghép khác nội dung. Phần âm thanh HTTP không đủ validator an toàn có thể tải lại riêng, trong khi các fragment video đã hoàn tất vẫn được giữ. DASH/YouTube không gửi Cookie, Authorization, Referer hay User-Agent. Xem [phạm vi media](docs/media-report.md).

Nếu đang dùng IDM, tắt tích hợp IDM cho trình duyệt dùng FlowDM để tránh hai trình quản lý cùng bắt một tải. Kiểm thử thấy IDM vẫn can thiệp Chrome thường dù đã bỏ tiện ích IDM. Không cần thay đổi profile thật để thử bản này.

## Dữ liệu và tương thích

- `downloads.json` và dữ liệu tạm nằm ở `app.getPath('userData')/state`; đích mặc định là `Downloads/FlowDM`. Có thể đặt `FLOWDM_DATA_DIR` và `FLOWDM_DOWNLOAD_DIR` bằng đường dẫn tuyệt đối.
- URL, gồm signed query/token cần để resume, được lưu trong lịch sử. Không chia sẻ thư mục dữ liệu. Headers nhạy cảm không được lưu; HTTP/HLS cần đăng nhập có thể cấp lại phiên từ trình duyệt sau khi khởi động.
- Với phần âm thanh hoặc fallback HTTP qua aria2, URL media CDN có chữ ký do yt-dlp trích xuất xuất hiện trong command line của tiến trình con trong thời gian tiến trình chạy và có thể được tiến trình cùng tài khoản hoặc quyền cao hơn quan sát. FlowDM không sao chép URL đó vào journal, log, giao diện, lỗi, ảnh hoặc bằng chứng test.
- Journal 0.12 dùng schema v8 lưu tasks và queues nguyên tử, đọc v1–v8; dữ liệu cũ được gán vào queue Default theo thứ tự cũ; trước migration từ schema cũ sẽ backup nguyên byte journal vào `downloads.v<version>.<UUID>.backup.json`, backup lỗi thì chặn nâng cấp. Vùng HTTP động tối đa 1.024, kết nối hoạt động vẫn tối đa 16/tác vụ. Không mở state schema v8 bằng binary 0.11 hoặc cũ hơn; giữ bản sao cả thư mục state trước nâng cấp nếu cần quay lại. Tác vụ media cũ không tự có checkpoint cho dữ liệu đã bị bản cũ xóa.
- Checkpoint nằm trong thư mục dữ liệu riêng của từng tác vụ (`resumePolicy: checkpoint`), gồm fragment và tệp trạng thái native. Metadata do FlowDM ghi không chứa browser headers hay signed URL CDN trích xuất; tệp native riêng có thể chứa thông tin URL nhạy cảm, nên không chia sẻ cache. Tạm dừng/đóng bình thường chờ worker và tiến trình con kết thúc, flush và lưu trạng thái; không bảo đảm phục hồi sau mọi kiểu mất điện, hỏng đĩa hoặc kill cưỡng bức.
- Giới hạn mặc định 100 GiB/tệp, ba lượt tải đồng thời, tối đa ba lượt/host; UI chọn 1/2/4/8/16 kết nối. Đây là mức trần theo lượt tải; tệp nhỏ, playlist ít đoạn hoặc server/CDN hạn chế Range có thể dùng ít kết nối hơn. Server không hỗ trợ Range dùng một luồng. Cần chỗ trống cho fragment được giữ, tệp ghép và tệp cuối. Engine ngoài giới hạn workspace ở tối đa ba lần giới hạn kích thước tác vụ; giới hạn này không thay thế kiểm tra dung lượng đĩa thực tế.
- Đích cần filesystem hỗ trợ hard link như NTFS/ext4/APFS; FAT/exFAT chưa hỗ trợ. FTP/explicitFTPS passive và proxyHTTP/SOCKS5 đã có; không NTLM/Kerberos, implicitFTPS/activeFTP, FTPquaProxy, nhập dữ liệu IDM hay tự cập nhật.

## Chạy nguồn, build và kiểm thử

Cần Node.js 22+ và phiên desktop đồ họa:

```sh
npm ci
npm start
npm test
npm run test:coverage
npm run test:e2e
```

Đóng gói bằng `npm run dist:win`, `npm run dist:linux` hoặc `npm run dist:mac`. Windows là nền tảng đã chạy kiểm thử desktop và trình duyệt thật; báo cáo 0.5 ở [VERIFICATION_V5.md](docs/VERIFICATION_V5.md). Linux x64 0.13 đã chạy GUI HTTP/HLS/DASH và Chromium trên Ubuntu WSL2; macOS chưa có host, chưa build/chạy. Xem [phạm vi thực tế](docs/PLATFORM_VERIFICATION.md). Linux cần thư viện Electron, X11/Wayland và sandbox hoạt động; không tắt sandbox hoặc chạy root để bỏ qua lỗi môi trường. Bản chưa ký/notarize có thể cần phê duyệt theo chính sách hệ điều hành.

Source ZIP không kèm `vendor/media-tools`. Khi chuẩn bị bản Windows từ nguồn, dùng lệnh rõ ràng `node scripts/prepare-media-tools.cjs "C:\đường-dẫn\ffmpeg.exe"`; script chỉ chấp nhận FFmpeg 8.1 full build Gyan đúng hash và tải yt-dlp/aria2 đã ghim phiên bản/hash. Linux/macOS cần tự cài `yt-dlp`, `ffmpeg` và `aria2c` trên `PATH`; có thể dùng biến đường dẫn tuyệt đối `FLOWDM_YTDLP`, `FLOWDM_FFMPEG` và `FLOWDM_ARIA2C` khi chạy từ nguồn. Linux x64/WSL2 đã kiểm thử media với công cụ native, macOS chưa kiểm thử. CI đối chiếu hash đã ghim và sẽ từ chối binary khác; việc build archive trong CI không phải bằng chứng runtime native.

E2E 0.12 đã chạy Windows với Chromium156, Firefox149.0.2 và Electron; HTTP/HLS có cookie phiên được kiểm tra qua pause/mở lại/rebind/resume. Firefox dùng ACK-before-cancel, Chromium giữ pause-before-ACK; khi ACK muộn vẫn có thể tạo lượt trùng. Các kiểm thử cũ dùng Chrome for Testing156 và Electron, kiểm tra tự bắt tải, tắt bắt tải, host vắng mặt, đăng nhập khi chưa/có consent, nút media chống click giả, byte tệp trực tiếp/HLS TS/fMP4 và giải mã bằng FFmpeg. Profile thử dùng bản Chromium được đổi tên để tránh hook IDM; IDM và profile thật của chủ máy không bị chỉnh sửa. Bản sao tiện ích thử được cấp sẵn API cookies tùy chọn để tránh hộp quyền tự động, còn consent theo origin của sản phẩm vẫn được kiểm tra bật/tắt.

Có thể cấu hình E2E bằng `FLOWDM_BROWSER_EXECUTABLE`, `FLOWDM_FFMPEG` và `FLOWDM_EXECUTABLE`; FFmpeg trong biến này dùng xác minh fixture media. Bằng chứng lịch sử 0.4: kiểm thử nguồn trên Windows đã tải Big Buck Bunny công khai từ YouTube ở N=4 trong 21,258 giây; toàn bộ E2E gồm xác minh hoàn tất trong 49,787 giây. Video dài 634,624 giây, 288.972.332 byte, H.264 1920×1080/AAC và qua bước giải mã toàn bộ riêng bằng FFmpeg. Fixture cục bộ có độ trễ 400 ms mỗi tài nguyên cho kết quả byte-exact: HLS N=1 mất 1.317 ms/peak 1, N=4 mất 457 ms/peak 3; DASH N=1 mất 5.132 ms/peak 1, N=4 mất 2.862 ms/peak 4. Đây là số đo của fixture/máy kiểm thử, không phải cam kết tăng tốc trên mọi server, CDN hoặc hệ điều hành. [VERIFICATION_V3.md](docs/VERIFICATION_V3.md), [VERIFICATION_V2.md](docs/VERIFICATION_V2.md) và [VERIFICATION.md](docs/VERIFICATION.md) là bằng chứng lịch sử, không phải xác nhận 0.5. Kết quả tiếp tục tải, mở lại và bản đóng gói 0.5 xem [VERIFICATION_V5.md](docs/VERIFICATION_V5.md).

Kiến trúc: `src/core` tải/journal; `src/media` HLS; `src/browser` thiết lập và kiểm tra tiếp nhận; `src/bridge` Native Messaging/IPC; `src/ui` giao diện Electron sandbox. Xem [DESIGN.md](docs/DESIGN.md) và [browser-capture-report.md](docs/browser-capture-report.md).
