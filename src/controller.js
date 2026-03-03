/**
 * MediaVolumeController - 媒体音量控制器
 * 负责音频信号链管理、响度测量和增益调整
 * 
 * 使用 ITU-R BS.1770-4 标准响度测量算法
 */

import { ensureAudioContext } from './audio-context.js';
import { PIDController } from './pid-controller.js';
import { clamp } from './lufs-calculator.js';
import { INTEGRATION_PARAMS, DATASET_FLAG, BRAND } from './config.js';
import { eventBus, EVENTS } from './events/index.js';
import { LoudnessMeter, calculateGainForLoudness, rmsToLufs } from './loudness-meter.js';


export class MediaVolumeController {
  constructor(media, settings, meterStateCallback) {
    this.media = media;
    this.settings = settings;
    this.meterStateCallback = meterStateCallback;
    this.rafId = 0;
    this.processingEnabled = null;

    // ITU-R BS.1770-4 标准响度测量器
    this.originalMeter = null;  // 原始响度 (增益前)
    this.outputMeter = null;    // 输出响度 (增益后)

    // tick 计时
    this.lastTickTime = performance.now();

    // PID 控制器
    this.pidController = new PIDController();

    // 初始化音频节点
    this.initAudioNodes();
    
    // 绑定事件监听器
    this.bindEventListeners();

    // 开始 tick 循环
    this.tick = this.tick.bind(this);
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * 初始化 Web Audio API 节点
   */
  initAudioNodes() {
    const ctx = ensureAudioContext();
    this.audioContext = ctx;
    
    this.sourceNode = ctx.createMediaElementSource(this.media);
    this.compressor = ctx.createDynamicsCompressor();
    this.gainNode = ctx.createGain();

    // 原始音频分析器 (测量压缩后/增益前的响度)
    this.originalAnalyser = ctx.createAnalyser();
    this.originalAnalyser.fftSize = 2048;
    this.originalBuffer = new Float32Array(this.originalAnalyser.fftSize);

    // 输出音频分析器 (测量最终输出)
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);

    // 低频滤波器 (可选的 EQ)
    this.bassFilter = ctx.createBiquadFilter();
    this.bassFilter.type = 'lowshelf';
    this.bassFilter.frequency.value = 200;
    this.bassFilter.gain.value = this.settings.bassBoost;

    // 初始化 ITU-R BS.1770-4 响度测量器
    this.originalMeter = new LoudnessMeter(ctx.sampleRate);
    this.outputMeter = new LoudnessMeter(ctx.sampleRate);

    this.applyCompressor();

    this.setProcessingEnabled(this.settings.enabled);
  }

  /**
   * 绑定媒体事件监听器
   */
  bindEventListeners() {
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
  applyCompressor() {
    this.compressor.threshold.value = this.settings.compressorThreshold;
    this.compressor.knee.value = this.settings.compressorKnee;
    this.compressor.ratio.value = this.settings.compressorRatio;
    this.compressor.attack.value = this.settings.compressorAttack;
    this.compressor.release.value = this.settings.compressorRelease;
  }

  setProcessingEnabled(enabled) {
    if (this.processingEnabled === enabled) return;
    this.processingEnabled = enabled;

    if (enabled) {
      this.connectProcessingChain();
    } else {
      this.connectBypassChain();
      this.gainNode.gain.value = 1.0;
    }
  }

  disconnectNodes() {
    this.sourceNode.disconnect();
    this.compressor.disconnect();
    this.originalAnalyser.disconnect();
    this.gainNode.disconnect();
    this.bassFilter.disconnect();
    this.analyser.disconnect();
  }

  connectProcessingChain() {
    this.disconnectNodes();
    // 信号链: source → compressor → originalAnalyser → gain → bassFilter → analyser → destination
    this.sourceNode.connect(this.compressor);
    this.compressor.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.gainNode);
    this.gainNode.connect(this.bassFilter);
    this.bassFilter.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  connectBypassChain() {
    this.disconnectNodes();
    // 直通链路: source → originalAnalyser → analyser → destination
    this.sourceNode.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  /**
   * 更新设置
   * @param {Object} newSettings - 新的设置对象
   */
  updateSettings(newSettings) {
    // 检查是否是目标响度变化（通过标记字段判断）
    const { _changedField, ...restSettings } = newSettings;
    const targetChanged = _changedField === 'targetLufs';
    const wasEnabled = this.settings.enabled;
    
    this.settings = restSettings;
    
    this.applyCompressor();
    this.bassFilter.gain.value = restSettings.bassBoost;
    if (wasEnabled !== restSettings.enabled) {
      this.setProcessingEnabled(restSettings.enabled);
    }

    // 只有目标响度改变时才重置输出响度积分
    if (targetChanged) {
      this.resetOutputIntegration();
    }
  }


  /**
   * 重置增益到 1.0 并清空积分历史
   */
  resetGain() {
    this.gainNode.gain.value = 1;
    this.resetIntegration();
  }

  /**
   * 重置积分历史和PID状态
   * 触发场景: 用户跳转视频
   */
  resetIntegration() {
    this.originalMeter.reset();
    this.outputMeter.reset();
    this.lastTickTime = performance.now();
    this.pidController.reset();
  }

  /**
   * 只重置输出响度的积分历史（保留原始响度）
   * 触发场景: 目标响度改变
   */
  resetOutputIntegration() {
    this.outputMeter.reset();
    this.lastTickTime = performance.now();
    this.pidController.reset();

    // 立即更新 meter 状态，触发 UI 刷新
    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();
    this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
  }


  /**
   * 测量输出 RMS
   * @returns {number} RMS 值
   */
  measureRms() {
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
   * @returns {number} RMS 值
   */
  measureOriginalRms() {
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
   * @param {Float32Array} originalBuffer - 原始音频数据
   * @param {Float32Array} outputBuffer - 输出音频数据
   */
  updateLoudnessMeasurement(originalBuffer, outputBuffer) {
    // 检查是否有有效音频 (静音检测)
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
    
    // 只在有声音时更新响度测量
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
  tick() {
    if (!document.contains(this.media)) {
      this.destroy();
      return;
    }

    const now = performance.now();
    const deltaSec = Math.max(0.001, (now - this.lastTickTime) / 1000);
    this.lastTickTime = now;

    // 获取原始和输出音频数据
    this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);
    this.analyser.getFloatTimeDomainData(this.buffer);

    // 计算瞬时 RMS (用于 UI 显示)
    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();

    // 更新 ITU-R BS.1770-4 响度测量
    this.updateLoudnessMeasurement(this.originalBuffer, this.buffer);

    if (this.settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
      // 获取积分响度 (LUFS)
      const originalLufs = this.originalMeter.getIntegratedLoudness();
      const outputLufs = this.outputMeter.getIntegratedLoudness();
      const integrationTime = this.originalMeter.getIntegrationTime();

      // 等待足够积分时长后再启用控制
      if (integrationTime >= INTEGRATION_PARAMS.minIntegrationSeconds && isFinite(originalLufs)) {
        
        // 目标响度 (从 RMS 转换为 LUFS)
        const targetLufs = rmsToLufs(this.settings.targetRms);
        
        // 计算理想增益 (基于 ITU-R BS.1770-4 积分响度)
        const idealGain = calculateGainForLoudness(originalLufs, targetLufs);

        // 调试输出
        if (Math.random() < 0.01) {  // 1% 概率输出，避免刷屏
          console.log(`${BRAND} ITU-R BS.1770-4 测量:`, {
            targetLufs: targetLufs.toFixed(1),
            originalLufs: originalLufs.toFixed(1),
            outputLufs: isFinite(outputLufs) ? outputLufs.toFixed(1) : 'N/A',
            idealGain: idealGain.toFixed(3),
            currentGain: this.gainNode.gain.value.toFixed(3),
            integrationTime: integrationTime.toFixed(1) + 's'
          });
        }

        // 误差 = 理想增益 - 当前增益
        const currentGain = this.gainNode.gain.value;
        const error = idealGain - currentGain;

        // PID 输出
        const correction = this.pidController.compute(error);

        // 应用增益调整（非对称限速：降快升慢，避免过冲）
        const rawNextGain = currentGain + correction;
        const baseRate = this.settings.gainChangePerSec * deltaSec;
        // 需要降低增益时速度快 3 倍，需要升高时正常速度
        const maxUp = baseRate;
        const maxDown = baseRate * 3;
        let slewLimitedGain;
        if (rawNextGain > currentGain) {
          slewLimitedGain = Math.min(rawNextGain, currentGain + maxUp);
        } else {
          slewLimitedGain = Math.max(rawNextGain, currentGain - maxDown);
        }
        const nextGain = clamp(
          slewLimitedGain,
          this.settings.minGain,
          this.settings.maxGain
        );
        this.gainNode.gain.value = nextGain;

        // 更新 meter 状态
        this.updateMeterState(currentRms, originalRms, nextGain, originalLufs, outputLufs);
      } else {
        // 样本不足，暂时不调整增益
        this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
      }
    } else if (!this.settings.enabled) {
      this.gainNode.gain.value = 1.0;
      // 关闭时仍显示原始响度
      this.updateMeterState(originalRms, originalRms, 1, null, null, true);
    } else {
      // 暂停/静音/结束时保持 meter 刷新
      this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
    }

    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * 更新 meter 状态（用于 UI 显示）
   * @param {number} currentRms - 当前 RMS
   * @param {number} originalRms - 原始 RMS
   * @param {number} gain - 当前增益
   * @param {number} originalLufs - 原始积分响度 (LUFS)
   * @param {number} outputLufs - 输出积分响度 (LUFS)
   * @param {boolean} disabled - 是否禁用状态
   */
  updateMeterState(currentRms, originalRms, gain, originalLufs = null, outputLufs = null, disabled = false) {
    if (this.meterStateCallback) {
      // 如果没有提供 LUFS 值，从 meter 获取
      if (originalLufs === null) {
        originalLufs = this.originalMeter.getIntegratedLoudness();
      }
      if (outputLufs === null) {
        outputLufs = this.outputMeter.getIntegratedLoudness();
      }
      
      // 转换 LUFS 到 RMS 用于 UI 兼容
      const integratedRms = isFinite(outputLufs) 
        ? Math.pow(10, (outputLufs + 0.691) / 20) 
        : currentRms;
      const originalIntegratedRms = isFinite(originalLufs)
        ? Math.pow(10, (originalLufs + 0.691) / 20)
        : originalRms;

      this.meterStateCallback({
        rms: disabled ? originalRms : currentRms,
        integratedRms: disabled ? originalIntegratedRms : integratedRms,
        originalRms: originalRms,
        originalIntegratedRms: originalIntegratedRms,
        gain: gain,
        sampleCount: Math.floor(this.originalMeter.getIntegrationTime() * 10),  // 近似块数
        // 新增: 直接传递 LUFS 值
        originalLufs: originalLufs,
        outputLufs: outputLufs,
        integrationTime: this.originalMeter.getIntegrationTime()
      });
    }
  }

  /**
   * 销毁控制器并清理资源
   */
  destroy() {
    cancelAnimationFrame(this.rafId);
    this.media.removeEventListener('emptied', this.handleEmptied);
    this.media.removeEventListener('seeked', this.handleSeeked);
    this.media.removeEventListener('play', this.handlePlay);
    this.media.removeEventListener('pause', this.handlePause);
    this.disconnectNodes();
    delete this.media.dataset[DATASET_FLAG];
  }
}
