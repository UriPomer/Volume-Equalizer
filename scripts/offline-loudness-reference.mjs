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

export function calculateReferenceTrackGain(measurement, settings = DEFAULT_REFERENCE_SETTINGS) {
  const loudnessGainDb = settings.targetLufs - measurement.integratedLufs;
  const peakSafeGainDb = settings.truePeakDbtp - measurement.truePeakDbtp;
  const minGainDb = linearToDb(settings.minGain);
  const maxGainDb = linearToDb(settings.maxGain);
  const gainDb = Math.min(Math.max(loudnessGainDb, minGainDb), maxGainDb, peakSafeGainDb);
  let limitedBy = 'target';
  if (gainDb > loudnessGainDb + 1e-6) {
    limitedBy = 'gain-range';
  } else if (gainDb < loudnessGainDb - 1e-6) {
    limitedBy = peakSafeGainDb <= maxGainDb && peakSafeGainDb <= loudnessGainDb
      ? 'true-peak'
      : 'gain-range';
  }

  return {
    gainDb,
    gain: dbToLinear(gainDb),
    predictedOutputLufs: measurement.integratedLufs + gainDb,
    predictedTruePeakDbtp: measurement.truePeakDbtp + gainDb,
    predictedLoudnessRangeLu: measurement.loudnessRangeLu,
    limitedBy
  };
}

export function linearToDb(value) {
  return 20 * Math.log10(Math.max(value, Number.EPSILON));
}

export function dbToLinear(value) {
  return Math.pow(10, value / 20);
}
