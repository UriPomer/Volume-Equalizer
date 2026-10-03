import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function writeFloatWav(path, pcm, rate, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
}

// FFmpeg's independent BS.1770 implementation is the external oracle. Its
// 100 ms reporting grid is supplemented by a denser 1 ms local measurement.
export function ffmpegMaxima(path) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-af',
    'ebur128=peak=true:metadata=1,ametadata=print:file=-', '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  writeFileSync(path + '.ffmpeg.txt', result.stdout);
  const values = key => [...result.stdout.matchAll(new RegExp('lavfi\\.r128\\.' + key + '=(-?[\\d.]+)', 'g'))]
    .map(match => Number(match[1]));
  const m = values('M'), s = values('S'), peaks = values('true_peak');
  if (!m.length || !s.length || !peaks.length) throw new Error('FFmpeg audio metadata missing');
  return { momentary: Math.max(...m), shortTerm: Math.max(...s), truePeak: Math.max(...peaks), sha256: sha256(readFileSync(path)) };
}

const bundle = buildSync({ entryPoints: ['src/loudness-meter.ts'], bundle: true,
  write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', bundle)(module, module.exports);
const { LoudnessMeter } = module.exports;
export function denseMaxima(pcm, rate, channels) {
  const meter = new LoudnessMeter(rate), step = Math.round(rate / 1000);
  let momentary = -Infinity, shortTerm = -Infinity, peak = 0, energy = 0;
  const frames = pcm.length / channels;
  for (let start = 0; start < frames; start += step) {
    const count = Math.min(step, frames - start);
    const block = Array.from({ length: channels }, () => new Float32Array(count));
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
      const sample = pcm[(start + i) * channels + c];
      if (!Number.isFinite(sample)) throw new Error('Non-finite rendered PCM');
      block[c][i] = sample;
      peak = Math.max(peak, Math.abs(sample)); energy += sample * sample;
    }
    meter.processChannels(block);
    const m = meter.getMomentaryLoudness(), s = meter.getShortTermLoudness();
    if (Number.isFinite(m)) momentary = Math.max(momentary, m);
    if (Number.isFinite(s)) shortTerm = Math.max(shortTerm, s);
  }
  return { momentary, shortTerm, peak, rms: Math.sqrt(energy / pcm.length) };
}
