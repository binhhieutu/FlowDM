# FlowDM 0.12.0 — phân loại, quét, proxy và FTP

Ngày 2026-10-26, Asia/Saigon. Baseline 5cb8b99. **Hoàn tất8a,8b,8d,8f,8g;8c và8e chưa đóng toàn bộ.** [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md) · [Review](task8-v12-review.md) · [Evidence](evidence/v0.12/summary.json).

## Sử dụng

Trong **Thiết lập**, bật phân loại và chọn thư mục gốc: Documents/Music/Videos/Images/Archives/Programs/Other. Tên/extension dùng lúc tạo, MIME từ probe trình duyệt bổ sung khi có; chương trình thực thi được ưu tiên thận trọng nếu MIME xung đột. Thư mục chọn rõ ràng được ưu tiên; không di chuyển job đang chạy hay tệp cũ. Tên trùng dùng cơ chế unique/no-overwrite có sẵn.

Bật quét, chọn executable antivirus tin cậy, nhập argv dạng JSONarray, dùng {file} làm một đối số tên tệp; không chạy shell. Cấu hình chế độ scan-only của công cụ nếu không muốn remediation. FlowDM không tự xóa/quarantine. Quét sau xuất tệp có trạng thái riêng; lỗi/timeout/interruption giữ trạng thái tải hoàn tất nhưng xuất hiện ở **Cần xử lý**. **Quét lại** kiểm tra đúng SHA của tệp trước/sau, không tải lại. Pending scan được ghi trước publication; crash/relaunch không làm mất dấu lần quét bị ngắt và không tự arm hành động nguồn.

Proxy **HTTP/CONNECT Basic** hoặc **SOCKS5 USER/PASS, remoteDNS**: nhập host/port/tài khoản khi cần, chọn cập nhật. Cấu hình/auth chỉ RAM, không lưu settings/journal hoặc argv upstreamsecret. Gateway localhost có capability ngẫu nhiên theo phiên; capability có thể xuất hiện trong argv tiến trình media, không phải mật khẩu proxy thật. HTTP/HLS/DASH và browser admission/credential refresh đi cùng tuyến, không fallback trực tiếp. Dừng tác vụ/inspection/crawl trước đổi proxy. Sau restart, tác vụ từng dùng proxy bị giữ: cấu hình lại hoặc nhấn **Cho phép trực tiếp** rồi tự tiếp tục. Không có NTLM/Kerberos, TLS-to-proxy hay FTP qua proxy; FTP bị từ chối trước kết nối nếu proxy đang bật. HTTP/SOCKS5 hop tới proxy không có TLS riêng; HTTPS đích vẫn xác minh TLS.

Dán ftp:// hoặc ftps:// URL tệp không chứa user/password/query. **FTP truyền không mã hóa**; ftps là TLSexplicit(port 21mặc định), xác minh cả control/data certificate. Một kết nối passive EPSV/PASV, REST resume theo SIZE+MDTM+URL/principalhash; nguồn hoặc tài khoản thay đổi bị từ chối giữ partial. Đây là metadata identity, không phải remotehash. User/password chỉ RAM; sau mở lại app chọn **Cấp tài khoản FTP**, rồi nhấn tiếp tục. Listing đã thử trong engine; chưa có GUI duyệt thư mục, implicitFTPS/activeFTP hoặc FTP-proxy.

Clipboard chỉ đọc khi opt-in, không lưu lịch sử và không tự tải. Banner chỉ hiện origin, che path/query/fragment; nhấn xem trước mới đưa URL vào form. So trùng canonicalsource+selection, giữ query có ý nghĩa, bỏ fragment. Desktop có cho phép bản tải trùng; batch báo lỗi từng mục và giữ các job thành công; native từ chối sẽ giữ/tiếp tục tải trong browser. Có thể tắt cảnh báo trùng khi cố ý nhập lại.

Journal **schema 8**, đọc1–8, backup nguyênbyte1–7 trước ghi; không mở state 8 bằng binary0.11/cũ hơn. Preferences public riêng, proxy/password không ghi. URL/query và dữ liệu resume riêng tư vẫn nằm trong lịch sử/cache như trước; không chia sẻ state.

## Gate cuối — đúng artifact candidate3

| Phạm vi | Kết quả |
|---|---|
| Unit/integration | **461/461 pass**,0fail/skip; desktop1/1, localmedia-selection1/1,3Internet opt-in skip trongcoverage |
| Coverage | **93.22% lines/statements;85.92% branches;87.24% functions** |
| Audit/dependency |0vulnerabilities; basic-ftp 6.2.3 exactpin/MIT/no runtime dependencies,16JS/licensefiles verified |
| GUI thiết lập/FTP |2/2; phân loại, scanpass/fail/Quét lại/filekept, duplicateguard, authenticatedproxy, clipboardopt-in; FTPpause/relaunch/RAMbind/RESTsameID+SHA |
| Defender thực |Benign private Unicode file, customscan DisableRemediation exit0, fileunchanged; không thay cấu hình/quét toàn máy |
| Crash |2/2 actualpackaged appkill: HTTPretains69632B/N1→2MiBcorrectSHA/no replay; scanrunning→recoveredfailed→explicitpassed, file64KiBkept |
| Proxy |HTTP/SOCKSmanager2/2 actualHTTP/HLS/DASH, defaultTLSreject/perrequestCApositive,407/SOCKSauth/DNS/cancel/redaction;100nestedrelaytransfers byteexact/cap512 |
| Browser thật |3/3: Chromecredential, Chromeauthenticatedproxy(45requests/authAtOriginfalse), Firefox149.0.2; privateprofiles/native registrations restored |
| Batch/queue/media |Batch7/7; queues2/2(real60s/fakeOS); media5/5 với5YouTube/playlist opt-in skip; SHA/full decode/N1→4→1/refresh/relaunch |
| Portable/integrity |HTTP2MiB pause/relaunch/resume/tools pass; Windows+Linuxdir buildexit0;68runtime/assets/extension +16dependencyfiles khớp |

Windows **dist/FlowDM 0.12.0.exe**,263253934byte, SHA256 **2dd936fa2552d84bf6b878d5e36a918665362eeeb375f937c26e43fe558b04fc**. Checksum dist/FlowDM-0.12.0-SHA256SUMS.txt. ASAR Windows/Linux **9cebfe0a9d1d39e0b03aaeb97f5a1098e5a2844e7507d108e8b0deeabc37a702**. Các GUI/browser/crash gates dùng unpacked có hash này; launcher portable được thử riêng. Candidate1 thất bại do Windows renameEPERM và đã sửa/rebuild; candidate2 đạt nhưng được build lại sau đồng bộ duplicate policy. Chỉ candidate3 là chứng nhận cuối.

## Chưa hoàn tất

**8c:** HTTP CONNECT/SOCKS5 +HTTP/HLS/DASH/browser đã đạt, nhưng YouTube qua proxy chưa có lượt full file đạt. Probe nguồn0.12 dùng video công khai đã biết, truyền4.697.368byte/101resource qua48CONNECT xác thực rồi CDN trả **HTTP 401**. Không có SHA/full decode; không tính PASS, không đổi client/vượt chặn. Lỗi fixture socket của lượt đầu đã sửa riêng trước chẩn đoán. NTLM/Kerberos là milestone riêng chưa có.

**8e:** tất cả volume quan sát là NTFS; không có FAT/exFAT target và chưa chứng minh primitive fallback nguyên tử/no-overwrite phù hợp. Giữ hardlink, capability probe, từ chối FAT/exFAT; có guard FAT32>4294967295byte và fault tests nhưng không tick hỗ trợ chỉ vì copy/rename. [Microsoft filesystem comparison](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison).

Crash được thử ở mức process/fault injection, không tuyên bố chịu mọi mất điện. Linux chỉ builddirectory/integrity; macOS chưa build/chạy. Task 9–10 vẫn chưa hoàn tất. Không push/publish, không đổi proxy/antivirus policy hệ thống, clipboard thật hoặc browser profile hằng ngày. Power luôn fake trong tests. Tên report v6–v11 giữ tên harness cũ nhưng được refresh và đối chiếu actualversion/time/runner/ASAR. Source đầu có thể0.11prebump; không relabel thành source0.12. Textlogs chỉ chuẩn hóa whitespace.
