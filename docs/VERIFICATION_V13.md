# FlowDM 0.13.0

Task 9: Linux x64 trên Ubuntu WSL2/WSLg đã chạy native ELF/GUI, HTTP/HLS/DASH pause/relaunch/resume, SHA/decode và bắt link Chromium. macOS chưa có host và chưa kiểm thử; Task 9 còn mở phần Mac.

[Chi tiết nền tảng](PLATFORM_VERIFICATION.md) · [Evidence](evidence/v0.13/summary.json) · [Review](task9-platform-review.md) · [Checklist](superpowers/plans/2026-10-25-flowdm-roadmap-checklist.md).

Linux: 473 pass, 0 fail, 2 Windows-only skip. Windows: 471 pass, 0 fail, 4 native-Unix skip; coverage 93.18/85.95/87.24%, audit 0. Native gate 6 nhóm đạt, 4 GUI tests pass và 1 YouTube opt-in skip; portable Windows HTTP/tools pass. Cả ASAR đối chiếu 68 runtime + 16 dependency files.
