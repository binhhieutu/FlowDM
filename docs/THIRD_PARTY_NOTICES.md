# Third-party release gate

FlowDM source dùng MIT ([LICENSE](../LICENSE)); mã/nhận diện riêng, không có binary hoặc tài sản IDM. Basic-ftp 6.2.3 là dependency runtime MIT; license nằm trong npm package và bản app đóng gói đã kiểm tra. Fflate 0.8.3 (MIT, không dependency runtime) chỉ là dev dependency cho script tạo/xác minh ZIP, không đi vào ASAR runtime.

| Thành phần | Nguồn / giấy phép | Trạng thái phân phối |
|---|---|---|
| Electron 45.0.0 | Electron MIT và notices Chromium trong gói | Build cục bộ giữ LICENSE.electron.txt/LICENSES.chromium.html; không tự coi source của app thay thế notices của các thành phần |
| Basic-ftp 6.2.3 | https://github.com/patrickjuchli/basic-ftp — MIT | 16 file JS/license khớp dependency nguồn trong ASAR |
| Fflate 0.8.3 | https://github.com/101arrowz/fflate — MIT | Chỉ build tooling; package-lock ghim version/integrity, source ZIP không chép node_modules |
| yt-dlp 2026.10.21 | https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21 — ISC/MIT và notices bundled dependencies | Hash Windows/Linux đối chiếu; notices lưu cho private binaries |
| FFmpeg 8.1 Gyan full build | https://www.gyan.dev/ffmpeg/builds/ — build bật GPL/version3 | **Chưa đóng gate phát hành binary công khai**: cần tập nguồn tương ứng/build materials cho chính build và thành phần liên kết |
| aria2 1.37.0 Windows build1 | https://github.com/aria2/aria2/releases/tag/release-1.37.0 — GPLv2-or-later | **Chưa đóng gate binary công khai**: nguồn/build materials phải được chuẩn bị theo gói phát hành thực tế |

Lượt này chỉ push/phát hành **mã nguồn và extension**. Không upload Windows/Linux executable archives hoặc thư mục vendor lên GitHub; không tuyên bố chỉ chép license/link nguồn là hoàn tất điều kiện phân phối binary. Các bản executable cục bộ vẫn ở `dist` và bị Git ignore. Trước một bản binary công khai cần rà soát nguồn tương ứng, hướng dẫn build và notices của đúng artifact; xem [FFmpeg legal](https://ffmpeg.org/legal.html), [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html), và [MEDIA_TOOLS](MEDIA_TOOLS.md).
