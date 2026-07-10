import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REFERENCE_SETTINGS,
  calculateReferenceTrackGain,
  linearToDb,
  measureWithFfmpeg
} from './offline-loudness-reference.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'audio-videos.json'), 'utf8'));
const fixtureDir = join(root, 'tests', 'fixtures', 'videos');
const resultsDir = join(root, 'test-results');
const traceEnabled = process.argv.includes('--trace');
const compiledDir = join(tmpdir(), `bili-volume-audio-benchmark-${process.pid}`);

for (const fixture of fixtures) {
  if (!existsSync(join(fixtureDir, fixture.file))) {
    throw new Error(`Missing ${fixture.file}. Run npm run test:audio:download first.`);
  }
}

compileMeasurementModules(compiledDir);
const require = createRequire(import.meta.url);
const { LoudnessMeter } = require(join(compiledDir, 'loudness-meter.js'));
const { RealtimeAgc, chooseControlLoudness } = require(join(compiledDir, 'gain-control.js'));
const { calculateFullAudioGain, TruePeakEstimator } = require(join(compiledDir, 'full-audio-analysis.js'));

mkdirSync(resultsDir, { recursive: true });
const reports = [];

try {
  for (const fixture of fixtures) {
    const filePath = join(fixtureDir, fixture.file);
    const referenceMeasurement = measureWithFfmpeg(
      filePath,
      fixture.inputGainDb,
      DEFAULT_REFERENCE_SETTINGS
    );
    const reference = calculateReferenceTrackGain(referenceMeasurement, DEFAULT_REFERENCE_SETTINGS);
    const pcm = decodeStereoPcm(filePath, fixture.inputGainDb);
    const simulation = simulateRealtime(pcm, {
      LoudnessMeter,
      RealtimeAgc,
      chooseControlLoudness,
      calculateFullAudioGain,
      TruePeakEstimator
    });

    const report = {
      id: fixture.id,
      title: fixture.title,
      sourceFile: fixture.file,
      inputGainDb: fixture.inputGainDb,
      includedInEvaluation: fixture.includeInEvaluation !== false,
      durationSeconds: round(pcm.durationSeconds, 3),
      offlineReference: {
        ...mapRounded(referenceMeasurement),
        ...mapRounded(reference)
      },
      fullTrackImplementation: {
        integratedLufs: round(simulation.fullIntegratedLufs, 3),
        measurementDiffLu: round(simulation.fullIntegratedLufs - referenceMeasurement.integratedLufs, 3),
        gain: round(simulation.fullGain, 6),
        gainDb: round(linearToDb(simulation.fullGain), 3),
        gainDiffDb: round(linearToDb(simulation.fullGain) - reference.gainDb, 3)
      },
      realtime: {
        outputIntegratedLufs: round(simulation.outputIntegratedLufs, 3),
        outputVsOfflineLu: round(simulation.outputIntegratedLufs - reference.predictedOutputLufs, 3),
        finalGainDb: round(linearToDb(simulation.finalGain), 3),
        finalGainDiffDb: round(linearToDb(simulation.finalGain) - reference.gainDb, 3),
        minGainDb: round(linearToDb(simulation.minGain), 3),
        maxGainDb: round(linearToDb(simulation.maxGain), 3),
        gainSpanDb: round(linearToDb(simulation.maxGain / simulation.minGain), 3),
        maxStepDb: round(simulation.maxStepDb, 3),
        gainAt10Seconds: round(simulation.gainAt10Seconds, 6),
        finalGain: round(simulation.finalGain, 6),
        finalGainDiffDb: round(linearToDb(simulation.finalGain) - reference.gainDb, 3),
        gainRangeAfter10X: round(simulation.gainRangeAfter10X, 6),
        gainChangesBefore10: simulation.gainChangesBefore10,
        gainChangesAfter10: simulation.gainChangesAfter10
      }
    };
    report.realtime.variationPass = report.realtime.gainRangeAfter10X <= 0.2;
    report.realtime.gainAccuracyPass = Math.abs(report.realtime.finalGainDiffDb) <= 1;
    report.realtime.pass = report.realtime.variationPass;
    reports.push(report);

    if (traceEnabled) {
      const tracePath = join(resultsDir, `${fixture.id}-gain-trace.jsonl`);
      writeFileSync(tracePath, simulation.trace.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }
  }

  const generatedAt = new Date().toISOString();
  const summary = { generatedAt, targetLufs: DEFAULT_REFERENCE_SETTINGS.targetLufs, traceEnabled, reports };
  writeFileSync(join(resultsDir, 'audio-benchmark.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(resultsDir, 'audio-benchmark.md'), renderMarkdown(summary));
  console.log(renderConsole(reports));
  console.log(`report - ${join(resultsDir, 'audio-benchmark.md')}`);
  console.log(`detailed gain trace - ${traceEnabled ? 'enabled' : 'disabled (use npm run test:audio:trace)'}`);
} finally {
  rmSync(compiledDir, { recursive: true, force: true });
}

function compileMeasurementModules(outDir) {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [
    tsc, '--ignoreConfig',
    'src/gain-control.ts',
    'src/loudness-meter.ts',
    'src/full-audio-analysis.ts',
    '--outDir', outDir,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--lib', 'es2020,dom',
    '--skipLibCheck'
  ], { cwd: root, stdio: 'inherit' });
}

function decodeStereoPcm(filePath, inputGainDb) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', `volume=${inputGainDb}dB`,
    '-ar', '48000',
    '-ac', '2',
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    '-'
  ], { maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`PCM decode failed for ${basename(filePath)}:\n${result.stderr.toString()}`);
  }
  const samples = new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );
  return { samples, sampleRate: 48000, channels: 2, durationSeconds: samples.length / 2 / 48000 };
}

function simulateRealtime(pcm, modules) {
  const {
    LoudnessMeter,
    RealtimeAgc,
    chooseControlLoudness,
    calculateFullAudioGain,
    TruePeakEstimator
  } = modules;
  const inputMeter = new LoudnessMeter(pcm.sampleRate, Number.POSITIVE_INFINITY);
  const outputMeter = new LoudnessMeter(pcm.sampleRate, Number.POSITIVE_INFINITY);
  const agc = new RealtimeAgc();
  const chunkFrames = Math.floor(pcm.sampleRate * 0.1);
  const trace = [];
  let gain = 1;
  let minGain = gain;
  let maxGain = gain;
  let maxStepDb = 0;
  let samplePeak = 0;
  const truePeakEstimator = new TruePeakEstimator();

  for (let startFrame = 0; startFrame < pcm.samples.length / 2; startFrame += chunkFrames) {
    const frames = Math.min(chunkFrames, pcm.samples.length / 2 - startFrame);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let chunkPeak = 0;
    for (let frame = 0; frame < frames; frame++) {
      left[frame] = pcm.samples[(startFrame + frame) * 2];
      right[frame] = pcm.samples[(startFrame + frame) * 2 + 1];
      chunkPeak = Math.max(chunkPeak, Math.abs(left[frame]), Math.abs(right[frame]));
    }
    samplePeak = Math.max(samplePeak, chunkPeak);
    truePeakEstimator.processChannels([left, right]);
    inputMeter.processChannels([left, right]);

    const integratedLufs = inputMeter.getIntegratedLoudness();
    const shortTermLufs = inputMeter.getShortTermLoudness();
    const momentaryLufs = inputMeter.getMomentaryLoudness();
    const integrationTime = inputMeter.getIntegrationTime();
    const controlLufs = chooseControlLoudness({
      integratedLufs,
      shortTermLufs,
      momentaryLufs,
      integrationTime,
      minIntegrationSeconds: 1
    });
    const previousGain = gain;
    let state = 'waiting';
    if (Number.isFinite(controlLufs)) {
      const result = agc.update({
        currentGain: gain,
        desiredGain: Math.pow(10, (DEFAULT_REFERENCE_SETTINGS.targetLufs - controlLufs) / 20),
        minGain: DEFAULT_REFERENCE_SETTINGS.minGain,
        maxGain: 2,
        deltaSec: frames / pcm.sampleRate,
        controlLufs,
        targetLufs: DEFAULT_REFERENCE_SETTINGS.targetLufs,
        integrationTime,
        coldStartSeconds: 10,
        sourcePeak: chunkPeak,
        momentaryLufs,
        shortTermLufs,
        gainChangePerSec: 0.2,
        programTimeSeconds: (startFrame + frames) / pcm.sampleRate
      });
      gain = result.nextGain;
      state = result.state;
    }

    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      outputLeft[frame] = left[frame] * gain;
      outputRight[frame] = right[frame] * gain;
    }
    outputMeter.processChannels([outputLeft, outputRight]);
    minGain = Math.min(minGain, gain);
    maxGain = Math.max(maxGain, gain);
    maxStepDb = Math.max(maxStepDb, Math.abs(linearToDb(gain / previousGain)));
    trace.push({
      timeSeconds: round((startFrame + frames) / pcm.sampleRate, 3),
      integratedLufs: round(integratedLufs, 3),
      controlLufs: round(controlLufs, 3),
      gain: round(gain, 6),
      gainDb: round(linearToDb(gain), 3),
      stepDb: round(linearToDb(gain / previousGain), 4),
      state
    });
  }

  const fullIntegratedLufs = inputMeter.getIntegratedLoudness();
  const fullGain = calculateFullAudioGain(
    {
      integratedLufs: fullIntegratedLufs,
      samplePeak,
      estimatedTruePeak: truePeakEstimator.getPeak()
    },
    DEFAULT_REFERENCE_SETTINGS.targetLufs,
    DEFAULT_REFERENCE_SETTINGS.minGain,
    2
  );
  const evaluationTrace = trace.filter((entry) => entry.timeSeconds >= 10);
  const evaluationGains = evaluationTrace.map((entry) => entry.gain);
  const evaluationMinGain = Math.min(...evaluationGains);
  const evaluationMaxGain = Math.max(...evaluationGains);
  const changed = (entry) => Math.abs(entry.stepDb ?? 0) > 0.0001;

  return {
    fullIntegratedLufs,
    fullGain,
    outputIntegratedLufs: outputMeter.getIntegratedLoudness(),
    finalGain: gain,
    minGain,
    maxGain,
    maxStepDb,
    gainAt10Seconds: evaluationTrace[0]?.gain ?? gain,
    gainRangeAfter10X: evaluationMaxGain - evaluationMinGain,
    gainChangesBefore10: trace.filter((entry) => entry.timeSeconds < 10 && changed(entry)).length,
    gainChangesAfter10: evaluationTrace.filter(changed).length,
    trace
  };
}

function renderConsole(reports) {
  const header = 'fixture                 offline  gain@10s  final gain  final ΔdB  range 10s+  range  accuracy';
  const rows = reports.map((report) => [
    report.id.padEnd(23),
    String(report.offlineReference.gain).padStart(7),
    String(report.realtime.gainAt10Seconds).padStart(8),
    String(report.realtime.finalGain).padStart(10),
    String(report.realtime.finalGainDiffDb).padStart(9),
    String(report.realtime.gainRangeAfter10X).padStart(10),
    String(report.includedInEvaluation ? (report.realtime.variationPass ? 'PASS' : 'FAIL') : 'INFO').padStart(6),
    String(report.includedInEvaluation ? (report.realtime.gainAccuracyPass ? 'PASS' : 'FAIL') : 'INFO').padStart(8)
  ].join('  '));
  return [header, ...rows].join('\n');
}

function renderMarkdown(summary) {
  const rows = summary.reports.map((report) =>
    `| ${report.id} | ${report.includedInEvaluation ? 'Evaluation' : 'Diagnostic only'} | ${report.offlineReference.gain} | ${report.realtime.gainAt10Seconds} | ${report.realtime.finalGain} | ${report.realtime.finalGainDiffDb} | ${report.realtime.gainRangeAfter10X} | ${report.realtime.gainChangesAfter10} | ${report.fullTrackImplementation.gain} | ${report.includedInEvaluation ? (report.realtime.variationPass ? 'PASS' : 'FAIL') : 'INFO'} | ${report.includedInEvaluation ? (report.realtime.gainAccuracyPass ? 'PASS' : 'FAIL') : 'INFO'} |`
  );
  return `# Audio normalization benchmark\n\n` +
    `Generated: ${summary.generatedAt}\n\n` +
    `Target: ${summary.targetLufs} LUFS; offline reference uses whole-program FFmpeg loudnorm measurement and one fixed, true-peak-safe gain. Detailed trace: ${summary.traceEnabled ? 'enabled' : 'disabled'}.\n\n` +
    `Primary pass criterion: gain range from 10 seconds to end ≤ 0.2x. Accuracy diagnostic: final gain error ≤ 1 dB. Extreme-peak fixtures are diagnostic only and excluded from conclusions.\n\n` +
    `| Fixture | Use | Offline fixed gain | Gain at 10s | Final gain | Final diff dB | Range 10s+ | Changes 10s+ | Full-track gain | Range result | Accuracy |\n` +
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` + rows.join('\n') + '\n';
}

function mapRounded(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'number' ? round(item, 3) : item
  ]));
}

function round(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
