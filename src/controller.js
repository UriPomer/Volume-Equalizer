/**
 * MediaVolumeController - 媒体音量控制器
 * 负责音频信号链管理、响度测量和增益调整
 */

import { ensureAudioContext } from './audio-context.js';
import { PIDController } from './pid-controller.js';
import { clamp } from './lufs-calculator.js';
import { INTEGRATION_PARAMS, DATASET_FLAG, BRAND } from './config.js';

export class MediaVolumeController {
  constructor(media, settings, meterStateCallback) {
    this.media = media;
    this.settings = settings;
    this.meterStateCallback = meterStateCallback;
    this.rafId = 0;

    // 积分响度计算
    this.rmsHistory = [];
    this.originalRmsHistory = [];
    this.maxHistorySize = INTEGRATION_PARAMS.maxHistorySize;
    this.integratedRms = null;
    this.originalIntegratedRms = null;

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

    this.applyCompressor();

    // 信号链: source → compressor → originalAnalyser → gain → bassFilter → analyser → destination
    this.sourceNode.connect(this.compressor);
    this.compressor.connect(this.originalAnalyser);
    this.originalAnalyser.connect(this.gainNode);
    this.gainNode.connect(this.bassFilter);
    this.bassFilter.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /**
   * 绑定媒体事件监听器
   */
  bindEventListeners() {
    this.handleEmptied = () => this.resetGain();
    this.handleSeeked = () => this.resetIntegration();
    
    this.media.addEventListener('emptied', this.handleEmptied);
    this.media.addEventListener('seeked', this.handleSeeked);
    this.media.addEventListener('play', () => {
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
    });
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

  /**
   * 更新设置
   * @param {Object} newSettings - 新的设置对象
   */
  updateSettings(newSettings) {
    const targetChanged = this.settings.targetRms !== newSettings.targetRms;

    this.settings = newSettings;
    this.applyCompressor();
    this.bassFilter.gain.value = newSettings.bassBoost;

    // 如果目标响度改变,重置积分历史和PID状态
    if (targetChanged) {
      this.resetIntegration();
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
   * 触发场景: 1)用户跳转视频 2)目标响度改变
   */
  resetIntegration() {
    this.rmsHistory = [];
    this.originalRmsHistory = [];
    this.integratedRms = null;
    this.originalIntegratedRms = null;
    this.pidController.reset();
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
   * 更新积分 RMS (滑动窗口能量平均)
   * @param {number} currentRms - 当前输出 RMS
   * @param {number} originalRms - 当前原始 RMS
   */
  updateIntegratedRms(currentRms, originalRms) {
    // 过滤静音片段 (低于 -60dB)
    if (currentRms > INTEGRATION_PARAMS.silenceThreshold) {
      this.rmsHistory.push(currentRms);
      if (this.rmsHistory.length > this.maxHistorySize) {
        this.rmsHistory.shift();
      }
    }

    if (originalRms > INTEGRATION_PARAMS.silenceThreshold) {
      this.originalRmsHistory.push(originalRms);
      if (this.originalRmsHistory.length > this.maxHistorySize) {
        this.originalRmsHistory.shift();
      }
    }

    // 计算积分 RMS (能量平均后开方)
    if (this.rmsHistory.length > 0) {
      const sumSquares = this.rmsHistory.reduce((acc, rms) => acc + rms * rms, 0);
      this.integratedRms = Math.sqrt(sumSquares / this.rmsHistory.length);
    }

    if (this.originalRmsHistory.length > 0) {
      const sumSquares = this.originalRmsHistory.reduce((acc, rms) => acc + rms * rms, 0);
      this.originalIntegratedRms = Math.sqrt(sumSquares / this.originalRmsHistory.length);
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

    // 始终测量原始和输出响度
    const currentRms = this.measureRms();
    const originalRms = this.measureOriginalRms();

    // 更新积分 RMS
    this.updateIntegratedRms(currentRms, originalRms);

    if (this.settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
      // 等待足够样本后再启用 PID 控制
      if (this.originalRmsHistory.length >= INTEGRATION_PARAMS.minSamples && 
          this.originalIntegratedRms > INTEGRATION_PARAMS.silenceThreshold) {
        
        // 基于原始积分响度计算所需增益
        const targetRms = this.settings.targetRms;
        const currentOriginalRms = this.originalIntegratedRms;

        // 计算理想增益 (不考虑限制)
        const idealGain = targetRms / currentOriginalRms;

        // 当前增益
        const currentGain = this.gainNode.gain.value;

        // 误差 = 理想增益 - 当前增益
        const error = idealGain - currentGain;

        // PID 输出
        const correction = this.pidController.compute(error);

        // 应用增益调整
        const nextGain = clamp(
          currentGain + correction,
          this.settings.minGain,
          this.settings.maxGain
        );
        this.gainNode.gain.value = nextGain;

        // 更新 meter 状态
        this.updateMeterState(currentRms, originalRms, nextGain);
      } else {
        // 样本不足，暂时不调整增益
        this.updateMeterState(currentRms, originalRms, this.gainNode.gain.value);
      }
    } else if (!this.settings.enabled) {
      this.gainNode.gain.value = 1.0;
      // 关闭时仍显示原始响度
      this.updateMeterState(originalRms, originalRms, 1, true);
    }

    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * 更新 meter 状态（用于 UI 显示）
   * @param {number} currentRms - 当前 RMS
   * @param {number} originalRms - 原始 RMS
   * @param {number} gain - 当前增益
   * @param {boolean} disabled - 是否禁用状态
   */
  updateMeterState(currentRms, originalRms, gain, disabled = false) {
    if (this.meterStateCallback) {
      this.meterStateCallback({
        rms: disabled ? originalRms : currentRms,
        integratedRms: disabled 
          ? (this.originalIntegratedRms || originalRms)
          : (this.integratedRms || currentRms),
        originalRms: originalRms,
        originalIntegratedRms: this.originalIntegratedRms || originalRms,
        gain: gain,
        sampleCount: disabled ? this.originalRmsHistory.length : this.rmsHistory.length
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
    this.sourceNode.disconnect();
    this.originalAnalyser.disconnect();
    this.compressor.disconnect();
    this.gainNode.disconnect();
    this.bassFilter.disconnect();
    this.analyser.disconnect();
    delete this.media.dataset[DATASET_FLAG];
  }
}
