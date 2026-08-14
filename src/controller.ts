import { ensureAudioContext, ensureMediaSource } from './audio-context';
import { INTEGRATION_PARAMS, Settings } from './config';
import { analyzeFullAudio, calculateFullAudioGain, classifyMediaDuration, FullAudioAnalysisError, FullAudioAnalysisResult } from './full-audio-analysis';
import { RealtimeAgc, chooseControlLoudness } from './gain-control';
import { logDiagnostic, warnFailure } from './logger';
import { LoudnessMeter, calculateGainForLoudness } from './loudness-meter';
import { clamp, lufsToRms, rmsToLufs } from './lufs-calculator';
import { AnalysisStatus, EMPTY_METER_STATE, MeterState } from './types';

type MeterMessage = {
  type: 'meter';
  epoch: number;
  original: Float32Array[];
  output: Float32Array[];
};

let processorModulePromise: Promise<void> | null = null;

function loadProcessorModule(context: AudioContext, url: string): Promise<void> {
  return processorModulePromise ??= context.audioWorklet.addModule(url).catch((error) => {
    processorModulePromise = null;
    throw error;
  });
}

export class MediaVolumeController {
  private readonly media: HTMLMediaElement;
  private readonly onMeter: (state: MeterState) => void;
  private readonly onActivate: () => void;
  private settings: Settings;
  private readonly context: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly gain: GainNode;
  private readonly bass: BiquadFilterNode;
  private readonly fallbackLimiter: DynamicsCompressorNode;
  private processor: AudioWorkletNode | null = null;
  private originalMeter: LoudnessMeter;
  private outputMeter: LoudnessMeter;
  private agc = new RealtimeAgc();
  private analysisStatus: AnalysisStatus = 'realtime';
  private analysisAbort: AbortController | null = null;
  private analysisAttemptKey: string | null = null;
  private analysisResult: FullAudioAnalysisResult | null = null;
  private meterEpoch = 0;
  private originalRms = 0;
  private outputRms = 0;
  private originalPeak = 0;
  private rafId = 0;
  private lastTickAt = performance.now();
  private backgroundGainCeiling: number | null = null;
  private destroyed = false;

  private readonly onEmptied = () => {
    this.cancelAnalysis();
    this.analysisAttemptKey = null;
    this.analysisResult = null;
    this.analysisStatus = this.settings.fullAudioAnalysis ? 'waiting-metadata' : 'realtime';
    this.setGain(1);
    this.invalidateMeasurements();
  };

  private readonly onPlay = () => {
    this.onActivate();
    this.context.resume().catch((error) => {
      warnFailure('media-play-resume', 'AudioContext play resume failed', error);
    });
    this.startAnalysis();
  };

  private readonly onLoadedMetadata = () => this.startAnalysis();
  private readonly onSeeked = () => {
    // seek 后旧积分窗口与校准锚点失效：重置测量并重新校准（完整音轨锁定时保留固定 gain）。
    this.invalidateMeasurements(!(this.settings.fullAudioAnalysis && this.analysisResult));
  };
  private readonly onVisibility = () => {
    this.lastTickAt = performance.now();
    if (document.hidden) {
      this.backgroundGainCeiling = clamp(
        this.gain.gain.value,
        this.settings.minGain,
        this.settings.maxGain
      );
      this.setGain(this.backgroundGainCeiling);
      this.invalidateMeasurements(!(this.settings.fullAudioAnalysis && this.analysisResult));
      return;
    }
    this.backgroundGainCeiling = null;
    this.invalidateMeasurements(!(this.settings.fullAudioAnalysis && this.analysisResult));
  };

  constructor(
    media: HTMLMediaElement,
    settings: Settings,
    onMeter: (state: MeterState) => void,
    onActivate: () => void
  ) {
    this.media = media;
    this.settings = settings;
    this.onMeter = onMeter;
    this.onActivate = onActivate;
    this.context = ensureAudioContext();
    this.source = ensureMediaSource(media);
    this.gain = this.context.createGain();
    this.bass = this.context.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 200;
    this.bass.gain.value = settings.bassBoost;
    this.fallbackLimiter = this.context.createDynamicsCompressor();
    this.fallbackLimiter.threshold.value = -1;
    this.fallbackLimiter.knee.value = 0;
    this.fallbackLimiter.ratio.value = 20;
    this.fallbackLimiter.attack.value = 0.001;
    this.fallbackLimiter.release.value = 0.05;
    this.originalMeter = new LoudnessMeter(this.context.sampleRate);
    this.outputMeter = new LoudnessMeter(this.context.sampleRate);

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

    if (previous.enabled !== next.enabled) {
      this.setGain(1);
      this.invalidateMeasurements();
      if (next.enabled && next.fullAudioAnalysis && this.analysisResult) {
        this.applyFullTrackGain();
      }
      this.connectGraph();
    }

    if (previous.targetRms !== next.targetRms) {
      this.invalidateMeasurements();
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
    if (this.agc.isLocked()) {
      this.agc.unlockGain();
    }
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.media.removeEventListener('seeked', this.onSeeked);
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor = null;
    }
    this.disconnectGraph();
  }

  private bindEvents(): void {
    this.media.addEventListener('emptied', this.onEmptied);
    this.media.addEventListener('play', this.onPlay);
    this.media.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.media.addEventListener('seeked', this.onSeeked);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private loadProcessor(): void {
    const url = chrome.runtime.getURL('limiter-worklet.js');
    loadProcessorModule(this.context, url).then(() => {
      if (this.destroyed) return;
      const node = new AudioWorkletNode(this.context, 'lookahead-peak-limiter', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        processorOptions: {
          lookaheadMs: 15,
          releaseMs: 50,
          ceiling: 0.8912509381337456,
          interSampleMargin: 1.03
        }
      });
      // 保持与输入相同的声道数（5.1/7.1 不做立体声降混），worklet 按声道独立限峰；
      // 实时响度按 BS.1770 多声道加权，与完整音轨分析口径一致。
      node.channelCountMode = 'max';
      node.channelInterpretation = 'speakers';
      node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        if (event.data?.type === 'meter') this.consumeAudio(event.data);
      };
      node.onprocessorerror = (error) => {
        warnFailure('audio-processor', 'Audio processor failed', error);
        if (!this.destroyed && this.processor === node) {
          node.port.onmessage = null;
          try { node.disconnect(); } catch { /* already disconnected */ }
          this.processor = null;
          if (this.analysisStatus === 'realtime') {
            this.analysisStatus = 'processor-unavailable';
          }
          this.invalidateMeasurements();
          this.connectGraph();
        }
      };
      this.processor = node;
      if (this.analysisStatus === 'processor-unavailable') {
        this.analysisStatus = 'realtime';
      }
      this.invalidateMeasurements(!(this.settings.fullAudioAnalysis && this.analysisResult));
      this.connectGraph();
    }).catch((error) => {
      if (this.analysisStatus === 'realtime') {
        this.analysisStatus = 'processor-unavailable';
      }
      warnFailure(
        'audio-processor-load',
        'AudioWorklet load failed; keeping safe fixed gain',
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
    if (this.processor) {
      this.source.connect(this.gain);
      this.gain.connect(this.bass);
      this.bass.connect(this.processor, 0, 0);
      this.source.connect(this.processor, 0, 1);
      this.processor.connect(this.context.destination);
      return;
    }
    this.source.connect(this.gain);
    this.gain.connect(this.bass);
    this.bass.connect(this.fallbackLimiter);
    this.fallbackLimiter.connect(this.context.destination);
  }

  private disconnectGraph(): void {
    for (const node of [
      this.source,
      this.gain,
      this.bass,
      this.fallbackLimiter,
      this.processor
    ]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
  }

  private consumeAudio(message: MeterMessage): void {
    if (
      this.destroyed
      || document.hidden
      || !this.settings.enabled
      || message.epoch !== this.meterEpoch
      || !message.original.length
    ) return;
    this.originalMeter.processChannels(message.original);
    this.outputMeter.processChannels(message.output);
    this.originalRms = channelRms(message.original);
    this.outputRms = channelRms(message.output);
    this.originalPeak = channelPeak(message.original);
  }

  private tick(): void {
    if (this.destroyed) return;
    const now = performance.now();
    const deltaSec = clamp((now - this.lastTickAt) / 1000, 0.001, 0.25);
    this.lastTickAt = now;

    if (document.hidden) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    if (
      this.settings.enabled
      && this.processor
      && !this.media.muted
      && !this.media.paused
      && !this.media.ended
    ) {
      this.updateGain(deltaSec);
    }
    this.emitMeter();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private updateGain(deltaSec: number): void {
    const integratedLufs = this.originalMeter.getIntegratedLoudness();
    const integrationTime = this.originalMeter.getIntegrationTime();
    const momentaryLufs = this.originalMeter.getMomentaryLoudness();
    const shortTermLufs = this.originalMeter.getShortTermLoudness();
    const targetLufs = rmsToLufs(this.settings.targetRms);
    const controlLufs = chooseControlLoudness({
      integratedLufs,
      shortTermLufs,
      momentaryLufs,
      integrationTime,
      minIntegrationSeconds: INTEGRATION_PARAMS.minIntegrationSeconds,
      calibrationSeconds: INTEGRATION_PARAMS.coldStartSeconds,
      calibrationSafetyThresholdLufs: targetLufs + 3
    });
    if (!Number.isFinite(controlLufs)) return;

    const calibrationGain = calculateGainForLoudness(controlLufs, targetLufs);
    const result = this.agc.update({
      currentGain: this.gain.gain.value,
      desiredGain: calibrationGain,
      calibrationGain,
      minGain: this.settings.minGain,
      maxGain: this.settings.maxGain,
      deltaSec,
      controlLufs,
      targetLufs,
      integrationTime,
      coldStartSeconds: INTEGRATION_PARAMS.coldStartSeconds,
      sourcePeak: this.originalPeak,
      momentaryLufs,
      shortTermLufs,
      gainChangePerSec: this.settings.gainChangePerSec,
      calibrationBoostStartSeconds: INTEGRATION_PARAMS.calibrationBoostStartSeconds,
      postCalibrationCorridor: INTEGRATION_PARAMS.postCalibrationCorridor,
      postCalibrationDbCorridor: INTEGRATION_PARAMS.postCalibrationDbCorridor,
      programTimeSeconds: this.media.currentTime
    });
    this.setGain(result.nextGain);
  }

  private emitMeter(): void {
    if (!this.settings.enabled) {
      this.onMeter({ ...EMPTY_METER_STATE, analysisStatus: this.analysisStatus });
      return;
    }
    const originalLufs = this.originalMeter.getIntegratedLoudness();
    const outputLufs = this.outputMeter.getIntegratedLoudness();
    this.onMeter({
      rms: this.settings.enabled ? this.outputRms : this.originalRms,
      integratedRms: Number.isFinite(outputLufs) ? lufsToRms(outputLufs) : this.outputRms,
      originalRms: this.originalRms,
      originalIntegratedRms: Number.isFinite(originalLufs)
        ? lufsToRms(originalLufs)
        : this.originalRms,
      gain: this.settings.enabled ? this.gain.gain.value : 1,
      sampleCount: Math.floor(this.originalMeter.getIntegrationTime()),
      analysisStatus: this.analysisStatus
    });
  }

  private setGain(value: number): void {
    const bounded = clamp(value, this.settings.minGain, this.settings.maxGain);
    const gain = this.backgroundGainCeiling === null
      ? bounded
      : Math.min(bounded, this.backgroundGainCeiling);
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(gain, this.context.currentTime);
  }

  private resetMeters(resetAgc = true): void {
    this.originalMeter.reset();
    this.outputMeter.reset();
    if (resetAgc) this.agc.reset();
    this.originalRms = this.outputRms = this.originalPeak = 0;
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
    analyzeFullAudio(this.media, this.context, abort.signal).then((result) => {
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

  private diagnosticState(): Record<string, number> {
    return {
      currentGain: this.gain.gain.value,
      currentTimeSeconds: this.media.currentTime,
      videoDurationSeconds: this.media.duration
    };
  }
}

function channelRms(channels: Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) sum += channel[index] ** 2;
    count += channel.length;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function channelPeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      peak = Math.max(peak, Math.abs(channel[index]));
    }
  }
  return peak;
}
