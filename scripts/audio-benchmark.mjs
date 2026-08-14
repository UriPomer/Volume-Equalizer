import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
const compiledDir = join(tmpdir(), `bili-volume-audio-benchmark-${process.pid}`);
// 稳定优先：稳态 gain 变化 ≤ 0.1x/分钟，动态节目输出精度让位于稳定性。
// 输出精度门禁放宽到 ±1.5 LU；稳定性门禁（P95-P5、跨度）保持严格。
const OUTPUT_TARGET_TOLERANCE_LU = 1.5;
const GAIN_ROBUST_SPAN_LIMIT_DB = 1.5;
const GAIN_MAX_SPAN_LIMIT_DB = 3;

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
    const simulation = simulateRealtime(pcm, {
      LoudnessMeter,
      RealtimeAgc,
      chooseControlLoudness,
      calculateFullAudioGain,
      TruePeakEstimator,
      LimiterProcessor
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
        outputTargetDiffLu: round(
          simulation.outputIntegratedLufs - DEFAULT_REFERENCE_SETTINGS.targetLufs,
          3
        ),
        outputVsOfflineLu: round(simulation.outputIntegratedLufs - reference.predictedOutputLufs, 3),
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
    report.realtime.loudnessPass = Math.abs(report.realtime.outputTargetDiffLu)
      <= OUTPUT_TARGET_TOLERANCE_LU;
    report.realtime.stabilityPass = report.realtime.gainRobustSpanAfter10Db
      <= GAIN_ROBUST_SPAN_LIMIT_DB
      && report.realtime.gainMaxSpanAfter10Db <= GAIN_MAX_SPAN_LIMIT_DB;
    report.realtime.pass = report.realtime.loudnessPass && report.realtime.stabilityPass;
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
    && reports.some((report) => report.includedInEvaluation && !report.realtime.pass)) {
    process.exitCode = 1;
  }
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

function loadLimiterProcessor() {
  let Processor;
  runInNewContext(
    readFileSync(join(root, 'public', 'limiter-worklet.js'), 'utf8'),
    {
      sampleRate: 48000,
      AudioWorkletProcessor: class {
        constructor() { this.port = { onmessage: null, postMessage() {} }; }
      },
      registerProcessor(_name, implementation) { Processor = implementation; }
    }
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

function simulateRealtime(pcm, modules) {
  const {
    LoudnessMeter,
    RealtimeAgc,
    chooseControlLoudness,
    calculateFullAudioGain,
    TruePeakEstimator,
    LimiterProcessor
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
  const limiter = new LimiterProcessor({
    processorOptions: {
      lookaheadMs: 15,
      releaseMs: 50,
      ceiling: 0.8912509381337456,
      interSampleMargin: 1.03
    }
  });
  limiter.port = { postMessage() {} };
  const evaluationGainDb = [];

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
      minIntegrationSeconds: 1,
      calibrationSeconds: 10,
      calibrationSafetyThresholdLufs: DEFAULT_REFERENCE_SETTINGS.targetLufs + 3
    });
    const previousGain = gain;
    let state = 'waiting';
    if (Number.isFinite(controlLufs)) {
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

    const gainedLeft = new Float32Array(frames);
    const gainedRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      gainedLeft[frame] = left[frame] * gain;
      gainedRight[frame] = right[frame] * gain;
    }
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    limiter.process([[gainedLeft, gainedRight]], [[outputLeft, outputRight]]);
    outputMeter.processChannels([outputLeft, outputRight]);
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
  evaluationGainDb.sort((a, b) => a - b);
  const evaluationMinGainDb = evaluationGainDb[0] ?? linearToDb(gain);
  const evaluationMaxGainDb = evaluationGainDb.at(-1) ?? linearToDb(gain);

  return {
    fullIntegratedLufs,
    fullGain,
    outputIntegratedLufs: outputMeter.getIntegratedLoudness(),
    finalGain: gain,
    minGain,
    maxGain,
    maxStepDb,
    gainAt10Seconds: evaluationTrace[0]?.gain ?? gain,
    gainRobustSpanAfter10Db: percentile(evaluationGainDb, 0.95)
      - percentile(evaluationGainDb, 0.05),
    gainMaxSpanAfter10Db: evaluationMaxGainDb - evaluationMinGainDb,
    trace
  };
}

function renderConsole(reports) {
  const header = 'fixture                 output LUFS  target ΔLU  P95-P5 dB  max span dB  loudness  stability  result';
  const rows = reports.map((report) => [
    report.id.padEnd(23),
    String(report.realtime.outputIntegratedLufs).padStart(11),
    String(report.realtime.outputTargetDiffLu).padStart(10),
    String(report.realtime.gainRobustSpanAfter10Db).padStart(10),
    String(report.realtime.gainMaxSpanAfter10Db).padStart(11),
    resultText(report, 'loudnessPass').padStart(8),
    resultText(report, 'stabilityPass').padStart(9),
    resultText(report, 'pass').padStart(6)
  ].join('  '));
  return [header, ...rows].join('\n');
}

function renderMarkdown(summary) {
  const rows = summary.reports.map((report) =>
    `| ${report.id} | ${report.includedInEvaluation ? 'Evaluation' : 'Diagnostic only'} | ${report.realtime.outputIntegratedLufs} | ${report.realtime.outputTargetDiffLu} | ${report.realtime.gainRobustSpanAfter10Db} | ${report.realtime.gainMaxSpanAfter10Db} | ${report.realtime.finalGainDiffDb} | ${resultText(report, 'loudnessPass')} | ${resultText(report, 'stabilityPass')} | ${resultText(report, 'pass')} |`
  );
  return `# Audio normalization benchmark\n\n` +
    `Generated: ${summary.generatedAt}\n\n` +
    `Target: ${summary.targetLufs} LUFS; offline reference uses whole-program FFmpeg loudnorm measurement and one fixed, true-peak-safe gain. Detailed trace: ${summary.traceEnabled ? 'enabled' : 'disabled'}.\n\n` +
    `Pass criteria: output loudness within ±${OUTPUT_TARGET_TOLERANCE_LU} LU of target, gain P95–P5 after 10 seconds ≤ ${GAIN_ROBUST_SPAN_LIMIT_DB} dB, and maximum gain span after 10 seconds ≤ ${GAIN_MAX_SPAN_LIMIT_DB} dB. Extreme-peak fixtures are diagnostic only.\n\n` +
    `| Fixture | Use | Output LUFS | Target diff LU | Gain P95–P5 dB | Max gain span dB | Final gain diff dB | Loudness | Stability | Result |\n` +
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n` + rows.join('\n') + '\n';
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
