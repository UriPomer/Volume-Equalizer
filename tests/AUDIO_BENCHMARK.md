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

The default command always writes a report and exits successfully. Use the enforcing form for CI or release gating; it exits non-zero when an evaluated fixture fails:

```powershell
npm run test:audio:enforce
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

## Pass criteria

Evaluated fixtures must satisfy all three conditions:

- actual output integrated loudness is within `±1.5 LU` of the target (stable-first
  contract: steady-state gain moves at most `0.1x/min`, so dynamic programmes trade
  some output precision for gain stability; the calibration phase still converges fast);
- gain `P95–P5` from 10 seconds to the end is no greater than `1.5 dB`;
- maximum gain span from 10 seconds to the end is no greater than `3 dB`.

`P95–P5` measures typical audible movement without letting one sample dominate the result. The maximum span remains a hard guard against large excursions. Both use dB because a coefficient difference such as `0.2x` has different perceptual meaning at different gain levels.

## Diagnostic metrics

- `Final gain diff dB`: final realtime coefficient minus the offline fixed coefficient.
- `Output vs offline LU`: actual realtime output minus the peak-safe offline prediction.
- `Max step dB`: largest 100 ms gain step.

Output loudness is measured after running the gained PCM through the same lookahead limiter used by the extension. Final gain agreement is not a pass criterion: a correct final coefficient can still follow an audibly wrong programme-level trajectory. Gain-rate limits, true-peak safety, and page visibility behavior are covered by their focused unit and integration tests instead of being duplicated here.
