# Cầu nối trình duyệt FlowDM (tùy chọn)

Tiện ích Manifest V3 chỉ gửi URL HTTP/HTTPS khi chọn **Tải bằng FlowDM** trong menu chuột phải trên liên kết, video hoặc audio có URL trực tiếp. Ứng dụng FlowDM phải đang mở. Không chặn tải của trình duyệt, đọc cookie, chuyển thông tin đăng nhập hoặc tự nhận diện luồng HLS/DASH/blob. Video cần cookie/DRM không được hỗ trợ.

## Cài thủ công Chrome / Edge

Cần Node.js 22 trở lên cài trên máy. Bản desktop không tự đăng ký host hay sửa profile/registry. Các lệnh dưới đây là hướng dẫn để người dùng tự chạy khi muốn bật tính năng.

1. Vào `chrome://extensions` hoặc `edge://extensions`, bật Developer mode và Load unpacked thư mục `extension` của mã nguồn FlowDM. Ghi ID gồm 32 ký tự của tiện ích. Không dùng ID ví dụ bên dưới.
2. Chọn thư mục dữ liệu riêng của tài khoản. Để đồng nhất host và desktop, có thể đặt biến `FLOWDM_DATA_DIR` trước khi khởi chạy FlowDM từ cùng PowerShell:

   ```powershell
   $env:FLOWDM_DATA_DIR = Join-Path $env:LOCALAPPDATA 'FlowDM\state'
   npm start
   ```

   Khi chạy bản đóng gói, đặt cùng biến này trước khi mở file `.exe`. Có thể dùng thư mục dữ liệu desktop hiện tại thay cho giá trị ví dụ; lấy đúng thư mục chứa `browser-bridge.json` khi ứng dụng đang mở. Không dùng thư mục chia sẻ/public cho dữ liệu ứng dụng hoặc bundle host.

3. Từ thư mục mã nguồn, tạo một bundle host ở thư mục mới bằng lệnh rõ ràng:

   ```powershell
   node src/bridge/install.cjs --output "C:\Users\YOUR_USER\AppData\Local\FlowDM\browser-host" --data-dir "C:\Users\YOUR_USER\AppData\Local\FlowDM\state" --extension-id YOUR_32_CHARACTER_EXTENSION_ID --node "C:\Program Files\nodejs\node.exe"
   ```

   Thay mọi đường dẫn và ID bằng giá trị thực. Công cụ chỉ tạo file trong `--output`, không đăng ký host. Bundle chứa bản sao độc lập của host và launcher `.cmd` (Windows) hoặc `.sh` (POSIX). Thư mục đầu ra đã có bundle sẽ báo lỗi, tránh ghi đè. Giữ nguyên vị trí Node và bundle sau khi đăng ký.

4. Windows: tự chạy lệnh đăng ký **tài khoản hiện tại** cho trình duyệt cần dùng (thay đường dẫn JSON):

   ```powershell
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\local.flowdm.bridge" /ve /t REG_SZ /d "C:\Users\YOUR_USER\AppData\Local\FlowDM\browser-host\local.flowdm.bridge.json" /f
   ```

   Với Edge, thay `Google\Chrome` bằng `Microsoft\Edge`. Trên Linux, tự chép JSON tới `~/.config/google-chrome/NativeMessagingHosts/local.flowdm.bridge.json`; macOS Chrome dùng `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.flowdm.bridge.json`. Đường dẫn `path` trong JSON vẫn trỏ tuyệt đối tới launcher trong bundle. Giữ launcher có quyền thực thi. Firefox chưa có manifest tương thích.

5. Mở FlowDM, chọn menu chuột phải trên một liên kết tải HTTP/HTTPS. Huy hiệu `✓` xác nhận desktop đã nhận và trả ID tác vụ; kiểm tra tiến trình trong ứng dụng. Huy hiệu `!` nghĩa là chưa xác nhận: mở ứng dụng, kiểm tra cài đặt và danh sách trước khi gửi lại. Không tự gửi lại bằng ID mới nếu lần trước bị timeout vì thao tác thêm vẫn có thể hoàn tất.

Gỡ: xóa tiện ích, tự xóa khóa registry đã tạo hoặc JSON ở thư mục NativeMessagingHosts, rồi xóa bundle host. Không cần xóa lịch sử tải desktop.

## Hợp đồng và bảo mật

Native Messaging dùng độ dài 4 byte theo byte order máy, sau đó JSON UTF-8, tối đa 1 MiB/frame; không phải JSONL. Host stdout chỉ chứa các frame; lỗi giao thức ghi stderr. Hợp đồng duy nhất:

```json
{"schema":1,"request_id":"unique-id","op":"add","payload":{"url":"https://example.com/file.zip"}}
```

Phản hồi thành công: `{"request_id":"unique-id","ok":true,"payload":{"id":"task-id"}}`. Lỗi chỉ có mã ngắn; không gửi stack/path nội bộ. Request ID từ 1–128 ký tự ASCII chữ/số/`_`/`-`. Trường dư, URL có credentials và scheme khác HTTP/HTTPS bị từ chối. URL có signed query vẫn được chuyển và được desktop lưu theo chính sách lưu tác vụ.

Host chuyển tới named pipe Windows hoặc Unix socket, không mở cổng TCP. Mỗi lần desktop khởi động tạo secret ngẫu nhiên 256 bit, so sánh constant-time; file cấu hình ở dataDir, POSIX mode 0600 và socket 0600. Windows dựa vào thư mục dữ liệu riêng của tài khoản và secret; không tuyên bố chống tiến trình độc hại chạy cùng tài khoản. Không đặt dataDir trên share/public. `close()` đóng các kết nối và xóa cấu hình của phiên hiện tại.

Desktop giữ tối đa 512 request ID, ưu tiên không loại bỏ thao tác đang chờ. Cùng ID/cùng URL được trả cùng kết quả, cùng ID/URL khác bị từ chối. Bộ nhớ đệm hết hiệu lực khi desktop khởi động lại hoặc khi kết quả cũ bị thay thế; đây không phải đảm bảo exactly-once bền vững. Callback được giới hạn 3 giây, host đợi IPC tối đa 4,5 giây. Lỗi timeout là kết quả chưa chắc chắn, không hủy tác vụ thêm đang chạy.

Tài liệu giao thức/đăng ký: [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging). Launcher batch theo mô hình [mẫu host chính thức Chrome](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/nativeMessaging/host).

## Phạm vi đã kiểm thử

Đã kiểm thử trên Windows bằng node:test: frame Unicode, prefix/payload chia nhỏ, nhiều frame, JSON/UTF-8 lỗi, kích thước quá giới hạn, xác thực, schema/URL, chống thêm trùng, callback lỗi/timeout, đóng server, subprocess host thật và desktop vắng mặt. Extension được kiểm tra với API trình duyệt giả lập, bundle được tạo trong thư mục tạm. Không đăng ký host lên máy thật; chưa tuyên bố đã thử menu Chrome/Edge thực tế hoặc native POSIX. Chạy `node --test tests/bridge/*.test.cjs` để lặp lại.
