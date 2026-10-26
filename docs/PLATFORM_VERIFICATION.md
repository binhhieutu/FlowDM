# FlowDM 0.13.0 — kiểm thử nền tảng

Ngày 2026-10-26, Asia/Saigon; baseline `5e00ab6`. Task 9 hoàn tất phần Linux x64 trên Ubuntu 24.04 / WSL2 / WSLg. macOS chưa có host và chưa kiểm thử. WSL2 không thay bằng chứng desktop Linux độc lập hoặc macOS. [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md), [summary](evidence/v0.13/summary.json), [review](task9-platform-review.md).

## Kết quả thực tế

| Phạm vi | Kết quả |
|---|---|
| Linux ELF / GUI | User flowdm, kernel 6.18.54.1-microsoft-standard-WSL2, WSLg DISPLAY=:0; Electron 45.0.0, app 0.13.0 |
| HTTP GUI | 3.145.728 byte; dừng ở 114.688 byte, đóng/mở lại giữ đúng tiến độ; GET tiếp từ byte 114.688, không tải lại prefix đã commit; đúng SHA256 |
| HLS | Giữ 15.416 byte qua mở lại, tái sử dụng 1 resource hoàn tất; xuất 47.188 byte, đúng SHA và giải mã toàn file |
| DASH | Giữ 9.722 byte, tái sử dụng 2 resources; xuất 41.891 byte, đúng SHA và giải mã toàn file |
| Chromium Linux | Native messaging, tự bắt HTTP, HLS TS/fMP4 và tải DASH; consent cookie, host-down/disabled fallback; khôi phục đúng đăng ký native host sau test |
| Sandbox | Electron và Chromium bật chromiumSandbox; no-sandbox/disable-setuid-sandbox vắng mặt; renderer sandbox/contextIsolation=true, nodeIntegration=false. Không chạy GUI root hoặc đổi sysctl để né lỗi |
| Unicode | HTTP GUI dùng tên tệp tiếng Việt, thư mục có khoảng trắng/Unicode; host wrapper thực thi qua tên chứa nháy đơn, mode 0700/0600 |
| HTTPS Internet | RFC 9110 từ rfc-editor.org, 502.941 byte; khớp bản tải độc lập, SHA 21c1cdce6ab0e5509b04d84a28000836c7a087cf786efe6f04877ebfff47232a |
| Linux unit/integration | 475 tests: 473 pass, 0 fail, 2 Windows-only skip |
| Windows hồi quy | 475 tests: 471 pass, 0 fail, 4 native-Unix skip; HTTP desktop 1/1, media selection local 1/1 (3 Internet opt-in skip); portable 2 MiB pause/relaunch/resume và tools pass |
| Coverage / audit | Windows main+renderer: 93.18% lines/statements, 85.95% branches, 87.24% functions; npm audit 0 vulnerabilities |

HLS/DASH dùng video fixture thực do dự án kiểm soát qua HTTP server thật, không mock downloader. Resource hoàn tất không được yêu cầu lại; resource đang dở có thể tải lại. Native media suite bỏ qua 1 test YouTube Internet opt-in: không gán kết quả fixture cho YouTube công khai. Firefox Linux chưa chạy trong Task 9.

## Đúng artifact cuối

Linux được build trong Ubuntu. Sau đối chiếu payload, tar được giải nén vào thư mục mới; executable giải nén chạy lại đủ 6 nhóm: integrity, platform-unit (15 pass), sandbox, HTTP resume, HLS/DASH resume và Chromium capture. Bốn test GUI pass, một YouTube opt-in skip. Gate kiểm tra đúng OS/architecture, executable canonical, app.getVersion(), app.getAppPath(), ASAR hash trước/sau; executable/version khác bị từ chối.

- Linux: `dist/flowdm-0.13.0.tar.gz`, 125.715.216 byte, SHA256 `0dbef2d41c7fe5391c7e35a4f83d6eecf179f7f7b067eaeaa876b7dc3445afec`.
- Windows: `dist/FlowDM 0.13.0.exe`, 263.254.043 byte, SHA256 `6b3f60b173c1856fa86ed20189668bda391e4570eea34a55cffdab8d465df11d`.
- ASAR Windows/Linux: `6c962eafd8d22e27df7e9c2fd15259a30929e9c3745446fb9c5d3c539bf92ede`; 68 runtime/assets/extension files và 16 basic-ftp JS/license files khớp nguồn.
- Tar payload có 71 files khớp unpacked build; flowdm, chrome-sandbox và chrome_crashpad_handler giữ mode 0755. Không sửa mode/chạy root để mở app trên host này.
- Checksum: `dist/FlowDM-0.13.0-SHA256SUMS.txt`. Private artifacts, chưa push/publish/ký/notarize.

## Môi trường và chạy lại

Instance riêng `FlowDM-Task9-20261026` được tạo theo yêu cầu dùng WSL2; kernel/WSLg đã có sẵn. Rootfs Ubuntu từ cloud-images.ubuntu.com được đối chiếu SHA256 upstream `8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea` trước import. Dữ liệu distro ở `I:\dich_nguoc\FlowDM\.tmp\task9\ubuntu-instance`, giữ để dùng lại. Không unregister/sửa cấu hình WSL chung.

Từ PowerShell: `wsl -d FlowDM-Task9-20261026 -u flowdm`. Trong Linux shell:

```sh
export PATH=/home/flowdm/task9/bin:/usr/local/bin:/usr/bin:/bin
cd /home/flowdm/task9/source
FLOWDM_EXECUTABLE="$PWD/dist/linux-unpacked/flowdm" npm run test:native -- --platform linux
# Mở GUI để dùng:
./dist/linux-unpacked/flowdm
```

Node npm/test: 22.23.4 Linux x64, đối chiếu nodejs.org SHASUMS256. Linux media tools cài riêng, không nằm trong tar: yt-dlp_linux 2026.10.21 từ official release và khớp SHA2-256SUMS; FFmpeg 6.1.1-3ubuntu5, aria2 1.37.0 từ Ubuntu apt. Phiên bản/hash từng executable ở [platform report](evidence/v0.13/linux-platform-linux-x64.json). Linux/macOS cần cài các công cụ vào PATH hoặc đặt FLOWDM_YTDLP/FLOWDM_FFMPEG/FLOWDM_ARIA2C tuyệt đối. Unix kiểm tra X_OK trước báo sẵn sàng; PATH bỏ qua thư mục tương đối/file thiếu quyền, override sai báo lỗi.

Verifier độc lập: `node scripts/verify-package.cjs --platform linux`, hoặc win/mac-x64/mac-arm64. Không tham số giữ kiểm tra Windows+Linux như cũ. Fixture ASAR mac trên Windows/Linux chỉ kiểm tra logic verifier, không phải build/chạy macOS.

## Lỗi phát hiện và sửa

1. Resolver coi file Unix 0600 là executable: 3 native RED, thêm X_OK, test tool/host GREEN. Có symlink thiếu quyền/mất target.
2. Playwright mặc định tắt sandbox: smoke RED quan sát flag thực; đặt chromiumSandbox=true và kiểm tra app/browser. CDP đọc command line cần enable-automation: thêm flag chỉ cho profile test rồi chạy lại toàn flow.
3. Review độc lập phát hiện executable có thể khác ASAR được chứng nhận: binding canonical path/version/hash, regression RED→GREEN.
4. Bảy test dùng cứng vendor .exe: chuyển sang resolver OS, không thêm skip. Hai fault tests chia range giả định số đoạn phải đổi; Linux quan sát biên đổi mà vẫn 4 đoạn, dẫn đến timeout/hang. Sửa so biên start/end và chờ có giới hạn, giữ nguyên runtime chia luồng.
5. Fixture aria2 đếm thừa response đã đủ Content-Length nhưng còn chờ timer end (peak 5). Kết thúc ngay byte cuối, giải phóng bộ đếm một lần khi finish/close; vẫn assert cap <= N.

Sau build cuối chỉ sửa test/script/docs; ASAR vẫn khớp nguồn. Evidence giữ lượt RED/chẩn đoán và GREEN cuối; tên harness v2/v5 là lịch sử tên file, gate version/hash là 0.13.0. Logs chỉ chuẩn hóa ANSI/trailing whitespace.

## Còn mở

macOS x64/arm64 chưa build/chạy, chưa Gatekeeper/quyền executable/browser capture: không có host. Chưa có desktop Linux độc lập ngoài WSL2 hoặc Linux ARM64. Task 8c YouTube qua proxy vẫn HTTP 401 ở lượt trước, không thử vượt chặn; Task 8e FAT/exFAT chưa hỗ trợ. Task 10 chưa triển khai. Journal giữ schema 8.

Nguồn: [Microsoft WSL GUI](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps), [import distro](https://learn.microsoft.com/windows/wsl/use-custom-distro), [Ubuntu rootfs](https://cloud-images.ubuntu.com/wsl/releases/noble/current/), [Playwright sandbox option](https://playwright.dev/docs/api/class-electron#electron-launch-option-chromium-sandbox), [yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21).
