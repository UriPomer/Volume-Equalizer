import { createMediaMeter, ensureAudioContext, ensureMediaSource } from './audio-context';
import { getAudioOutput, SharedAudioOutput } from './audio-output';
import { BASS_FREQUENCY, INITIAL_GAIN, Settings } from './config';
import { analyzeFullAudio, calculateFullAudioGain, classifyMediaDuration, FullAudioAnalysisError, FullAudioAnalysisResult } from './full-audio-analysis';
import { AgcUpdateResult, RealtimeAgc } from './gain-control';
import { logDiagnostic, warnFailure } from './logger';
import { LoudnessMeter } from './loudness-meter';
import { clamp, rmsToLufs } from './lufs-calculator';
import { AnalysisStatus, EMPTY_METER_STATE, MeterState } from './types';

type MeterMessage = {
  type: 'meter';
  epoch: number;
  original: Float32Array[];
};

export class MediaVolumeController {
  private readonly media: HTMLMediaElement;
  private readonly onMeter: (state: MeterState) => void;
  private readonly onActivate: () => void;
  private settings: Settings;
  private readonly context: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly gain: GainNode;
  private readonly bass: BiquadFilterNode;
  private processor: AudioWorkletNode | null = null;
  private originalMeter: LoudnessMeter;
  private readonly output: SharedAudioOutput;
  private readonly releaseOutput: () => void;
  private agc = new RealtimeAgc();
  private analysisStatus: AnalysisStatus = 'realtime';
  private analysisAbort: AbortController | null = null;
  private analysisAttemptKey: string | null = null;
  private analysisResult: FullAudioAnalysisResult | null = null;
  private meterEpoch = 0;
  private rafId = 0;
  private gainState: AgcUpdateResult = { nextGain: 1, phase: 'collecting', referenceLufs: NaN, limited: false };
  private destroyed = false;
  private mediaKey = '';

  private readonly onEmptied = () => {
    this.mediaKey = this.currentMediaKey();
    this.cancelAnalysis();
    this.analysisAttemptKey = null;
    this.analysisResult = null;
    this.analysisStatus = this.settings.fullAudioAnalysis ? 'waiting-metadata' : 'realtime';
    this.setGain(INITIAL_GAIN);
    this.invalidateMeasurements();
  };

  private readonly onPlay = () => {
    this.refreshMediaIdentity();
    this.onActivate();
    this.context.resume().catch((error) => {
      warnFailure('media-play-resume', 'AudioContext play resume failed', error);
    });
    this.startAnalysis();
  };

  private readonly onLoadedMetadata = () => { this.refreshMediaIdentity(); this.startAnalysis(); };
  private readonly onSeeked = () => {
    // Same-media seeks clear discontinuous live windows, retaining the
    // integrated control reference and current gain.
    this.invalidateMeasurements(false);
  };

  constructor(
    media: HTMLMediaElement,
    settings: Settings,
    onMeter: (state: MeterState) => void,
    onActivate: () => void
  ) {
    this.media = media;
    this.mediaKey = this.currentMediaKey();
    this.settings = settings;
    this.onMeter = onMeter;
    this.onActivate = onActivate;
    this.context = ensureAudioContext();
    this.source = ensureMediaSource(media);
    this.gain = this.context.createGain();
    this.bass = this.context.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = BASS_FREQUENCY;
    this.bass.gain.value = settings.bassBoost;
    this.originalMeter = new LoudnessMeter(this.context.sampleRate, Infinity);
    this.output = getAudioOutput(this.context, rmsToLufs(settings.targetRms));
    this.releaseOutput = this.output.retain(() => {
      if (this.destroyed) return;
      this.analysisStatus = 'processor-unavailable';
      this.connectGraph();
    });
    this.output.updateSettings(rmsToLufs(settings.targetRms), settings.enabled);

    this.bindEvents();
    this.connectGraph();
    this.loadProcessor();
    this.startAnalysis();
    if (!media.paused) {
      this.onActivate();
      // 迟到挂载且已在播放：与 onPlay 一样恢复 AudioContext，避免注入后无声。
      this.context.resume().catch((error) => {
        warnFailure('media-play-resume', 'AudioContext play resume failed', error);
      });
    }
    this.tick = this.tick.bind(this);
    this.rafId = requestAnimationFrame(this.tick);
  }

  updateSettings(next: Settings): void {
    const previous = this.settings;
    this.settings = next;
    this.bass.gain.value = next.bassBoost;
    this.output.updateSettings(rmsToLufs(next.targetRms), next.enabled);

    if (previous.enabled !== next.enabled) {
      this.setGain(INITIAL_GAIN);
      this.invalidateMeasurements();
      if (next.enabled && next.fullAudioAnalysis && this.analysisResult) {
        this.applyFullTrackGain();
      }
      this.connectGraph();
    }

    if (previous.targetRms !== next.targetRms || previous.bassBoost !== next.bassBoost) {
      if (previous.bassBoost !== next.bassBoost) {
        this.invalidateMeasurements();
        this.cancelAnalysis();
        this.analysisAttemptKey = null;
        this.analysisResult = null;
        this.startAnalysis();
      } else this.invalidateMeasurements(false);
      this.agc.unlockGain();
      if (next.fullAudioAnalysis && this.analysisResult) this.applyFullTrackGain();
    }
    if (previous.minGain !== next.minGain || previous.maxGain !== next.maxGain) {
      if (next.fullAudioAnalysis && this.analysisResult) this.applyFullTrackGain();
      else this.agc.unlockGain();
      this.setGain(this.gain.gain.value);
    }
    if (previous.fullAudioAnalysis === next.fullAudioAnalysis) return;

    if (next.fullAudioAnalysis) {
      logDiagnostic('完整音轨模式：开启', this.diagnosticState());
      this.analysisAttemptKey = null;
      this.startAnalysis();
      return;
    }
    this.cancelAnalysis();
    this.analysisAttemptKey = null;
    this.analysisResult = null;
    if (this.agc.isLocked()) this.agc.unlockGain();
    this.analysisStatus = 'realtime';
    logDiagnostic('完整音轨模式：关闭，保留实时状态', this.diagnosticState());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.cancelAnalysis();
    this.media.removeEventListener('emptied', this.onEmptied);
    this.media.removeEventListener('play', this.onPlay);
    this.media.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    this.media.removeEventListener('seeked', this.onSeeked);
    this.disconnectGraph();
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor = null;
    }
    this.releaseOutput();
  }

  private bindEvents(): void {
    this.media.addEventListener('emptied', this.onEmptied);
    this.media.addEventListener('play', this.onPlay);
    this.media.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.media.addEventListener('seeked', this.onSeeked);
  }

  private loadProcessor(): void {
    this.output.ready.then(() => {
      if (this.destroyed) return;
      if (!this.output.isReady()) throw new Error('Mixed output protection unavailable');
      const node = createMediaMeter(this.context);
      node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        if (event.data?.type === 'meter') this.consumeAudio(event.data);
      };
      node.onprocessorerror = (error) => {
        warnFailure('audio-processor', 'Audio processor failed', error);
        if (!this.destroyed && this.processor === node) {
          node.port.onmessage = null;
          try { node.disconnect(); } catch { /* already disconnected */ }
          this.processor = null;
          this.analysisStatus = 'processor-unavailable';
          this.invalidateMeasurements();
          this.connectGraph();
        }
      };
      this.processor = node;
      this.setGain(INITIAL_GAIN);
      if (this.analysisStatus === 'processor-unavailable') {
        this.analysisStatus = 'realtime';
      }
      this.invalidateMeasurements(!(this.settings.fullAudioAnalysis && this.analysisResult));
      this.connectGraph();
    }).catch((error) => {
      if (this.destroyed) return;
      if (this.analysisStatus === 'realtime') {
        this.analysisStatus = 'processor-unavailable';
      }
      warnFailure(
        'audio-processor-load',
        'AudioWorklet load failed; protected output remains muted',
        error
      );
    });
  }

  private connectGraph(): void {
    if (this.destroyed) return;
    this.disconnectGraph();
    if (!this.settings.enabled) {
      this.source.connect(this.context.destination);
      return;
    }
    if (this.processor && this.output.isReady()) {
      this.source.connect(this.bass);
      this.bass.connect(this.gain);
      this.gain.connect(this.processor, 0, 0);
      this.bass.connect(this.processor, 0, 1);
      this.output.connect(this.processor);
      return;
    }
    // A failed processor must not release a stale boosted signal.
    this.setGain(0);
    this.source.connect(this.gain);
    this.gain.connect(this.context.destination);
  }

  private disconnectGraph(): void {
    for (const node of [
      this.source,
      this.gain,
      this.bass,
      this.processor
    ]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
  }

  private consumeAudio(message: MeterMessage): void {
    if (!this.destroyed) this.refreshMediaIdentity();
    if (
      this.destroyed
      || !this.settings.enabled
      || message.epoch !== this.meterEpoch
      || !message.original.length
    ) return;
    this.originalMeter.processChannels(message.original);
    const duration = message.original[0].length / this.context.sampleRate;
    if (!this.media.muted && !this.media.paused && !this.media.ended) {
      this.updateGain(duration);
    }
  }

  private tick(): void {
    if (this.destroyed) return;
    if (document.hidden) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.emitMeter();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private updateGain(deltaSec: number): void {
    this.gainState = this.agc.update({
      currentGain: this.gain.gain.value,
      minGain: this.settings.minGain,
      maxGain: this.settings.maxGain,
      deltaSec,
      targetLufs: rmsToLufs(this.settings.targetRms),
      integratedLufs: this.originalMeter.getIntegratedLoudness(),
      momentaryLufs: this.originalMeter.getMomentaryLoudness(),
      gainChangePerSec: this.settings.gainChangePerSec
    });
    this.setGain(this.gainState.nextGain);
  }

  private emitMeter(): void {
    if (!this.settings.enabled) {
      this.onMeter({ ...EMPTY_METER_STATE, analysisStatus: this.analysisStatus });
      return;
    }
    const originalLufs = this.originalMeter.getIntegratedLoudness();
    const output = this.output.getState();
    this.onMeter({
      ...output,
      originalMomentaryLufs: this.originalMeter.getMomentaryLoudness(),
      phase: this.gainState.phase,
      gainLimited: this.gainState.limited,
      originalIntegratedLufs: originalLufs,
      gain: this.gain.gain.value * output.safetyGain,
      sampleCount: Math.floor(this.originalMeter.getIntegrationTime()),
      analysisStatus: this.processor && this.output.isReady() ? this.analysisStatus : 'processor-unavailable'
    });
  }

  private setGain(value: number): void {
    const gain = this.settings.enabled && (!this.processor || !this.output.isReady()) ? 0
      : clamp(value, this.settings.minGain, this.settings.maxGain);
    const time = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(time);
    this.gain.gain.setValueAtTime(gain, time);
  }

  private resetMeters(resetAgc = true): void {
    this.originalMeter.reset({ preserveIntegrated: !resetAgc });
    this.output.resetForMedia(!resetAgc);
    if (resetAgc) {
      this.agc.reset();
      this.gainState = { nextGain: this.gain.gain.value, phase: 'collecting', referenceLufs: NaN, limited: false };
    }
  }

  private invalidateMeasurements(resetAgc = true): void {
    this.meterEpoch++;
    this.processor?.port.postMessage({ type: 'reset-meter', epoch: this.meterEpoch });
    this.resetMeters(resetAgc);
  }

  private startAnalysis(): void {
    if (!this.settings.fullAudioAnalysis || this.destroyed) return;
    const durationStatus = classifyMediaDuration(this.media.duration);
    if (durationStatus !== 'ready') {
      this.analysisStatus = durationStatus === 'waiting' ? 'waiting-metadata' : 'unsupported';
      return;
    }
    // 未播放的媒体不发起全量拉取（避免 feed 页几十个视频同时下载+解码+分析）；
    // 等 play 事件触发 startAnalysis 后再真正拉取。
    if (this.media.paused) {
      this.analysisStatus = 'waiting-play';
      return;
    }
    const attemptKey = this.analysisKey();
    if (this.analysisAttemptKey === attemptKey) return;
    if (this.analysisAttemptKey !== null) {
      this.cancelAnalysis();
      this.analysisResult = null;
    }
    this.analysisAttemptKey = attemptKey;
    const abort = new AbortController();
    this.analysisAbort = abort;
    this.analysisStatus = 'analyzing';
    analyzeFullAudio(this.media, this.context, abort.signal, this.settings.bassBoost).then((result) => {
      if (
        this.destroyed
        || abort.signal.aborted
        || this.analysisAttemptKey !== attemptKey
      ) return;
      this.analysisResult = result;
      this.applyFullTrackGain();
    }).catch((error) => {
      if (abort.signal.aborted) return;
      this.analysisResult = null;
      this.analysisStatus = error instanceof FullAudioAnalysisError && error.code === 'incomplete'
        ? 'incomplete'
        : 'failed';
      logDiagnostic('完整音轨：分析失败详情', {
        code: error instanceof FullAudioAnalysisError ? error.code : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        ...this.diagnosticState()
      });
      warnFailure('full-audio-analysis', '完整音轨分析失败，继续使用实时算法', error);
    }).finally(() => {
      if (this.analysisAbort === abort) this.analysisAbort = null;
    });
  }

  private applyFullTrackGain(): void {
    if (!this.analysisResult || !this.settings.fullAudioAnalysis) return;
    const fixedGain = calculateFullAudioGain(
      this.analysisResult,
      rmsToLufs(this.settings.targetRms),
      this.settings.minGain,
      this.settings.maxGain
    );
    this.agc.lockGain(fixedGain);
    this.analysisStatus = 'full-track';
    logDiagnostic('完整音轨：固定 gain 已应用', {
      fixedGain,
      integratedLufs: this.analysisResult.integratedLufs,
      analyzedDurationSeconds: this.analysisResult.duration,
      ...this.diagnosticState()
    });
  }

  private cancelAnalysis(): void {
    this.analysisAbort?.abort();
    this.analysisAbort = null;
  }

  private analysisKey(): string {
    const source = this.media.currentSrc || this.media.src || 'inline-media';
    return `${source}|${this.media.duration}`;
  }

  private currentMediaKey(): string {
    const source = this.media.currentSrc || this.media.src || 'inline-media';
    // Bilibili can reuse a media element/MediaSource across SPA navigation.
    const route = typeof location !== 'undefined'
      && /(^|\.)bilibili\.com$/.test(location.hostname)
      ? location.pathname + '?p=' + (new URLSearchParams(location.search).get('p') || '1') : '';
    return source + '|' + route;
  }

  private refreshMediaIdentity(): void {
    if (this.currentMediaKey() !== this.mediaKey) this.onEmptied();
  }

  private diagnosticState(): Record<string, number> {
    return {
      currentGain: this.gain.gain.value,
      currentTimeSeconds: this.media.currentTime,
      videoDurationSeconds: this.media.duration
    };
  }
}
