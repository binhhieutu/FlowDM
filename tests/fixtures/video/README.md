# Synthetic video fixtures

These files were generated for FlowDM on 2026-10-23 with FFmpeg 8.1 full build from gyan.dev. Video is FFmpeg's `testsrc` pattern at 160×90, 12 fps; audio is a generated 440 Hz sine wave at 44.1 kHz. Duration is three seconds. No external footage, website video, IDM assets or third-party recording was used.

`direct.mp4` contains H.264/yuv420p video and AAC audio. `list.m3u8` references three MPEG-TS segments. `fmp4.m3u8` references `init.mp4` and three `.m4s` fragments. Both HLS playlists are finite, unencrypted VOD with one-second segment targets and muxed audio/video.

The browser E2E serves these resources locally, compares downloaded bytes with the expected file/ordered initialization and segments, then decodes the completed outputs with FFmpeg. FFmpeg is a test dependency only; FlowDM does not bundle or invoke it for HLS assembly. Fixture checks prove these generated streams, not every codec or website.

## Regenerate

Run the following from `tests/fixtures/video/` with FFmpeg 8.1 available. `-y` overwrites only the named generated fixture outputs in that directory. Different FFmpeg builds may change encoded bytes and metadata; keep playlists and all referenced resources together and rerun the tests after regeneration.

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=160x90:rate=12 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 3 -c:v libx264 -pix_fmt yuv420p -preset ultrafast -g 12 -c:a aac -b:a 32k -movflags +faststart -y direct.mp4
ffmpeg -hide_banner -loglevel error -i direct.mp4 -c copy -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_filename 'segment%02d.ts' -y list.m3u8
ffmpeg -hide_banner -loglevel error -i direct.mp4 -c copy -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'fragment%02d.m4s' -y fmp4.m3u8
```

A quick source decode is `ffmpeg -v error -i direct.mp4 -f null -`. The project E2E performs the equivalent check on actual FlowDM outputs; set `FLOWDM_FFMPEG` if FFmpeg is not on PATH. The final 0.2 verification report records the full run separately; historical 0.1 verification is not rewritten.
