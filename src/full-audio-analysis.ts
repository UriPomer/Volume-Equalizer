import { LoudnessMeter } from './loudness-meter';

export interface FullAudioAnalysisResult {
  integratedLufs: number;
  samplePeak: number;
  estimatedTruePeak: number;
  duration: number;
  sourceUrl: string;
}

const MAX_COMPRESSED_AUDIO_BYTES = 48 * 1024 * 1024;
const ANALYSIS_CHUNK_SECONDS = 1;
const TRUE_PEAK_MARGIN = 1.03;
const LIMITER_CEILING = 0.8912509381337456;

export async function analyzeFullAudio(
  media: HTMLMediaElement,
  context: AudioContext,
  signal: AbortSignal
): Promise<FullAudioAnalysisResult> {
  const sourceUrl = resolveFullAudioUrl(media);
  if (!sourceUrl) {
    throw new Error('No fetchable full audio URL found');
  }

  const sourceOrigin = new URL(sourceUrl, location.href).origin;
  const response = await fetch(sourceUrl, {
    credentials: sourceOrigin === location.origin ? 'include' : 'omit',
    referrer: location.href,
    signal
  });
  if (!response.ok) {
    throw new Error(`Full audio request failed: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_AUDIO_BYTES) {
    throw new Error('Full audio exceeds 48 MiB analysis limit');
  }

  const encoded = await response.arrayBuffer();
  if (encoded.byteLength > MAX_COMPRESSED_AUDIO_BYTES) {
    throw new Error('Full audio exceeds 48 MiB analysis limit');
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const decoded = await context.decodeAudioData(encoded);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

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
    throw new Error('Full audio contains no measurable programme loudness');
  }

  return {
    integratedLufs,
    samplePeak,
    estimatedTruePeak: truePeakEstimator.getPeak(),
    duration: decoded.duration,
    sourceUrl
  };
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
