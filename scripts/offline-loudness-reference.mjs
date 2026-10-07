import { spawnSync } from 'node:child_process';

export const DEFAULT_REFERENCE_SETTINGS = Object.freeze({
  targetLufs: -21,
  truePeakDbtp: -1,
  minGain: 0.25,
  maxGain: 2
});

export function measureWithFfmpeg(filePath, inputGainDb = 0, settings = DEFAULT_REFERENCE_SETTINGS) {
  const filter = [
    `volume=${inputGainDb}dB`,
    `loudnorm=I=${settings.targetLufs}:TP=${settings.truePeakDbtp}:LRA=50:print_format=json`
  ].join(',');
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', filter,
    '-f', 'null',
    '-'
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error(`FFmpeg loudnorm failed for ${filePath}:\n${result.stderr}`);
  }

  const matches = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!matches?.length) {
    throw new Error(`FFmpeg loudnorm JSON missing for ${filePath}`);
  }
  const stats = JSON.parse(matches.at(-1));
  return {
    integratedLufs: Number(stats.input_i),
    truePeakDbtp: Number(stats.input_tp),
    loudnessRangeLu: Number(stats.input_lra),
    thresholdLufs: Number(stats.input_thresh)
  };
}
