# Media tool provenance

FlowDM invokes yt-dlp, FFmpeg, and aria2 as separate processes. The MIT license for the application does not replace their licenses. The private Windows build includes three pinned, unsigned executables; packaged runtime resolves only its resource copies and checks their exact byte length and SHA-256 from `assets/media-tools.json` before media download admission. Executable overrides and PATH fallback are rejected in packaged Windows. Automatic executable updates, remote plugins, remote yt-dlp components, user-supplied downloader arguments, aria2 RPC, config/netrc discovery, torrent/Metalink following, and browser-account cookies are disabled.

- **yt-dlp 2026.10.21** — official release: <https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21>. The executable hash is checked against upstream `SHA2-256SUMS`; upstream `LICENSE` and third-party license notices are included. This version is newer than the fix for GHSA-vx4q-3cr2-7cg2/CVE-2026-50574. FlowDM additionally forces DASH and HLS to yt-dlp's native downloader and never sends fragmented manifests to aria2.
- **FFmpeg 8.1 full_build from gyan.dev** — build/source information: <https://www.gyan.dev/ffmpeg/builds/>, source tag `n8.1`: <https://git.ffmpeg.org/ffmpeg.git>, licensing: <https://ffmpeg.org/legal.html>. The executable came from the owner's existing WinGet installation and is checked against the recorded SHA-256. This build enables GPL and version3; its GPLv3 text and actual `ffmpeg -version` configuration are included.
- **aria2 1.37.0 x64 build 1** — official release and verified tag: <https://github.com/aria2/aria2/releases/tag/release-1.37.0>, source: <https://github.com/aria2/aria2/tree/release-1.37.0>, GPL version 2 or later text included as `aria2-GPLv2.txt`. The executable is used only for ordinary HTTP(S) YouTube audio and full-file fallback, never fragmented DASH/HLS manifests. The Windows ZIP release asset and extracted executable have separate pinned hashes. The ZIP hash was cross-checked against the Microsoft WinGet manifest; the aria2 release page does not publish a checksum/signature for that individual ZIP, and the locally recorded value is not described as a publisher-signed checksum.

The build preparation command is explicit:

```text
node scripts/prepare-media-tools.cjs ABSOLUTE_PATH_TO_PINNED_FFMPEG_EXE
```

It downloads the pinned yt-dlp executable and aria2 archive, verifies the recorded archive/executable hashes, extracts only the expected aria2 binary/license, and accepts only the pinned FFmpeg executable. The source ZIP excludes executable vendor files.

This is a private artifact prepared and tested on the owner's machine; no external publication is authorized. Before public redistribution, review and satisfy the corresponding-source and build-material obligations for the exact aria2 and FFmpeg binaries. Source links and copied license texts alone are not a claim that public distribution obligations have been completed.

On Linux/macOS install compatible `yt-dlp` with EJS support, `ffmpeg`, and `aria2c` on `PATH`. Source/development runs may instead use absolute `FLOWDM_YTDLP`, `FLOWDM_FFMPEG`, and `FLOWDM_ARIA2C` paths. Electron's own Node runtime is used for yt-dlp EJS with `ELECTRON_RUN_AS_NODE=1`; the Windows bundle does not require an external Node installation. Child environments omit unrelated API keys, loader options, proxies, and browser credentials. Native media behavior on Linux/macOS has not yet been verified.

When yt-dlp invokes aria2, the transient signed CDN URL is necessarily present in the aria2 child-process command line for that process lifetime and can be inspected by same-user or privileged processes. FlowDM does not copy it into application logs, journal, UI, errors, screenshots, or verification evidence.
