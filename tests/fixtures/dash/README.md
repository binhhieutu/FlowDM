# Synthetic separate-track DASH fixture

Generated from ../video/direct.mp4 (FlowDM's own testsrc/sine clip, see its README), with FFmpeg 8.1:

```sh
ffmpeg -i tests/fixtures/video/direct.mp4 -map 0:v:0 -map 0:a:0 -c copy -f dash -seg_duration 1 -use_template 1 -use_timeline 1 -y tests/fixtures/dash/manifest.mpd
```

The three-second static MPD has separate H.264 video and AAC audio AdaptationSets. Real-browser E2E detects it, selects it in the popup, downloads through the native host, merges with bundled tools, checks both output streams with ffprobe and fully decodes with FFmpeg.
