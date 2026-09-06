import { execFileSync, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const enforceEnabled = process.argv.includes('--enforce');
const compiledDir = mkdtempSync(join(tmpdir(), 'bili-volume-audio-benchmark-'));
// 稳定优先：稳态 gain 变化 ≤ 0.1x/分钟，动态节目输出精度让位于稳定性。
// 节目校准与经过相同保护的固定增益参考比较，另保留原目标误差。
const OUTPUT_TARGET_TOLERANCE_LU = 1.5;
const GAIN_ROBUST_SPAN_LIMIT_DB = 1.5;
const GAIN_MAX_SPAN_LIMIT_DB = 3;
const FULL_TRACK_MEASUREMENT_TOLERANCE_LU = 0.5;
const FULL_TRACK_GAIN_TOLERANCE_DB = 0.5;
const OUTPUT_MOMENTARY_CEILING_TOLERANCE_LU = 0.01;
const OUTPUT_FLUSH_SECONDS = 0.6;

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
const LimiterProcessor = loadLimiterProcessor();

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
    const modules = {
      LoudnessMeter,
      RealtimeAgc,
      chooseControlLoudness,
      calculateFullAudioGain,
      TruePeakEstimator,
      LimiterProcessor
    };
    const simulation = simulateRealtime(pcm, modules);
    // Compare programme calibration against FFmpeg's fixed gain through the
    // same mandatory output protection; retain the target deviation separately.
    const protectedReference = simulateRealtime(pcm, modules, reference.gain);

    const report = {
      id: fixture.id,
      title: fixture.title,
      sourceFile: fixture.file,
      inputGainDb: fixture.inputGainDb,
      includedInEvaluation: fixture.includeInEvaluation !== false,
      durationSeconds: round(pcm.durationSeconds, 3),
      offlineReference: {
        ...mapRounded(referenceMeasurement),
        ...mapRounded(reference),
        protectedOutputIntegratedLufs: round(protectedReference.outputIntegratedLufs, 3)
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
        outputTargetDiffLu: round(
          simulation.outputIntegratedLufs - DEFAULT_REFERENCE_SETTINGS.targetLufs,
          3
        ),
        outputVsOfflineLu: round(simulation.outputIntegratedLufs - reference.predictedOutputLufs, 3),
        outputVsProtectedReferenceLu: round(simulation.outputIntegratedLufs
          - protectedReference.outputIntegratedLufs, 3),
        maxActualOutputMomentaryLufs: round(simulation.maxActualOutputMomentaryLufs, 3),
        outputMomentaryCeilingDiffLu: round(simulation.outputMomentaryCeilingDiffLu, 3),
        minSafetyGain: round(simulation.minSafetyGain, 6),
        finalGainDb: round(linearToDb(simulation.finalGain), 3),
        finalGainDiffDb: round(linearToDb(simulation.finalGain) - reference.gainDb, 3),
        minGainDb: round(linearToDb(simulation.minGain), 3),
        maxGainDb: round(linearToDb(simulation.maxGain), 3),
        gainSpanDb: round(linearToDb(simulation.maxGain / simulation.minGain), 3),
        maxStepDb: round(simulation.maxStepDb, 3),
        gainAt10Seconds: round(simulation.gainAt10Seconds, 6),
        finalGain: round(simulation.finalGain, 6),
        gainRobustSpanAfter10Db: round(simulation.gainRobustSpanAfter10Db, 3),
        gainMaxSpanAfter10Db: round(simulation.gainMaxSpanAfter10Db, 3)
      }
    };
    report.fullTrackImplementation.measurementPass = Math.abs(
      simulation.fullIntegratedLufs - referenceMeasurement.integratedLufs
    ) <= FULL_TRACK_MEASUREMENT_TOLERANCE_LU;
    report.fullTrackImplementation.gainPass = Math.abs(
      linearToDb(simulation.fullGain) - reference.gainDb
    ) <= FULL_TRACK_GAIN_TOLERANCE_DB;
    report.fullTrackImplementation.pass = report.fullTrackImplementation.measurementPass
      && report.fullTrackImplementation.gainPass;
    report.realtime.targetMeanPass = Math.abs(report.realtime.outputTargetDiffLu)
      <= OUTPUT_TARGET_TOLERANCE_LU;
    report.realtime.loudnessPass = Math.abs(report.realtime.outputVsProtectedReferenceLu)
      <= OUTPUT_TARGET_TOLERANCE_LU;
    report.realtime.outputSafetyPass = simulation.outputMomentaryCeilingDiffLu
      <= OUTPUT_MOMENTARY_CEILING_TOLERANCE_LU;
    report.realtime.stabilityPass = report.realtime.gainRobustSpanAfter10Db
      <= GAIN_ROBUST_SPAN_LIMIT_DB
      && report.realtime.gainMaxSpanAfter10Db <= GAIN_MAX_SPAN_LIMIT_DB;
    report.realtime.pass = report.realtime.loudnessPass
      && report.realtime.outputSafetyPass
      && report.realtime.stabilityPass;
    report.pass = report.fullTrackImplementation.pass && report.realtime.pass;
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
  if (enforceEnabled
    && reports.some((report) => report.includedInEvaluation && !report.pass)) {
    process.exitCode = 1;
  }
} finally {
  rmSync(compiledDir, { recursive: true, force: true });
}

function compileMeasurementModules(outDir) {
  mkdirSync(outDir, { recursive: true });
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

function loadLimiterProcessor() {
  let Processor;
  const workletBundle = buildSync({
    entryPoints: [join(root, 'public', 'limiter-worklet.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020'
  }).outputFiles[0].text;
  // Execute trusted, locally built DSP in this realm; VM proxy access in the
  // per-sample hot loop otherwise dominates the audio benchmark runtime.
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', workletBundle)(
    class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    (_name, implementation) => { Processor = implementation; },
    48000
  );
  return Processor;
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

function simulateRealtime(pcm, modules, fixedGain) {
  const {
    LoudnessMeter,
    RealtimeAgc,
    chooseControlLoudness,
    calculateFullAudioGain,
    TruePeakEstimator,
    LimiterProcessor
  } = modules;
  const inputMeter = new LoudnessMeter(pcm.sampleRate, Number.POSITIVE_INFINITY);
  const fullInputMeter = new LoudnessMeter(pcm.sampleRate, Number.POSITIVE_INFINITY);
  const outputMeter = new LoudnessMeter(pcm.sampleRate, Number.POSITIVE_INFINITY);
  const agc = new RealtimeAgc();
  const chunkFrames = Math.floor(pcm.sampleRate * 0.1);
  const trace = [];
  let gain = fixedGain ?? 1;
  let minGain = gain;
  let maxGain = gain;
  let maxStepDb = 0;
  let samplePeak = 0;
  const truePeakEstimator = new TruePeakEstimator();
  const limiter = new LimiterProcessor({
    processorOptions: {
      targetLufs: DEFAULT_REFERENCE_SETTINGS.targetLufs,
      lookaheadMs: 15,
      releaseMs: 50,
      ceiling: 0.8912509381337456,
      interSampleMargin: 1.03
    }
  });
  const meterMessages = [];
  limiter.port = { postMessage(message) { meterMessages.push(message); } };
  const evaluationGainDb = [];
  let maxActualOutputMomentaryLufs = Number.NEGATIVE_INFINITY;
  let minSafetyGain = 1;

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
    fullInputMeter.processChannels([left, right]);
    const previousGain = gain;
    const gainedLeft = new Float32Array(frames);
    const gainedRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      gainedLeft[frame] = left[frame] * gain;
      gainedRight[frame] = right[frame] * gain;
    }
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    limiter.process([[gainedLeft, gainedRight], [left, right]], [[outputLeft, outputRight]]);
    const meters = consumeMeterMessages(meterMessages, inputMeter);
    for (const meter of meters) minSafetyGain = Math.min(minSafetyGain, meter.safetyGain);
    maxActualOutputMomentaryLufs = Math.max(
      maxActualOutputMomentaryLufs,
      processActualOutputMeters(meters, outputMeter)
    );
    const integratedLufs = inputMeter.getIntegratedLoudness();
    const shortTermLufs = inputMeter.getShortTermLoudness();
    const momentaryLufs = inputMeter.getMomentaryLoudness();
    const integrationTime = inputMeter.getIntegrationTime();
    const controlLufs = chooseControlLoudness({
      integratedLufs,
      shortTermLufs,
      momentaryLufs,
      integrationTime,
      minIntegrationSeconds: 1,
      calibrationSeconds: 10,
      calibrationSafetyThresholdLufs: DEFAULT_REFERENCE_SETTINGS.targetLufs + 3
    });
    let state = 'waiting';
    if (fixedGain === undefined && meters.length && Number.isFinite(controlLufs)) {
      const calibrationGain = Math.pow(
        10,
        (DEFAULT_REFERENCE_SETTINGS.targetLufs - controlLufs) / 20
      );
      const result = agc.update({
        currentGain: gain,
        desiredGain: calibrationGain,
        calibrationGain,
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
        calibrationBoostStartSeconds: 6,
        postCalibrationCorridor: 0.2,
        postCalibrationDbCorridor: 0.75,
        programTimeSeconds: (startFrame + frames) / pcm.sampleRate
      });
      gain = result.nextGain;
      state = result.state;
    }
    minGain = Math.min(minGain, gain);
    maxGain = Math.max(maxGain, gain);
    maxStepDb = Math.max(maxStepDb, Math.abs(linearToDb(gain / previousGain)));
    const timeSeconds = (startFrame + frames) / pcm.sampleRate;
    if (timeSeconds >= 10) evaluationGainDb.push(linearToDb(gain));
    trace.push({
      timeSeconds: round(timeSeconds, 3),
      integratedLufs: round(integratedLufs, 3),
      controlLufs: round(controlLufs, 3),
      gain: round(gain, 6),
      gainDb: round(linearToDb(gain), 3),
      stepDb: round(linearToDb(gain / previousGain), 4),
      state
    });
  }

  for (let flushed = 0; flushed < OUTPUT_FLUSH_SECONDS * pcm.sampleRate; flushed += chunkFrames) {
    const frames = Math.min(chunkFrames, OUTPUT_FLUSH_SECONDS * pcm.sampleRate - flushed);
    const silence = [new Float32Array(frames), new Float32Array(frames)];
    limiter.process([silence, silence], [[new Float32Array(frames), new Float32Array(frames)]]);
    const meters = consumeMeterMessages(meterMessages, null);
    for (const meter of meters) minSafetyGain = Math.min(minSafetyGain, meter.safetyGain);
    maxActualOutputMomentaryLufs = Math.max(
      maxActualOutputMomentaryLufs,
      processActualOutputMeters(meters, outputMeter)
    );
  }

  const fullIntegratedLufs = fullInputMeter.getIntegratedLoudness();
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
  evaluationGainDb.sort((a, b) => a - b);
  const evaluationMinGainDb = evaluationGainDb[0] ?? linearToDb(gain);
  const evaluationMaxGainDb = evaluationGainDb.at(-1) ?? linearToDb(gain);

  return {
    fullIntegratedLufs,
    fullGain,
    outputIntegratedLufs: outputMeter.getIntegratedLoudness(),
    maxActualOutputMomentaryLufs,
    outputMomentaryCeilingDiffLu: maxActualOutputMomentaryLufs
      - (DEFAULT_REFERENCE_SETTINGS.targetLufs + 2),
    finalGain: gain,
    minGain,
    maxGain,
    maxStepDb,
    gainAt10Seconds: evaluationTrace[0]?.gain ?? gain,
    gainRobustSpanAfter10Db: percentile(evaluationGainDb, 0.95)
      - percentile(evaluationGainDb, 0.05),
    gainMaxSpanAfter10Db: evaluationMaxGainDb - evaluationMinGainDb,
    minSafetyGain,
    trace
  };
}

function consumeMeterMessages(messages, inputMeter) {
  return messages.splice(0).map((meter) => {
    if (meter.type !== 'meter' || !Array.isArray(meter.original) || !Array.isArray(meter.output)) {
      throw new Error('Limiter meter message is incomplete');
    }
    if (inputMeter) inputMeter.processChannels(meter.original);
    return {
      output: meter.output,
      safetyGain: Number.isFinite(meter.safetyGain) ? meter.safetyGain : 1
    };
  });
}

function processActualOutputMeters(meters, outputMeter) {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const meter of meters) {
    for (let offset = 0; offset < meter.output[0].length; offset += 128) {
      const end = Math.min(offset + 128, meter.output[0].length);
      outputMeter.processChannels(meter.output.map((channel) => channel.subarray(offset, end)));
      const momentaryLufs = outputMeter.getMomentaryLoudness();
      if (Number.isFinite(momentaryLufs)) maximum = Math.max(maximum, momentaryLufs);
    }
  }
  return maximum;
}

function renderConsole(reports) {
  const header = 'fixture                 output LUFS  max momentary  P95-P5 dB  max span dB  full track  loudness  safety  stability  result';
  const rows = reports.map((report) => [
    report.id.padEnd(23),
    String(report.realtime.outputIntegratedLufs).padStart(11),
    String(report.realtime.maxActualOutputMomentaryLufs).padStart(14),
    String(report.realtime.gainRobustSpanAfter10Db).padStart(10),
    String(report.realtime.gainMaxSpanAfter10Db).padStart(11),
    resultText(report, 'fullTrackPass').padStart(10),
    resultText(report, 'loudnessPass').padStart(8),
    resultText(report, 'outputSafetyPass').padStart(6),
    resultText(report, 'stabilityPass').padStart(9),
    resultText(report, 'pass').padStart(6)
  ].join('  '));
  return [header, ...rows].join('\n');
}

function renderMarkdown(summary) {
  const rows = summary.reports.map((report) =>
    `| ${report.id} | ${report.includedInEvaluation ? 'Evaluation' : 'Diagnostic only'} | ${report.fullTrackImplementation.measurementDiffLu} | ${report.fullTrackImplementation.gainDiffDb} | ${report.realtime.outputIntegratedLufs} | ${report.realtime.outputTargetDiffLu} | ${report.realtime.outputVsProtectedReferenceLu} | ${report.realtime.maxActualOutputMomentaryLufs} | ${report.realtime.outputMomentaryCeilingDiffLu} | ${report.realtime.gainRobustSpanAfter10Db} | ${report.realtime.gainMaxSpanAfter10Db} | ${resultText(report, 'fullTrackPass')} | ${resultText(report, 'loudnessPass')} | ${resultText(report, 'outputSafetyPass')} | ${resultText(report, 'stabilityPass')} | ${resultText(report, 'pass')} |`
  );
  return `# Audio normalization benchmark\n\n` +
    `Generated: ${summary.generatedAt}\n\n` +
    `Target: ${summary.targetLufs} LUFS; offline reference uses whole-program FFmpeg loudnorm measurement and one fixed, true-peak-safe gain. Detailed trace: ${summary.traceEnabled ? 'enabled' : 'disabled'}.\n\n` +
    `Pass criteria: full-track measurement/reference gain each within their stated tolerance; actual output integrated loudness within ±${OUTPUT_TARGET_TOLERANCE_LU} LU of the safety-constrained fixed-gain reference (raw target deviation remains diagnostic); actual output momentary loudness no more than ${OUTPUT_MOMENTARY_CEILING_TOLERANCE_LU} LU above target +2; gain P95–P5 after 10 seconds ≤ ${GAIN_ROBUST_SPAN_LIMIT_DB} dB; and maximum programme gain span after 10 seconds ≤ ${GAIN_MAX_SPAN_LIMIT_DB} dB. Extreme-peak fixtures are diagnostic only.\n\n` +
    `| Fixture | Use | Full measurement diff LU | Full gain diff dB | Output LUFS | Target diff LU | Protected reference diff LU | Max actual momentary LUFS | Ceiling diff LU | Gain P95–P5 dB | Max programme gain span dB | Full track | Loudness | Safety | Stability | Result |\n` +
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` + rows.join('\n') + '\n';
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function resultText(report, field) {
  if (!report.includedInEvaluation) return 'INFO';
  if (field === 'fullTrackPass') return report.fullTrackImplementation.pass ? 'PASS' : 'FAIL';
  if (field === 'pass') return report.pass ? 'PASS' : 'FAIL';
  return report.realtime[field] ? 'PASS' : 'FAIL';
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
