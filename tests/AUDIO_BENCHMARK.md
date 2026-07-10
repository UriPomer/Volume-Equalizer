# Audio normalization benchmark

This benchmark compares both extension strategies against a whole-program offline reference:

- realtime AGC: cumulative loudness estimate with time-varying gain;
- full-track implementation: TypeScript BS.1770 measurement with one static gain;
- offline reference: FFmpeg `loudnorm` whole-program IL/LRA/true-peak measurement with one static, true-peak-safe gain.

The reference deliberately applies one gain to the whole programme. It does not use FFmpeg's dynamic normalization mode, so the source loudness range is preserved.

## Fixtures

Fixture files are downloaded into ignored directory `tests/fixtures/videos/`; large media files are not committed.

| Fixture | Source | Test condition |
|---|---|---|
| Sintel trailer | `https://media.w3.org/2010/05/sintel/trailer.mp4` | Original level |
| Big Buck Bunny trailer | `https://media.w3.org/2010/05/bunny/trailer.mp4` | Input attenuated by 12 dB |
| W3C movie sample | `https://media.w3.org/2010/05/video/movie_300.mp4` | Input boosted by 6 dB; extreme-peak diagnostic only |
| WAI clear layout | `https://media.w3.org/wai/perspective-videos/clear-layout-design.mp4` | Original level; speech and music |
| WAI video captions | `https://media.w3.org/wai/perspective-videos/video-captions.mp4` | Original level; speech and music |

The evaluated fixtures retain real programme dynamics while covering original and quiet levels. The artificial high-level fixture remains in the report for diagnostics but does not affect the result.

## Offline reference

First, FFmpeg measures the complete programme using EBU R128/BS.1770:

```text
ffmpeg -i INPUT -map 0:a:0 \
  -af volume=INPUT_GAIN_DB,loudnorm=I=-21:TP=-1:LRA=50:print_format=json \
  -f null -
```

The benchmark then calculates one fixed gain:

```text
loudness gain = target IL - measured IL
peak-safe gain = target true peak - measured true peak
reference gain = min(clamp(loudness gain, min gain, max gain), peak-safe gain)
```

Predicted output IL and true peak are input measurements plus this fixed gain. Output LRA equals input LRA because no time-varying processing is used.

## Commands

```powershell
npm run test:audio:download
npm run test:audio:benchmark
```

Summary reports:

```text
test-results/audio-benchmark.json
test-results/audio-benchmark.md
```

Detailed 100 ms gain traces are disabled by default. Enable only for diagnostics:

```powershell
npm run test:audio:trace
```

This writes `test-results/*-gain-trace.jsonl`. No trace logger is enabled in the production extension.

## Primary gain metrics

- `Offline fixed gain`: coefficient used from first to last sample by the offline reference.
- `Gain at 10s`: coefficient when calibration ends and the fixed corridor is created.
- `Final gain`: coefficient at the end of playback.
- `Final gain diff dB`: final realtime coefficient minus offline fixed coefficient.
- `Range 10s+`: maximum coefficient minus minimum coefficient from 10 seconds to the end.
- `Changes 10s+`: number of coefficient changes from 10 seconds to the end.

Primary pass criterion:

- coefficient range from 10 seconds to the end no greater than `0.2x`.

Accuracy diagnostic:

- absolute final gain error no greater than `1 dB`.

LUFS and true-peak remain diagnostic fields in JSON, but pass/fail decisions use gain coefficient metrics.
