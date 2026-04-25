/**
 * MediaVolumeController - 媒体音量控制器
 * 负责音频信号链管理、响度测量和增益调整
 *
 * 使用 ITU-R BS.1770-4 标准响度测量算法
 */

import { ensureAudioContext } from './audio-context';
import { PIDController } from './pid-controller';
import { clamp } from './lufs-calculator';
import { INTEGRATION_PARAMS, DATASET_FLAG, BRAND, Settings } from './config';
import { eventBus, EVENTS } from './events/index';
import { LoudnessMeter, calculateGainForLoudness, rmsToLufs } from './loudness-meter';

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

export class MediaVolumeController {
  private media: HTMLMediaElement;
  private settings: Settings;
  private meterStateCallback: MeterStateCallback;
  private rafId = 0;
  private processingEnabled: boolean | null = null;

  // ITU-R BS.1770-4 标准响度测量器
  private originalMeter: LoudnessMeter;
  private outputMeter: LoudnessMeter;

  // tick 计时
  private lastTickTime: number;

  // PID 控制器
  private pidController: PIDController;

  // Web Audio 节点
  private audioContext!: AudioContext;
  private sourceNode!: MediaElementAudioSourceNode;
  private compressor!: DynamicsCompressorNode;
  gainNode!: GainNode;
  private originalAnalyser!: AnalyserNode;
  private originalBuffer!: Float32Array;
  private analyser!: AnalyserNode;
  private buffer!: Float32Array;
  private bassFilter!: BiquadFilterNode;

  // 事件处理器引用（用于移除）
  private handleEmptied!: () => void;
  private handleSeeked!: () => void;
  private handlePlay!: () => void;
  private handlePause!: () => void;

  constructor(media: HTMLMediaElement, settings: Settings, meterStateCallback: MeterStateCallback) {
    this.media = media;
    this.settings = settings;
    this.meterStateCallback = meterStateCallback;

    this.originalMeter = new LoudnessMeter(48000);
    this.outputMeter = new LoudnessMeter(48000);
    this.lastTickTime = performance.now();
    this.pidController = new PIDController();

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

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);

    this.bassFilter = ctx.createBiquadFilter();
    this.bassFilter.type = 'lowshelf';
    this.bassFilter.frequency.value = 200;
    this.bassFilter.gain.value = this.settings.bassBoost;

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
            console.debug(`${BRAND} AudioContext play resume failed:`, err);
          });
        }
      } catch (err) {
        console.debug(`${BRAND} Play event handler error:`, err);
      }
    };

    this.handlePause = () => {
      eventBus.emit(EVENTS.MEDIA_PAUSE, { media: this.media });
    };

    this.media.addEventListener('emptied', this.handleEmptied);
    this.media.addEventListener('seeked', this.handleSeeked);
    this.media.addEventListener('play', this.handlePlay);
    this.media.addEventListener('pause', this.handlePause);
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
    this.sourceNode.disconnect();
    this.compressor.disconnect();
    this.originalAnalyser.disconnect();
    this.gainNode.disconnect();
    this.bassFilter.disconnect();
    this.analyser.disconnect();
  }

  private connectProcessingChain(): void {
    this.disconnectNodes();
    this.sourceNode.connect(this.compressor);
    this.compressor.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.gainNode);
    this.gainNode.connect(this.bassFilter);
    this.bassFilter.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  private connectBypassChain(): void {
    this.disconnectNodes();
    this.sourceNode.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
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
    this.gainNode.gain.value = 1;
    this.resetIntegration();
  }

  /**
   * 重置积分历史和PID状态
   */
  private resetIntegration(): void {
    this.originalMeter.reset();
    this.outputMeter.reset();
    this.lastTickTime = performance.now();
    this.pidController.reset();
  }

  /**
   * 只重置输出响度的积分历史
   */
  private resetOutputIntegration(): void {
    this.outputMeter.reset();
    this.lastTickTime = performance.now();
    this.pidController.reset();

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
   * 测量原始 RMS (压缩后/增益前)
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

  /**
   * 更新 ITU-R BS.1770-4 响度测量
   */
  private updateLoudnessMeasurement(originalBuffer: Float32Array, outputBuffer: Float32Array): void {
    const silenceThreshold = INTEGRATION_PARAMS.silenceThreshold;

    let hasOriginalAudio = false;
    let hasOutputAudio = false;

    for (let i = 0; i < originalBuffer.length; i++) {
      if (Math.abs(originalBuffer[i]) > silenceThreshold) {
        hasOriginalAudio = true;
        break;
      }
    }

    for (let i = 0; i < outputBuffer.length; i++) {
      if (Math.abs(outputBuffer[i]) > silenceThreshold) {
        hasOutputAudio = true;
        break;
      }
    }

    if (hasOriginalAudio) {
      this.originalMeter.processBlock(originalBuffer);
    }
    if (hasOutputAudio) {
      this.outputMeter.processBlock(outputBuffer);
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

    const now = performance.now();
    const deltaSec = Math.max(0.001, (now - this.lastTickTime) / 1000);
    this.lastTickTime = now;

    this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);
    this.analyser.getFloatTimeDomainData(this.buffer);

    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();

    this.updateLoudnessMeasurement(this.originalBuffer, this.buffer);

    if (this.settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
      const originalLufs = this.originalMeter.getIntegratedLoudness();
      const outputLufs = this.outputMeter.getIntegratedLoudness();
      const integrationTime = this.originalMeter.getIntegrationTime();
      const momentaryLufs = this.originalMeter.getMomentaryLoudness();

      const hasIntegratedLoudness = integrationTime >= INTEGRATION_PARAMS.minIntegrationSeconds && isFinite(originalLufs);
      const hasMomentaryLoudness = isFinite(momentaryLufs);

      if (hasIntegratedLoudness || hasMomentaryLoudness) {
        const targetLufs = rmsToLufs(this.settings.targetRms);
        const currentLufs = hasIntegratedLoudness ? originalLufs : momentaryLufs;
        const idealGain = calculateGainForLoudness(currentLufs, targetLufs);

        if (Math.random() < 0.01) {
          console.log(`${BRAND} ITU-R BS.1770-4 测量:`, {
            targetLufs: targetLufs.toFixed(1),
            originalLufs: hasIntegratedLoudness ? originalLufs.toFixed(1) : `${momentaryLufs.toFixed(1)}(M)`,
            outputLufs: isFinite(outputLufs) ? outputLufs.toFixed(1) : 'N/A',
            idealGain: idealGain.toFixed(3),
            currentGain: this.gainNode.gain.value.toFixed(3),
            integrationTime: integrationTime.toFixed(1) + 's',
            mode: hasIntegratedLoudness ? 'integrated' : 'cold-start'
          });
        }

        const currentGain = this.gainNode.gain.value;
        const error = idealGain - currentGain;
        const correction = this.pidController.compute(error);

        const rawNextGain = currentGain + correction;
        const baseRate = this.settings.gainChangePerSec * deltaSec;
        const coldStartMultiplier = hasIntegratedLoudness ? 1 : 5;
        const maxUp = baseRate * coldStartMultiplier;
        const maxDown = baseRate * 3 * coldStartMultiplier;
        let slewLimitedGain: number;
        if (rawNextGain > currentGain) {
          slewLimitedGain = Math.min(rawNextGain, currentGain + maxUp);
        } else {
          slewLimitedGain = Math.max(rawNextGain, currentGain - maxDown);
        }
        const nextGain = clamp(slewLimitedGain, this.settings.minGain, this.settings.maxGain);
        this.gainNode.gain.value = nextGain;

        const displayOriginalLufs = hasIntegratedLoudness ? originalLufs : momentaryLufs;
        const displayOutputLufs = hasIntegratedLoudness ? outputLufs : this.outputMeter.getMomentaryLoudness();
        this.updateMeterState(currentRms, originalRms, nextGain, displayOriginalLufs, displayOutputLufs);
      } else {
        this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
      }
    } else if (!this.settings.enabled) {
      this.gainNode.gain.value = 1.0;
      this.updateMeterState(originalRms, originalRms, 1, null, null, true);
    } else {
      this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
    }

    this.rafId = requestAnimationFrame(this.tick);
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
      sampleCount: Math.floor(this.originalMeter.getIntegrationTime() * 10),
      originalLufs,
      outputLufs,
      integrationTime: this.originalMeter.getIntegrationTime()
    });
  }

  /**
   * 销毁控制器并清理资源
   */
  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.media.removeEventListener('emptied', this.handleEmptied);
    this.media.removeEventListener('seeked', this.handleSeeked);
    this.media.removeEventListener('play', this.handlePlay);
    this.media.removeEventListener('pause', this.handlePause);
    this.disconnectNodes();
    delete (this.media.dataset as Record<string, string | undefined>)[DATASET_FLAG];
  }
}
