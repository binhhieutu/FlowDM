# Task 9 review

Baseline 5e00ab6. Một reviewer độc lập rà soát resolver, platform verifier, native runner, sandbox, Unicode, đăng ký native host và khôi phục sau test.

Finding P2: executable tùy ý có thể được kiểm thử trong khi integrity chứng nhận ASAR canonical khác. Đã sửa bằng scripts/native-target.cjs, kiểm tra executable thực/app.getAppPath()/version/hash, regression RED→GREEN cho đường dẫn khác, ASAR khác, version khác, kiến trúc không hỗ trợ. Không có finding khác cần xử lý trong review.

Các lỗi fixture phát hiện sau đó được sửa theo lỗi thực; không nới assertion hoặc tắt sandbox. Xem PLATFORM_VERIFICATION.md. Runtime chỉ thêm kiểm tra quyền execute Unix; giữ strict bundled Windows hashes, không thêm dependency.

Quyết định phạm vi: dùng WSL2 theo yêu cầu, giữ instance riêng để dùng lại; chỉ công bố Linux x64 trên WSL2. macOS và desktop Linux độc lập chưa xác minh. Không đổi state/profile trình duyệt hằng ngày, không chạy hành động nguồn thật, không publish hoặc cập nhật memory.
