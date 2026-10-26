# Task 10 independent review

Baseline 53f4bc8. Reviewer độc lập kiểm tra profile snapshot/restore, updater policy/manual UI, release ZIP allowlist, IPC, đường dẫn, credentials và cấu hình CI. Không có finding quan trọng cần sửa. Focused Windows review checks: 12 pass, 0 fail, 2 native-POSIX skip.

Các yêu cầu thủ tục được giữ: stage source mới trước tạo ZIP vì dùng git ls-files; gọi snapshot đúng là download-state backup; không public binary kèm media tools khi chưa đủ corresponding-source/build materials. Tất cả snapshot/marker, CLI, signed-manifest fixture và bundle guards được kiểm thử riêng; old/new binary rollback được thử thật trên Windows và WSL2. Có bổ sung kiểm thử Firefox riêng sau full-suite opt-in skip.

Quyết định phạm vi: portable-only và nguồn/extension public, updater thủ công, không hosted job tự chạy khi push; giữ các giới hạn macOS/Task 8c/8e. WSL resource cap chỉ được tạo khi cấu hình cũ không tồn tại và distro duy nhất là môi trường task. Không đổi thông tin đăng nhập, tạo khóa ký hoặc cập nhật memory. Chi tiết và evidence: VERIFICATION_V14.md.
