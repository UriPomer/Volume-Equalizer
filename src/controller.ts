/**
 * MediaVolumeController - 媒体音量控制器
 * 负责音频信号链管理、响度测量和增益调整
 *
 * 使用 ITU-R BS.1770-4 标准响度测量算法
 */

import { ensureAudioContext } from './audio-context';
import { clamp, rmsToLufs } from './lufs-calculator';
import { INTEGRATION_PARAMS, DATASET_FLAG, BRAND, Settings } from './config';
import { eventBus, EVENTS } from './events/index';
import { LoudnessMeter, calculateGainForLoudness } from './loudness-meter';
import { RealtimeAgc, chooseControlLoudness } from './gain-control';
import { warnFailure } from './logger';

interface MeterState {
  rms: number;
  integratedRms: number;
  originalRms: number;
  originalIntegratedRms: number;
  gain: number;
  sampleCount: number;
  originalLufs: number;
  outputLufs: number;
  integrationTime: number;
}

type MeterStateCallback = (state: MeterState) => void;

let lookaheadLimiterModulePromise: Promise<void> | null = null;

function loadLookaheadLimiterModule(ctx: AudioContext, workletUrl: string): Promise<void> {
  if (!lookaheadLimiterModulePromise) {
    lookaheadLimiterModulePromise = ctx.audioWorklet.addModule(workletUrl).catch((error) => {
      lookaheadLimiterModulePromise = null;
      throw error;
    });
  }
  return lookaheadLimiterModulePromise;
}

export class MediaVolumeController {
  private media: HTMLMediaElement;
  private settings: Settings;
  private meterStateCallback: MeterStateCallback;
  private rafId = 0;
  private processingEnabled: boolean | null = null;
  private lastTickTime = performance.now();
  private agc = new RealtimeAgc();

  // ITU-R BS.1770-4 标准响度测量器
  private originalMeter: LoudnessMeter;
  private outputMeter: LoudnessMeter;

  // Web Audio 节点
  private audioContext!: AudioContext;
  private sourceNode!: MediaElementAudioSourceNode;
  private compressor!: DynamicsCompressorNode;
  gainNode!: GainNode;
  private originalAnalyser!: AnalyserNode;
  private originalBuffer!: Float32Array<ArrayBuffer>;
  private originalSplitter!: ChannelSplitterNode;
  private originalChannelAnalysers: AnalyserNode[] = [];
  private originalChannelBuffers: Float32Array<ArrayBuffer>[] = [];
  private analyser!: AnalyserNode;
  private buffer!: Float32Array<ArrayBuffer>;
  private outputSplitter!: ChannelSplitterNode;
  private outputChannelAnalysers: AnalyserNode[] = [];
  private outputChannelBuffers: Float32Array<ArrayBuffer>[] = [];
  private bassFilter!: BiquadFilterNode;
  private fallbackLimiter!: DynamicsCompressorNode;
  private workletLimiter: AudioWorkletNode | null = null;
  private destroyed = false;

  // 事件处理器引用（用于移除）
  private handleEmptied!: () => void;
  private handleSeeked!: () => void;
  private handlePlay!: () => void;
  private handlePause!: () => void;
  private handleVisibilityChange!: () => void;

  constructor(media: HTMLMediaElement, settings: Settings, meterStateCallback: MeterStateCallback) {
    this.media = media;
    this.settings = settings;
    this.meterStateCallback = meterStateCallback;

    this.originalMeter = new LoudnessMeter(48000);
    this.outputMeter = new LoudnessMeter(48000);

    this.initAudioNodes();
    this.bindEventListeners();

    this.tick = this.tick.bind(this);
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * 初始化 Web Audio API 节点
   */
  private initAudioNodes(): void {
    const ctx = ensureAudioContext();
    this.audioContext = ctx;

    this.sourceNode = ctx.createMediaElementSource(this.media);
    this.compressor = ctx.createDynamicsCompressor();
    this.gainNode = ctx.createGain();

    this.originalAnalyser = ctx.createAnalyser();
    this.originalAnalyser.fftSize = 2048;
    this.originalBuffer = new Float32Array(this.originalAnalyser.fftSize);
    this.originalSplitter = ctx.createChannelSplitter(2);
    this.originalChannelAnalysers = this.createChannelAnalysers(ctx);
    this.originalChannelBuffers = this.originalChannelAnalysers.map((analyser) => new Float32Array(analyser.fftSize));

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.outputSplitter = ctx.createChannelSplitter(2);
    this.outputChannelAnalysers = this.createChannelAnalysers(ctx);
    this.outputChannelBuffers = this.outputChannelAnalysers.map((analyser) => new Float32Array(analyser.fftSize));

    this.bassFilter = ctx.createBiquadFilter();
    this.bassFilter.type = 'lowshelf';
    this.bassFilter.frequency.value = 200;
    this.bassFilter.gain.value = this.settings.bassBoost;

    this.fallbackLimiter = ctx.createDynamicsCompressor();
    this.applyLimiter();
    this.initLookaheadLimiter();

    this.originalMeter = new LoudnessMeter(ctx.sampleRate);
    this.outputMeter = new LoudnessMeter(ctx.sampleRate);

    this.applyCompressor();
    this.setProcessingEnabled(this.settings.enabled);
  }

  /**
   * 绑定媒体事件监听器
   */
  private bindEventListeners(): void {
    this.handleEmptied = () => {
      eventBus.emit(EVENTS.MEDIA_EMPTIED, { media: this.media });
      this.resetGain();
    };

    this.handleSeeked = () => {
      eventBus.emit(EVENTS.MEDIA_SEEKED, { media: this.media });
      this.resetIntegration();
    };

    this.handlePlay = () => {
      eventBus.emit(EVENTS.MEDIA_PLAY, { media: this.media });
      try {
        const ctx = ensureAudioContext();
        if (ctx.state === 'suspended') {
          ctx.resume().catch((err) => {
            warnFailure('media-play-resume', 'AudioContext play resume failed', err);
          });
        }
      } catch (err) {
        warnFailure('media-play-handler', 'Media play handler failed', err);
      }
    };

    this.handlePause = () => {
      eventBus.emit(EVENTS.MEDIA_PAUSE, { media: this.media });
    };

    this.media.addEventListener('emptied', this.handleEmptied);
    this.media.addEventListener('seeked', this.handleSeeked);
    this.media.addEventListener('play', this.handlePlay);
    this.media.addEventListener('pause', this.handlePause);

    this.handleVisibilityChange = () => {
      this.freezeGain();
      this.resetIntegration();
      this.lastTickTime = performance.now();
    };
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /**
   * 应用压缩器设置
   */
  private applyCompressor(): void {
    this.compressor.threshold.value = this.settings.compressorThreshold;
    this.compressor.knee.value = this.settings.compressorKnee;
    this.compressor.ratio.value = this.settings.compressorRatio;
    this.compressor.attack.value = this.settings.compressorAttack;
    this.compressor.release.value = this.settings.compressorRelease;
  }

  private applyLimiter(): void {
    this.fallbackLimiter.threshold.value = -1;
    this.fallbackLimiter.knee.value = 0;
    this.fallbackLimiter.ratio.value = 20;
    this.fallbackLimiter.attack.value = 0.001;
    this.fallbackLimiter.release.value = 0.05;
  }

  private initLookaheadLimiter(): void {
    const workletUrl = this.getExtensionUrl('limiter-worklet.js');
    if (!workletUrl || !this.audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      return;
    }

    loadLookaheadLimiterModule(this.audioContext, workletUrl)
      .then(() => {
        if (this.destroyed) return;
        const limiter = new AudioWorkletNode(this.audioContext, 'lookahead-peak-limiter', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            lookaheadMs: 15,
            releaseMs: 50,
            ceiling: 0.8912509381337456,
            interSampleMargin: 1.03
          }
        });
        limiter.onprocessorerror = (event) => {
          warnFailure('lookahead-limiter-processor', 'Lookahead limiter processor failed', event);
        };
        this.workletLimiter = limiter;
        this.reconnectCurrentChain();
      })
      .catch((error) => {
        warnFailure('lookahead-limiter-load', 'Lookahead limiter load failed; using compressor fallback', error);
      });
  }

  private getExtensionUrl(path: string): string | null {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
      }
    } catch (error) {
      warnFailure('extension-url', 'Failed to resolve extension asset URL', error);
    }
    return null;
  }

  private setProcessingEnabled(enabled: boolean): void {
    if (this.processingEnabled === enabled) return;
    this.processingEnabled = enabled;

    if (enabled) {
      this.connectProcessingChain();
    } else {
      this.connectBypassChain();
      this.gainNode.gain.value = 1.0;
    }
  }

  private disconnectNodes(): void {
    this.safeDisconnect(this.sourceNode);
    this.safeDisconnect(this.compressor);
    this.safeDisconnect(this.originalAnalyser);
    this.safeDisconnect(this.originalSplitter);
    this.originalChannelAnalysers.forEach((node) => this.safeDisconnect(node));
    this.safeDisconnect(this.gainNode);
    this.safeDisconnect(this.bassFilter);
    this.safeDisconnect(this.fallbackLimiter);
    if (this.workletLimiter) this.safeDisconnect(this.workletLimiter);
    this.safeDisconnect(this.analyser);
    this.safeDisconnect(this.outputSplitter);
    this.outputChannelAnalysers.forEach((node) => this.safeDisconnect(node));
  }

  private safeDisconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      // Nodes may already be disconnected during worklet hot-swap or teardown.
    }
  }

  private reconnectCurrentChain(): void {
    if (this.processingEnabled) {
      this.connectProcessingChain();
    } else {
      this.connectBypassChain();
    }
  }

  private connectProcessingChain(): void {
    this.disconnectNodes();
    this.sourceNode.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.compressor);
    this.originalAnalyser.connect(this.originalSplitter);
    this.connectSplitter(this.originalSplitter, this.originalChannelAnalysers);
    this.compressor.connect(this.gainNode);
    this.gainNode.connect(this.bassFilter);
    const limiter = this.workletLimiter ?? this.fallbackLimiter;
    this.bassFilter.connect(limiter);
    limiter.connect(this.analyser);
    this.analyser.connect(this.outputSplitter);
    this.connectSplitter(this.outputSplitter, this.outputChannelAnalysers);
    this.analyser.connect(this.audioContext.destination);
  }

  private connectBypassChain(): void {
    this.disconnectNodes();
    this.sourceNode.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.originalSplitter);
    this.connectSplitter(this.originalSplitter, this.originalChannelAnalysers);
    this.originalAnalyser.connect(this.analyser);
    this.analyser.connect(this.outputSplitter);
    this.connectSplitter(this.outputSplitter, this.outputChannelAnalysers);
    this.analyser.connect(this.audioContext.destination);
  }

  private createChannelAnalysers(ctx: AudioContext): AnalyserNode[] {
    return [ctx.createAnalyser(), ctx.createAnalyser()].map((analyser) => {
      analyser.fftSize = 2048;
      return analyser;
    });
  }

  private connectSplitter(splitter: ChannelSplitterNode, analysers: AnalyserNode[]): void {
    for (let channel = 0; channel < analysers.length; channel++) {
      splitter.connect(analysers[channel], channel);
    }
  }

  /**
   * 更新设置
   */
  updateSettings(newSettings: Settings): void {
    const { _changedField, ...restSettings } = newSettings;
    const targetChanged = _changedField === 'targetLufs';
    const wasEnabled = this.settings.enabled;

    this.settings = restSettings;

    this.applyCompressor();
    this.bassFilter.gain.value = restSettings.bassBoost;
    if (wasEnabled !== restSettings.enabled) {
      this.setProcessingEnabled(restSettings.enabled);
    }

    if (targetChanged) {
      this.resetOutputIntegration();
    }
  }

  /**
   * 重置增益到 1.0 并清空积分历史
   */
  private resetGain(): void {
    this.setGainImmediate(1);
    this.resetIntegration();
  }

  /**
   * 重置积分历史
   */
  private resetIntegration(): void {
    this.originalMeter.reset();
    this.outputMeter.reset();
    this.agc.reset();
  }

  private setGainImmediate(gain: number): void {
    const clampedGain = clamp(gain, this.settings.minGain, this.settings.maxGain);
    this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.gainNode.gain.setValueAtTime(clampedGain, this.audioContext.currentTime);
    this.gainNode.gain.value = clampedGain;
  }

  private freezeGain(): void {
    this.setGainImmediate(this.gainNode.gain.value);
  }

  /**
   * 只重置输出响度的积分历史
   */
  private resetOutputIntegration(): void {
    this.outputMeter.reset();

    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();
    this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
  }

  /**
   * 测量输出 RMS
   */
  private measureRms(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const sample = this.buffer[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / this.buffer.length);
  }

  /**
   * 测量原始 RMS (压缩和增益前)
   */
  private measureOriginalRms(): number {
    this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);
    let sum = 0;
    for (let i = 0; i < this.originalBuffer.length; i++) {
      const sample = this.originalBuffer[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / this.originalBuffer.length);
  }

  private measureOriginalPeak(): number {
    let peak = 0;
    for (let channel = 0; channel < this.originalChannelBuffers.length; channel++) {
      const buffer = this.originalChannelBuffers[channel];
      for (let i = 0; i < buffer.length; i++) {
        const sample = Math.abs(buffer[i]);
        if (sample > peak) peak = sample;
      }
    }
    return peak;
  }

  /**
   * 更新 ITU-R BS.1770-4 响度测量
   */
  private updateLoudnessMeasurement(): void {
    const silenceThreshold = INTEGRATION_PARAMS.silenceThreshold;

    let hasOriginalAudio = false;
    let hasOutputAudio = false;

    for (const buffer of this.originalChannelBuffers) {
      for (let i = 0; i < buffer.length; i++) {
        if (Math.abs(buffer[i]) > silenceThreshold) {
          hasOriginalAudio = true;
          break;
        }
      }
      if (hasOriginalAudio) break;
    }

    for (const buffer of this.outputChannelBuffers) {
      for (let i = 0; i < buffer.length; i++) {
        if (Math.abs(buffer[i]) > silenceThreshold) {
          hasOutputAudio = true;
          break;
        }
      }
      if (hasOutputAudio) break;
    }

    if (hasOriginalAudio) {
      this.originalMeter.processChannels(this.originalChannelBuffers);
    }
    if (hasOutputAudio) {
      this.outputMeter.processChannels(this.outputChannelBuffers);
    }
  }

  /**
   * 主循环 - 测量响度并调整增益
   */
  private tick(): void {
    if (!document.contains(this.media)) {
      this.destroy();
      return;
    }

    if (document.hidden) {
      this.freezeGain();
      this.lastTickTime = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }

    const now = performance.now();
    const deltaSec = Math.max(0.001, Math.min((now - this.lastTickTime) / 1000, 0.25));
    this.lastTickTime = now;

    this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);
    this.analyser.getFloatTimeDomainData(this.buffer);
    this.readChannelData(this.originalChannelAnalysers, this.originalChannelBuffers);
    this.readChannelData(this.outputChannelAnalysers, this.outputChannelBuffers);

    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();
    const originalPeak = this.measureOriginalPeak();

    this.updateLoudnessMeasurement();

    if (this.settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
      const originalLufs = this.originalMeter.getIntegratedLoudness();
      const outputLufs = this.outputMeter.getIntegratedLoudness();
      const integrationTime = this.originalMeter.getIntegrationTime();
      const momentaryLufs = this.originalMeter.getMomentaryLoudness();
      const shortTermLufs = this.originalMeter.getShortTermLoudness();
      const controlLufs = chooseControlLoudness({
        integratedLufs: originalLufs,
        shortTermLufs,
        momentaryLufs,
        integrationTime,
        minIntegrationSeconds: INTEGRATION_PARAMS.minIntegrationSeconds
      });

      if (isFinite(controlLufs)) {
        const targetLufs = rmsToLufs(this.settings.targetRms);
        const idealGain = calculateGainForLoudness(controlLufs, targetLufs);
        const agcResult = this.agc.update({
          currentGain: this.gainNode.gain.value,
          desiredGain: idealGain,
          minGain: this.settings.minGain,
          maxGain: this.settings.maxGain,
          deltaSec,
          controlLufs,
          targetLufs,
          integrationTime,
          coldStartSeconds: INTEGRATION_PARAMS.coldStartSeconds,
          sourcePeak: originalPeak,
          momentaryLufs,
          shortTermLufs,
          gainChangePerSec: this.settings.gainChangePerSec
        });
        const nextGain = agcResult.nextGain;

        this.setGainImmediate(nextGain);

        const displayOriginalLufs = isFinite(originalLufs) ? originalLufs : controlLufs;
        this.updateMeterState(currentRms, originalRms, nextGain, displayOriginalLufs, outputLufs);
      } else {
        this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
      }
    } else if (!this.settings.enabled) {
      this.setGainImmediate(1.0);
      this.updateMeterState(originalRms, originalRms, 1, null, null, true);
    } else {
      this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
    }

    this.rafId = requestAnimationFrame(this.tick);
  }

  private readChannelData(analysers: AnalyserNode[], buffers: Float32Array<ArrayBuffer>[]): void {
    for (let channel = 0; channel < analysers.length; channel++) {
      analysers[channel].getFloatTimeDomainData(buffers[channel]);
    }
  }

  /**
   * 更新 meter 状态（用于 UI 显示）
   */
  private updateMeterState(
    currentRms: number,
    originalRms: number,
    gain: number,
    originalLufs: number | null = null,
    outputLufs: number | null = null,
    disabled = false
  ): void {
    if (originalLufs === null) {
      originalLufs = this.originalMeter.getIntegratedLoudness();
    }
    if (outputLufs === null) {
      outputLufs = this.outputMeter.getIntegratedLoudness();
    }

    const integratedRms = isFinite(outputLufs)
      ? Math.pow(10, (outputLufs + 0.691) / 20)
      : currentRms;
    const originalIntegratedRms = isFinite(originalLufs)
      ? Math.pow(10, (originalLufs + 0.691) / 20)
      : originalRms;

    this.meterStateCallback({
      rms: disabled ? originalRms : currentRms,
      integratedRms: disabled ? originalIntegratedRms : integratedRms,
      originalRms,
      originalIntegratedRms,
      gain,
      sampleCount: Math.floor(this.originalMeter.getIntegrationTime()),
      originalLufs,
      outputLufs,
      integrationTime: this.originalMeter.getIntegrationTime()
    });
  }

  /**
   * 销毁控制器并清理资源
   */
  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.media.removeEventListener('emptied', this.handleEmptied);
    this.media.removeEventListener('seeked', this.handleSeeked);
    this.media.removeEventListener('play', this.handlePlay);
    this.media.removeEventListener('pause', this.handlePause);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.disconnectNodes();
    delete (this.media.dataset as Record<string, string | undefined>)[DATASET_FLAG];
  }
}
