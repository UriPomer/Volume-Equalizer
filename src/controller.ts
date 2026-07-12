import { ensureAudioContext, ensureMediaSource } from './audio-context';
import { INTEGRATION_PARAMS, Settings } from './config';
import { analyzeFullAudio, calculateFullAudioGain, classifyMediaDuration, FullAudioAnalysisError, FullAudioAnalysisResult } from './full-audio-analysis';
import { RealtimeAgc, chooseControlLoudness } from './gain-control';
import { logDiagnostic, warnFailure } from './logger';
import { LoudnessMeter, calculateGainForLoudness } from './loudness-meter';
import { clamp, lufsToRms, rmsToLufs } from './lufs-calculator';
import { AnalysisStatus, MeterState } from './types';

type MeterMessage = {
  type: 'meter';
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
  private readonly fallbackAnalyser: AnalyserNode;
  private readonly fallbackBuffer: Float32Array<ArrayBuffer>;
  private processor: AudioWorkletNode | null = null;
  private originalMeter: LoudnessMeter;
  private outputMeter: LoudnessMeter;
  private agc = new RealtimeAgc();
  private analysisStatus: AnalysisStatus = 'realtime';
  private analysisAbort: AbortController | null = null;
  private analysisResult: FullAudioAnalysisResult | null = null;
  private originalRms = 0;
  private outputRms = 0;
  private originalPeak = 0;
  private rafId = 0;
  private lastTickAt = performance.now();
  private destroyed = false;

  private readonly onEmptied = () => {
    this.cancelAnalysis();
    this.analysisResult = null;
    this.analysisStatus = this.settings.fullAudioAnalysis ? 'waiting-metadata' : 'realtime';
    this.setGain(1);
    this.resetMeters();
  };

  private readonly onPlay = () => {
    this.onActivate();
    this.context.resume().catch((error) => {
      warnFailure('media-play-resume', 'AudioContext play resume failed', error);
    });
    this.startAnalysis();
  };

  private readonly onLoadedMetadata = () => this.startAnalysis();
  private readonly onVisibility = () => {
    this.lastTickAt = performance.now();
    if (document.visibilityState === 'visible') {
      this.resetMeters(!(this.settings.fullAudioAnalysis && this.analysisResult));
    }
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
    this.fallbackAnalyser = this.context.createAnalyser();
    this.fallbackAnalyser.fftSize = 2048;
    this.fallbackBuffer = new Float32Array(this.fallbackAnalyser.fftSize);
    this.originalMeter = new LoudnessMeter(this.context.sampleRate);
    this.outputMeter = new LoudnessMeter(this.context.sampleRate);

    this.bindEvents();
    this.connectGraph();
    this.loadProcessor();
    this.startAnalysis();
    if (!media.paused) this.onActivate();
    this.tick = this.tick.bind(this);
    this.rafId = requestAnimationFrame(this.tick);
  }

  updateSettings(next: Settings): void {
    const changed = next._changedField;
    const wasEnabled = this.settings.enabled;
    const { _changedField: _, ...clean } = next;
    this.settings = clean;
    this.bass.gain.value = clean.bassBoost;
    if (wasEnabled !== clean.enabled) this.connectGraph();

    const boundsChanged = changed === 'minGain' || changed === 'maxGain';
    if (changed === 'targetLufs') {
      this.resetMeters();
      if (clean.fullAudioAnalysis && this.analysisResult) this.applyFullTrackGain();
    }
    if (boundsChanged) {
      if (clean.fullAudioAnalysis && this.analysisResult) this.applyFullTrackGain();
      else this.agc.unlockGain();
      this.setGain(this.gain.gain.value);
    }
    if (changed !== 'fullAudioAnalysis') return;

    if (clean.fullAudioAnalysis) {
      logDiagnostic('完整音轨模式：开启', this.diagnosticState());
      this.startAnalysis();
      return;
    }
    this.cancelAnalysis();
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
    if (this.processor) this.processor.port.onmessage = null;
    this.disconnectGraph();
  }

  private bindEvents(): void {
    this.media.addEventListener('emptied', this.onEmptied);
    this.media.addEventListener('play', this.onPlay);
    this.media.addEventListener('loadedmetadata', this.onLoadedMetadata);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private loadProcessor(): void {
    const url = chrome.runtime.getURL('limiter-worklet.js');
    loadProcessorModule(this.context, url).then(() => {
      if (this.destroyed) return;
      const node = new AudioWorkletNode(this.context, 'lookahead-peak-limiter', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          lookaheadMs: 15,
          releaseMs: 50,
          ceiling: 0.8912509381337456,
          interSampleMargin: 1.03
        }
      });
      node.channelCount = 2;
      node.channelCountMode = 'explicit';
      node.channelInterpretation = 'speakers';
      node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        if (event.data?.type === 'meter') this.consumeAudio(event.data);
      };
      node.onprocessorerror = (error) => {
        warnFailure('audio-processor', 'Audio processor failed', error);
        if (this.processor === node) {
          node.port.onmessage = null;
          try { node.disconnect(); } catch { /* already disconnected */ }
          this.processor = null;
          this.connectGraph();
        }
      };
      this.processor = node;
      this.connectGraph();
    }).catch((error) => {
      warnFailure('audio-processor-load', 'AudioWorklet load failed; using snapshot fallback', error);
    });
  }

  private connectGraph(): void {
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
    this.source.connect(this.fallbackAnalyser);
    this.fallbackAnalyser.connect(this.gain);
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
      this.fallbackAnalyser,
      this.processor
    ]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
  }

  private consumeAudio(message: MeterMessage): void {
    if (this.destroyed || !message.original.length) return;
    this.originalMeter.processChannels(message.original);
    this.outputMeter.processChannels(message.output);
    this.originalRms = channelRms(message.original);
    this.outputRms = channelRms(message.output);
    this.originalPeak = channelPeak(message.original);
  }

  private sampleFallback(): void {
    this.fallbackAnalyser.getFloatTimeDomainData(this.fallbackBuffer);
    this.originalMeter.processBlock(this.fallbackBuffer);
    this.originalRms = channelRms([this.fallbackBuffer]);
    this.outputRms = this.originalRms * this.gain.gain.value;
    this.originalPeak = channelPeak([this.fallbackBuffer]);
    for (let index = 0; index < this.fallbackBuffer.length; index++) {
      this.fallbackBuffer[index] *= this.gain.gain.value;
    }
    this.outputMeter.processBlock(this.fallbackBuffer);
  }

  private tick(): void {
    if (this.destroyed) return;
    const now = performance.now();
    const deltaSec = clamp((now - this.lastTickAt) / 1000, 0.001, 0.25);
    this.lastTickAt = now;

    if (!document.hidden && this.settings.enabled && !this.processor) this.sampleFallback();
    if (this.settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
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
    const controlLufs = chooseControlLoudness({
      integratedLufs,
      shortTermLufs,
      momentaryLufs,
      integrationTime,
      minIntegrationSeconds: INTEGRATION_PARAMS.minIntegrationSeconds
    });
    if (!Number.isFinite(controlLufs)) return;

    const targetLufs = rmsToLufs(this.settings.targetRms);
    const result = this.agc.update({
      currentGain: this.gain.gain.value,
      desiredGain: calculateGainForLoudness(controlLufs, targetLufs),
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
      programTimeSeconds: this.media.currentTime
    });
    this.setGain(result.nextGain);
  }

  private emitMeter(): void {
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
    const gain = clamp(value, this.settings.minGain, this.settings.maxGain);
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(gain, this.context.currentTime);
  }

  private resetMeters(resetAgc = true): void {
    this.originalMeter.reset();
    this.outputMeter.reset();
    if (resetAgc) this.agc.reset();
    this.originalRms = this.outputRms = this.originalPeak = 0;
  }

  private startAnalysis(): void {
    if (!this.settings.fullAudioAnalysis || this.destroyed || this.analysisAbort || this.analysisResult) return;
    const durationStatus = classifyMediaDuration(this.media.duration);
    if (durationStatus !== 'ready') {
      this.analysisStatus = durationStatus === 'waiting' ? 'waiting-metadata' : 'unsupported';
      return;
    }
    const abort = new AbortController();
    this.analysisAbort = abort;
    this.analysisStatus = 'analyzing';
    analyzeFullAudio(this.media, this.context, abort.signal).then((result) => {
      if (this.destroyed || abort.signal.aborted) return;
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
