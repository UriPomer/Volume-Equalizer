import { LoudnessMeter } from './loudness-meter';
import { logDiagnostic } from './logger';

export interface FullAudioAnalysisResult {
  integratedLufs: number;
  samplePeak: number;
  estimatedTruePeak: number;
  duration: number;
  sourceUrl: string;
}

export type FullAudioAnalysisErrorCode =
  | 'duration-unavailable'
  | 'source-unavailable'
  | 'request-failed'
  | 'too-large'
  | 'incomplete'
  | 'decode-failed'
  | 'unmeasurable';

export class FullAudioAnalysisError extends Error {
  constructor(
    readonly code: FullAudioAnalysisErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FullAudioAnalysisError';
  }
}

const MAX_COMPRESSED_AUDIO_BYTES = 48 * 1024 * 1024;
const MAX_DECODED_AUDIO_BYTES = 256 * 1024 * 1024;
const ANALYSIS_CHUNK_SECONDS = 1;
const TRUE_PEAK_MARGIN = 1.03;
const LIMITER_CEILING = 0.8912509381337456;

export async function analyzeFullAudio(
  media: HTMLMediaElement,
  context: AudioContext,
  signal: AbortSignal
): Promise<FullAudioAnalysisResult> {
  const mediaDuration = media.duration;
  if (classifyMediaDuration(mediaDuration) !== 'ready') {
    throw new FullAudioAnalysisError(
      'duration-unavailable',
      `视频总时长不可用: ${String(mediaDuration)}`
    );
  }
  assertEstimatedDecodedAudioBudget(mediaDuration);

  const sourceUrl = resolveFullAudioUrl(media);
  if (!sourceUrl) {
    throw new FullAudioAnalysisError('source-unavailable', '未找到可拉取的完整音轨 URL');
  }

  logDiagnostic('完整音轨：开始拉取', {
    source: describeAudioUrl(sourceUrl),
    videoDurationSeconds: roundDuration(mediaDuration)
  });

  const sourceOrigin = new URL(sourceUrl, location.href).origin;
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      credentials: sourceOrigin === location.origin ? 'include' : 'omit',
      referrer: location.href,
      signal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new FullAudioAnalysisError('request-failed', `完整音轨请求异常: ${formatError(error)}`);
  }
  if (!response.ok) {
    throw new FullAudioAnalysisError(
      'request-failed',
      `完整音轨请求失败: HTTP ${response.status}`
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_AUDIO_BYTES) {
    throw new FullAudioAnalysisError('too-large', '完整音轨超过 48 MiB 分析上限');
  }

  let encoded: ArrayBuffer;
  try {
    encoded = await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new FullAudioAnalysisError('request-failed', `完整音轨下载中断: ${formatError(error)}`);
  }
  if (encoded.byteLength > MAX_COMPRESSED_AUDIO_BYTES) {
    throw new FullAudioAnalysisError('too-large', '完整音轨超过 48 MiB 分析上限');
  }
  if (Number.isFinite(contentLength) && encoded.byteLength < contentLength) {
    throw new FullAudioAnalysisError(
      'incomplete',
      `音轨下载不完整: ${encoded.byteLength}/${contentLength} 字节`
    );
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  logDiagnostic('完整音轨：下载完成，开始解码', {
    encodedBytes: encoded.byteLength,
    declaredBytes: Number.isFinite(contentLength) ? contentLength : null
  });

  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(encoded);
  } catch (error) {
    throw new FullAudioAnalysisError('decode-failed', `完整音轨解码失败: ${formatError(error)}`);
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  assertEstimatedDecodedAudioBudget(
    decoded.duration,
    decoded.sampleRate,
    decoded.numberOfChannels
  );
  assertFullAudioDurationComplete(decoded.duration, mediaDuration);

  logDiagnostic('完整音轨：解码完整，开始响度分析', {
    decodedDurationSeconds: roundDuration(decoded.duration),
    videoDurationSeconds: roundDuration(mediaDuration),
    channels: decoded.numberOfChannels,
    sampleRate: decoded.sampleRate
  });

  const meter = new LoudnessMeter(decoded.sampleRate, Number.POSITIVE_INFINITY);
  const channels = Array.from(
    { length: decoded.numberOfChannels },
    (_, channel) => decoded.getChannelData(channel)
  );
  const chunkFrames = Math.max(1, Math.floor(decoded.sampleRate * ANALYSIS_CHUNK_SECONDS));
  let samplePeak = 0;
  const truePeakEstimator = new TruePeakEstimator();

  for (let offset = 0; offset < decoded.length; offset += chunkFrames) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(decoded.length, offset + chunkFrames);
    const chunk = channels.map((channel) => channel.subarray(offset, end));

    for (const channel of chunk) {
      for (let i = 0; i < channel.length; i++) {
        samplePeak = Math.max(samplePeak, Math.abs(channel[i]));
      }
    }
    truePeakEstimator.processChannels(chunk);
    meter.processChannels(chunk);

    // Keep the page responsive while the experimental full-track pass runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const integratedLufs = meter.getIntegratedLoudness();
  if (!Number.isFinite(integratedLufs)) {
    throw new FullAudioAnalysisError('unmeasurable', '完整音轨没有可测量的节目响度');
  }

  logDiagnostic('完整音轨：分析完成', {
    integratedLufs,
    samplePeak,
    estimatedTruePeak: truePeakEstimator.getPeak(),
    durationSeconds: roundDuration(decoded.duration)
  });

  return {
    integratedLufs,
    samplePeak,
    estimatedTruePeak: truePeakEstimator.getPeak(),
    duration: decoded.duration,
    sourceUrl
  };
}

export function classifyMediaDuration(duration: number): 'waiting' | 'unsupported' | 'ready' {
  if (Number.isNaN(duration) || duration <= 0) return 'waiting';
  return Number.isFinite(duration) ? 'ready' : 'unsupported';
}

export function assertEstimatedDecodedAudioBudget(
  duration: number,
  sampleRate = 48000,
  channels = 2
): void {
  const estimatedBytes = duration * sampleRate * channels * Float32Array.BYTES_PER_ELEMENT;
  if (estimatedBytes > MAX_DECODED_AUDIO_BYTES) {
    throw new FullAudioAnalysisError(
      'too-large',
      `解码音轨预计占用 ${(estimatedBytes / 1024 / 1024).toFixed(0)} MiB，超过 256 MiB 上限`
    );
  }
}

export function assertFullAudioDurationComplete(
  decodedDuration: number,
  mediaDuration: number
): void {
  if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) {
    throw new FullAudioAnalysisError('decode-failed', `解码音轨时长无效: ${decodedDuration}`);
  }
  const toleranceSeconds = Math.max(2, mediaDuration * 0.005);
  if (decodedDuration + toleranceSeconds < mediaDuration) {
    throw new FullAudioAnalysisError(
      'incomplete',
      `音轨长度不完整: ${roundDuration(decodedDuration)}/${roundDuration(mediaDuration)} 秒`
    );
  }
}

export function calculateFullAudioGain(
  result: Pick<FullAudioAnalysisResult, 'integratedLufs' | 'samplePeak'> & {
    estimatedTruePeak?: number;
  },
  targetLufs: number,
  minGain: number,
  maxGain: number
): number {
  const loudnessGain = Math.pow(10, (targetLufs - result.integratedLufs) / 20);
  const programmePeak = Math.max(result.samplePeak, result.estimatedTruePeak ?? 0);
  const peakSafeGain = programmePeak > 0
    ? LIMITER_CEILING / (programmePeak * TRUE_PEAK_MARGIN)
    : maxGain;
  return Math.min(Math.max(loudnessGain, minGain), maxGain, peakSafeGain);
}

export class TruePeakEstimator {
  private histories: Float32Array[] = [];
  private peak = 0;

  processChannels(channels: Float32Array[]): void {
    while (this.histories.length < channels.length) {
      this.histories.push(new Float32Array(3));
    }

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const history = this.histories[channelIndex];
      const channel = channels[channelIndex];
      for (let index = 0; index < channel.length; index++) {
        const sample = channel[index];
        this.peak = Math.max(
          this.peak,
          Math.abs(sample),
          estimateCubicPeak(history[0], history[1], history[2], sample)
        );
        history[0] = history[1];
        history[1] = history[2];
        history[2] = sample;
      }
    }
  }

  getPeak(): number {
    return this.peak;
  }
}

function estimateCubicPeak(p0: number, p1: number, p2: number, p3: number): number {
  let peak = 0;
  for (let step = 0; step < 4; step++) {
    const t = step / 4;
    const t2 = t * t;
    const t3 = t2 * t;
    const value = 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
    peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

export function findBilibiliAudioUrl(scriptTexts: string[]): string | null {
  for (const text of scriptTexts) {
    const json = extractAssignedJson(text, 'window.__playinfo__');
    if (!json) continue;

    try {
      const playInfo = JSON.parse(json) as Record<string, any>;
      const audio = playInfo?.data?.dash?.audio ?? playInfo?.result?.dash?.audio;
      if (!Array.isArray(audio) || audio.length === 0) continue;

      const best = [...audio].sort(
        (left, right) => Number(right?.bandwidth ?? 0) - Number(left?.bandwidth ?? 0)
      )[0];
      const url = best?.baseUrl ?? best?.base_url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
    } catch {
      // Ignore stale or malformed page bootstrap data and try the next script.
    }
  }
  return null;
}

function resolveFullAudioUrl(media: HTMLMediaElement): string | null {
  const directUrl = media.currentSrc || media.src;
  if (/^https?:\/\//i.test(directUrl)) return directUrl;

  const scriptTexts = Array.from(document.scripts, (script) => script.textContent || '');
  return findBilibiliAudioUrl(scriptTexts);
}

function describeAudioUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl, location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return sourceUrl.split('?')[0];
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roundDuration(value: number): number {
  return Number(value.toFixed(3));
}

function extractAssignedJson(text: string, assignment: string): string | null {
  const assignmentIndex = text.indexOf(assignment);
  if (assignmentIndex < 0) return null;
  const start = text.indexOf('{', assignmentIndex + assignment.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}
