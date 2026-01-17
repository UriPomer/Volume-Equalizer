(() => {
  "use strict";

  // ===== config.js =====
/**
 * 配置文件 - 常量和默认设置
 */

  const BRAND = '[Universal Volume EQ]';
  const PANEL_ID = 'universal-volume-eq-panel';
  const DATASET_FLAG = 'universalVolumeEqAttached';
  const TARGET_SELECTOR = 'video, audio';

  const DEFAULT_SETTINGS = {
  enabled: true,
  targetRms: 0.1924,  // 对应 -15 LUFS (YouTube标准, 实际计算: 10^((-15+0.691)/20))
  minGain: 0.5,      // 最小增益 (避免过度压缩)
  maxGain: 2.0,      // 最大增益 (避免失真)
  compressorThreshold: -20,  // 压缩器阈值 (dB)
  compressorKnee: 20,        // 压缩器拐点柔和度
  compressorRatio: 3,        // 压缩比 (3:1)
  compressorAttack: 0.003,   // 压缩器启动时间 (秒)
  compressorRelease: 0.3,    // 压缩器释放时间 (秒)
  bassBoost: 0,              // 低频增益 (dB: -6 ~ +6)
  gainChangePerSec: 0.2      // 最大增益变化速度 (x/秒)，慢速调整保留动态
};


// PID 控制器参数
  const PID_PARAMS = {
  Kp: 0.15,  // 比例系数：响应速度
  Ki: 0.005, // 积分系数：消除稳态误差
  Kd: 0.08,  // 微分系数：抑制震荡
  integralLimit: 5  // 积分抗饱和限制
};

// 积分响度参数 (ITU-R BS.1770-4 标准)
  const INTEGRATION_PARAMS = {
  // 标准算法使用 400ms 块 + 75% 重叠，由 LoudnessMeter 内部处理
  minIntegrationSeconds: 3,       // 启动控制前的最小积分时长（3秒 = ~30个块）
  silenceThreshold: 0.001         // 静音阈值 (低于此值不送入响度测量)
};





  // ===== events/event-bus.js =====
/**
 * 事件总线 - 统一管理模块间事件
 */

  class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(handler);
    return () => this.off(eventName, handler);
  }

  once(eventName, handler) {
    const off = this.on(eventName, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(eventName, handler) {
    const set = this.listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(eventName);
  }

  emit(eventName, payload) {
    const set = this.listeners.get(eventName);
    if (!set) return;
    [...set].forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        // 防止单个监听器影响其它监听
      }
    });
  }
}

  const eventBus = new EventBus();


  // ===== events/events.js =====
/**
 * 事件定义 - 集中管理事件名称
 */

  const EVENTS = {
  SETTINGS_CHANGED: 'settings:changed',
  MEDIA_PLAY: 'media:play',
  MEDIA_PAUSE: 'media:pause',
  MEDIA_SEEKED: 'media:seeked',
  MEDIA_EMPTIED: 'media:emptied'
};


  // ===== lufs-calculator.js =====
/**
 * LUFS/RMS 转换工具
 */

/**
 * RMS 转 LUFS 近似计算 (用于显示)
 * @param {number} rms - RMS 值
 * @returns {number} LUFS 值
 */
  function rmsToLufs(rms) {
  if (rms <= 0.00001) return -70;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS (用于设置目标值)
 * @param {number} lufs - LUFS 值
 * @returns {number} RMS 值
 */
  function lufsToRms(lufs) {
  return Math.pow(10, (lufs + 0.691) / 20);
}

/**
 * 限制值在指定范围内
 * @param {number} value - 要限制的值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 限制后的值
 */
  function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


  // ===== loudness-meter.js =====
/**
 * ITU-R BS.1770-4 响度测量器
 * 基于 pyloudnorm 实现的 JavaScript 版本
 * 
 * 核心特性:
 * - K-weighting 滤波器 (高架 + 高通)
 * - 双门限机制 (绝对门限 -70 LUFS + 相对门限 -10 LU)
 * - 400ms 分块 + 75% 重叠
 */

/**
 * Biquad IIR 滤波器
 * 用于 K-weighting 预加权
 */
class IIRFilter {
  constructor(type, fc, Q, gain, sampleRate) {
    this.type = type;
    this.fc = fc;
    this.Q = Q;
    this.gain = gain;
    this.sampleRate = sampleRate;
    
    // 滤波器状态 (用于实时处理)
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    
    // 计算滤波器系数
    this.calculateCoefficients();
  }

  /**
   * 计算 Biquad 滤波器系数
   * 基于 ITU-R BS.1770-4 标准的 DeMan 精确实现
   */
  calculateCoefficients() {
    const K = Math.tan(Math.PI * this.fc / this.sampleRate);
    
    if (this.type === 'high_shelf') {
      // DeMan 精确高架滤波器 (符合 ITU 规范)
      // 参数: G=3.999843854 dB, Q=0.7071752369, fc=1681.97 Hz
      const Vh = Math.pow(10.0, this.gain / 20.0);
      const Vb = Math.pow(Vh, 0.499666774155);
      const a0_ = 1.0 + K / this.Q + K * K;
      
      this.b0 = (Vh + Vb * K / this.Q + K * K) / a0_;
      this.b1 = 2.0 * (K * K - Vh) / a0_;
      this.b2 = (Vh - Vb * K / this.Q + K * K) / a0_;
      this.a1 = 2.0 * (K * K - 1.0) / a0_;
      this.a2 = (1.0 - K / this.Q + K * K) / a0_;
    } else if (this.type === 'high_pass') {
      // DeMan 精确高通滤波器
      // 参数: Q=0.5003270373, fc=38.1355 Hz
      const a0_ = 1.0 + K / this.Q + K * K;
      
      this.b0 = 1.0 / a0_;
      this.b1 = -2.0 / a0_;
      this.b2 = 1.0 / a0_;
      this.a1 = 2.0 * (K * K - 1.0) / a0_;
      this.a2 = (1.0 - K / this.Q + K * K) / a0_;
    }
  }

  /**
   * 处理单个样本 (实时)
   */
  processSample(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
    
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    
    return y;
  }

  /**
   * 处理音频块
   */
  processBlock(data) {
    const output = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      output[i] = this.processSample(data[i]);
    }
    return output;
  }

  /**
   * 重置滤波器状态
   */
  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/**
 * ITU-R BS.1770-4 响度测量器
 */
  class LoudnessMeter {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    
    // ITU-R BS.1770-4 标准参数
    this.blockSize = 0.4;  // 400ms 门限块
    this.overlap = 0.75;   // 75% 重叠
    this.absoluteThreshold = -70;  // 绝对门限 LUFS
    this.relativeThreshold = -10;  // 相对门限 LU (低于平均 10 LU)
    
    // K-weighting 滤波器 (DeMan 精确参数)
    this.highShelfFilter = new IIRFilter(
      'high_shelf',
      1681.9744509555319,  // fc
      0.7071752369554193,  // Q
      3.99984385397,       // gain dB
      sampleRate
    );
    this.highPassFilter = new IIRFilter(
      'high_pass',
      38.13547087613982,   // fc
      0.5003270373253953,  // Q
      0,                   // gain (高通无增益)
      sampleRate
    );
    
    // 实时积分状态
    this.blocks = [];  // 存储每个块的均方能量
    this.blockBuffer = new Float32Array(Math.ceil(this.blockSize * sampleRate));
    this.blockBufferIndex = 0;
    this.samplesPerBlock = Math.ceil(this.blockSize * sampleRate);
    this.stepSamples = Math.ceil(this.samplesPerBlock * (1 - this.overlap));
    this.samplesSinceLastBlock = 0;
    
    // 门限块响度 (用于相对门限计算)
    this.blockLoudness = [];
    
    // 最大保留的块数 (防止内存无限增长)
    // 保留约 60 秒的块数据
    this.maxBlocks = Math.ceil(60 / (this.blockSize * (1 - this.overlap)));
  }

  /**
   * 应用 K-weighting 滤波
   */
  applyKWeighting(sample) {
    // 先高架，再高通
    let filtered = this.highShelfFilter.processSample(sample);
    filtered = this.highPassFilter.processSample(filtered);
    return filtered;
  }

  /**
   * 实时处理音频块
   * @param {Float32Array} data - 原始音频数据
   */
  processBlock(data) {
    for (let i = 0; i < data.length; i++) {
      // K-weighting 滤波
      const filtered = this.applyKWeighting(data[i]);
      
      // 添加到块缓冲区
      this.blockBuffer[this.blockBufferIndex] = filtered;
      this.blockBufferIndex++;
      this.samplesSinceLastBlock++;
      
      // 检查是否完成一个块
      if (this.blockBufferIndex >= this.samplesPerBlock) {
        // 计算块的均方能量
        const meanSquare = this.calculateMeanSquare(this.blockBuffer);
        
        // 计算块响度 (LUFS)
        const blockLufs = -0.691 + 10 * Math.log10(meanSquare);
        
        // 只保留高于绝对门限的块
        if (blockLufs >= this.absoluteThreshold) {
          this.blocks.push(meanSquare);
          this.blockLoudness.push(blockLufs);
          
          // 限制块数量
          if (this.blocks.length > this.maxBlocks) {
            this.blocks.shift();
            this.blockLoudness.shift();
          }
        }
        
        // 滑动窗口：只移动 step 距离
        if (this.samplesSinceLastBlock >= this.stepSamples) {
          // 将缓冲区向前移动 stepSamples
          const overlap = this.samplesPerBlock - this.stepSamples;
          this.blockBuffer.copyWithin(0, this.stepSamples);
          this.blockBufferIndex = overlap;
          this.samplesSinceLastBlock = 0;
        }
      }
    }
  }

  /**
   * 计算均方值
   */
  calculateMeanSquare(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return sum / buffer.length;
  }

  /**
   * 计算积分响度 (ITU-R BS.1770-4 双门限算法)
   * @returns {number} LUFS 值，如果数据不足返回 NaN
   */
  getIntegratedLoudness() {
    if (this.blocks.length === 0) {
      return NaN;
    }

    // 第一步：已经通过绝对门限筛选的块
    // 计算这些块的平均响度用于相对门限
    const avgMeanSquare = this.blocks.reduce((a, b) => a + b, 0) / this.blocks.length;
    const avgLoudness = -0.691 + 10 * Math.log10(avgMeanSquare);
    
    // 第二步：计算相对门限 (平均响度 - 10 LU)
    const relativeThresholdLufs = avgLoudness + this.relativeThreshold;
    
    // 第三步：筛选同时高于绝对门限和相对门限的块
    let gatedSum = 0;
    let gatedCount = 0;
    
    for (let i = 0; i < this.blocks.length; i++) {
      const blockLufs = this.blockLoudness[i];
      // 块必须同时高于绝对门限和相对门限
      if (blockLufs >= this.absoluteThreshold && blockLufs >= relativeThresholdLufs) {
        gatedSum += this.blocks[i];
        gatedCount++;
      }
    }
    
    if (gatedCount === 0) {
      return NaN;
    }
    
    // 计算最终积分响度
    const gatedMeanSquare = gatedSum / gatedCount;
    const integratedLoudness = -0.691 + 10 * Math.log10(gatedMeanSquare);
    
    return integratedLoudness;
  }

  /**
   * 获取瞬时响度 (400ms 窗口，无门限)
   * @returns {number} LUFS 值
   */
  getMomentaryLoudness() {
    if (this.blockBufferIndex < this.samplesPerBlock * 0.5) {
      return NaN;
    }
    
    // 使用当前缓冲区计算瞬时响度
    let sum = 0;
    for (let i = 0; i < this.blockBufferIndex; i++) {
      sum += this.blockBuffer[i] * this.blockBuffer[i];
    }
    const meanSquare = sum / this.blockBufferIndex;
    
    if (meanSquare <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(meanSquare);
  }

  /**
   * 获取短时响度 (3秒窗口)
   * @returns {number} LUFS 值
   */
  getShortTermLoudness() {
    // 3秒需要的块数 (每个块 400ms，75% 重叠 = 100ms 步进)
    const blocksFor3s = Math.ceil(3 / (this.blockSize * (1 - this.overlap)));
    
    if (this.blocks.length < blocksFor3s) {
      return this.getIntegratedLoudness();  // 数据不足时返回积分响度
    }
    
    // 取最近 3 秒的块
    const recentBlocks = this.blocks.slice(-blocksFor3s);
    const avgMeanSquare = recentBlocks.reduce((a, b) => a + b, 0) / recentBlocks.length;
    
    if (avgMeanSquare <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(avgMeanSquare);
  }

  /**
   * 获取积分时长 (秒)
   */
  getIntegrationTime() {
    return this.blocks.length * this.blockSize * (1 - this.overlap);
  }

  /**
   * 重置测量器
   */
  reset() {
    this.blocks = [];
    this.blockLoudness = [];
    this.blockBuffer.fill(0);
    this.blockBufferIndex = 0;
    this.samplesSinceLastBlock = 0;
    this.highShelfFilter.reset();
    this.highPassFilter.reset();
  }

  /**
   * 更新采样率 (视频切换时调用)
   */
  setSampleRate(sampleRate) {
    if (this.sampleRate !== sampleRate) {
      this.sampleRate = sampleRate;
      
      // 重新创建滤波器
      this.highShelfFilter = new IIRFilter(
        'high_shelf', 1681.9744509555319, 0.7071752369554193, 3.99984385397, sampleRate
      );
      this.highPassFilter = new IIRFilter(
        'high_pass', 38.13547087613982, 0.5003270373253953, 0, sampleRate
      );
      
      // 重新计算缓冲区大小
      this.samplesPerBlock = Math.ceil(this.blockSize * sampleRate);
      this.stepSamples = Math.ceil(this.samplesPerBlock * (1 - this.overlap));
      this.blockBuffer = new Float32Array(this.samplesPerBlock);
      
      this.reset();
    }
  }
}

/**
 * 响度归一化工具
 */
  function calculateGainForLoudness(currentLufs, targetLufs) {
  if (!isFinite(currentLufs) || !isFinite(targetLufs)) {
    return 1.0;
  }
  
  const delta = targetLufs - currentLufs;
  return Math.pow(10, delta / 20);
}

/**
 * RMS 转 LUFS (近似，无 K-weighting)
 */
  function rmsToLufs(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS
 */
  function lufsToRms(lufs) {
  return Math.pow(10, (lufs + 0.691) / 20);
}


  // ===== settings.js =====
/**
 * 设置管理 - 加载和保存用户设置
 */


const storageSupported = typeof chrome !== 'undefined' && chrome?.storage?.local;

/**
 * 从 chrome.storage 加载设置
 * @returns {Promise<Object>} 设置对象
 */
  function loadSettings() {
  if (!storageSupported) {
    return Promise.resolve({ ...DEFAULT_SETTINGS });
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result || { ...DEFAULT_SETTINGS });
    });
  });
}

/**
 * 保存设置到 chrome.storage
 * @param {Object} settings - 要保存的设置
 */
  function persistSettings(settings) {
  if (!storageSupported) return;
  chrome.storage.local.set(settings);
}


  // ===== audio-context.js =====
/**
 * AudioContext 管理
 */


const AudioContextClass = window.AudioContext || window.webkitAudioContext;

if (!AudioContextClass) {
  console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
}

let audioCtx = null;

/**
 * 获取或创建全局 AudioContext
 * @returns {AudioContext} AudioContext 实例
 */
  function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

/**
 * 安装全局 AudioContext resume 处理器
 * 在用户交互时自动恢复 AudioContext
 */
  function installGlobalResumeHandlers() {
  const resume = () => {
    try {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch((err) => {
          console.debug(`${BRAND} AudioContext resume failed:`, err);
        });
      }
    } catch (err) {
      console.debug(`${BRAND} Resume handler error:`, err);
    }
  };
  
  ['pointerdown', 'keydown', 'click', 'touchstart'].forEach((evt) => {
    document.addEventListener(evt, resume, { capture: true, once: false, passive: true });
  });
  
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
}

/**
 * 检查浏览器是否支持 Web Audio API
 * @returns {boolean}
 */
  function isAudioContextSupported() {
  return !!AudioContextClass;
}


  // ===== pid-controller.js =====
/**
 * PID 控制器 - 用于平滑增益调整
 */



  class PIDController {
  constructor() {
    this.integral = 0;
    this.lastError = 0;
    this.Kp = PID_PARAMS.Kp;
    this.Ki = PID_PARAMS.Ki;
    this.Kd = PID_PARAMS.Kd;
    this.integralLimit = PID_PARAMS.integralLimit;
  }

  /**
   * 计算 PID 输出
   * @param {number} error - 当前误差 (目标值 - 当前值)
   * @returns {number} PID 输出（修正量）
   */
  compute(error) {
    // P 项：比例控制，快速响应
    const proportional = this.Kp * error;

    // I 项：积分控制，消除稳态误差（带抗饱和）
    this.integral += error;
    this.integral = clamp(this.integral, -this.integralLimit, this.integralLimit);
    const integral = this.Ki * this.integral;

    // D 项：微分控制，阻尼震荡
    const derivative = this.Kd * (error - this.lastError);
    this.lastError = error;

    // PID 输出
    return proportional + integral + derivative;
  }

  /**
   * 重置 PID 状态
   */
  reset() {
    this.integral = 0;
    this.lastError = 0;
  }
}


  // ===== controller.js =====
/**
 * MediaVolumeController - 媒体音量控制器
 * 负责音频信号链管理、响度测量和增益调整
 * 
 * 使用 ITU-R BS.1770-4 标准响度测量算法
 */







  class MediaVolumeController {
  constructor(media, settings, meterStateCallback) {
    this.media = media;
    this.settings = settings;
    this.meterStateCallback = meterStateCallback;
    this.rafId = 0;

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

  /**
   * 更新设置
   * @param {Object} newSettings - 新的设置对象
   */
  updateSettings(newSettings) {
    // 检查是否是目标响度变化（通过标记字段判断）
    const { _changedField, ...restSettings } = newSettings;
    const targetChanged = _changedField === 'targetLufs';
    
    this.settings = restSettings;
    
    this.applyCompressor();
    this.bassFilter.gain.value = restSettings.bassBoost;

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
    this.sourceNode.disconnect();
    this.originalAnalyser.disconnect();
    this.compressor.disconnect();
    this.gainNode.disconnect();
    this.bassFilter.disconnect();
    this.analyser.disconnect();
    delete this.media.dataset[DATASET_FLAG];
  }
}


  // ===== media-scanner.js =====
/**
 * 媒体扫描器 - 检测页面上的 video/audio 元素并附加控制器
 */


let scanScheduled = false;

/**
 * 扫描页面上的媒体元素
 * @param {Function} attachCallback - 附加控制器的回调函数
 * @param {Function} cleanupCallback - 清理不存在元素的回调函数
 */
  function scanForMedia(attachCallback, cleanupCallback) {
  document.querySelectorAll(TARGET_SELECTOR).forEach((media) => {
    tryAttachController(media, attachCallback);
  });

  if (cleanupCallback) {
    cleanupCallback();
  }
}

/**
 * 尝试为媒体元素附加控制器
 * @param {HTMLMediaElement} media - 媒体元素
 * @param {Function} attachCallback - 附加控制器的回调函数
 */
function tryAttachController(media, attachCallback) {
  if (!(media instanceof HTMLMediaElement)) return;
  if (media.dataset[DATASET_FLAG] === '1') return;
  
  try {
    attachCallback(media);
    media.dataset[DATASET_FLAG] = '1';
  } catch (error) {
    console.warn(`${BRAND} 无法绑定媒体元素`, error);
  }
}

/**
 * 调度扫描 (防抖)
 * @param {Function} scanCallback - 扫描回调函数
 */
  function scheduleScan(scanCallback) {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanCallback();
  });
}

/**
 * 观察 DOM 变化并自动扫描新的媒体元素
 * @param {Function} scanCallback - 扫描回调函数
 */
  function observeMutations(scanCallback) {
  const observer = new MutationObserver(() => scheduleScan(scanCallback));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}


  // ===== ui-panel.js =====
/**
 * UI 面板 - 创建和管理设置面板
 */




let panelHost = null;
let settingsChangedOff = null;


/**
 * 创建设置面板
 * @param {Object} settings - 当前设置
 * @param {Function} onSettingsChange - 设置改变回调
 * @param {Function} getMeterState - 获取 meter 状态的回调
 * @returns {HTMLElement} 面板元素
 */
  function createPanel(settings, onSettingsChange, getMeterState) {
  if (panelHost && document.contains(panelHost)) return panelHost;
  
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    panelHost = existing;
    return panelHost;
  }

  // 创建主容器
  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `;
  document.documentElement.appendChild(host);
  panelHost = host;

  // 创建 Shadow DOM
  const shadow = host.attachShadow({ mode: 'open' });
  
  // 添加样式
  const style = document.createElement('style');
  style.textContent = getPanelStyles();
  shadow.appendChild(style);

  // 创建面板内容
  const wrapper = document.createElement('div');
  wrapper.className = 'panel';
  wrapper.innerHTML = getPanelHTML(settings);
  shadow.appendChild(wrapper);

  // 绑定事件监听器
  bindPanelEvents(shadow, settings, onSettingsChange);

  // 启动 meter 更新循环
  startMeterUpdateLoop(shadow, getMeterState);

  return host;
}

/**
 * 确保面板存在
 * @param {Object} settings - 当前设置
 * @param {Function} onSettingsChange - 设置改变回调
 * @param {Function} getMeterState - 获取 meter 状态的回调
 * @returns {HTMLElement} 面板元素
 */
  function ensurePanel(settings, onSettingsChange, getMeterState) {
  if (panelHost && document.contains(panelHost)) {
    return panelHost;
  }
  panelHost = null;
  return createPanel(settings, onSettingsChange, getMeterState);
}

/**
 * 更新面板可见性
 * @param {number} controllerCount - 控制器数量
 */
  function updatePanelVisibility(controllerCount) {
  if (controllerCount === 0) {
    if (panelHost && document.contains(panelHost)) {
      panelHost.style.display = 'none';
    }
    return;
  }
  if (panelHost) {
    panelHost.style.display = 'block';
  }
}

/**
 * 获取面板样式
 * @returns {string} CSS 样式
 */
function getPanelStyles() {
  return `
    :host {
      all: initial;
    }
    .panel {
      min-width: 220px;
      background: rgba(15, 15, 15, 0.9);
      color: #f5f5f5;
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(8px);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    button.toggle {
      border: none;
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      color: #fff;
    }
    button.toggle.on {
      background: #00b2ff;
    }
    button.toggle.off {
      background: #555;
    }
    label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-top: 10px;
    }
    input[type='range'] {
      width: 100%;
    }
    .meter {
      margin-top: 10px;
      font-size: 12px;
      color: #c8c8c8;
    }
    .meter-section {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .meter-title {
      font-weight: 600;
      color: #fff;
      margin-bottom: 4px;
    }
  `;
}

/**
 * 获取面板 HTML
 * @param {Object} settings - 当前设置
 * @returns {string} HTML 字符串
 */
function getPanelHTML(settings) {
  return `
    <div class="header">
      <span>音量均衡</span>
      <button class="toggle">···</button>
    </div>
    <label>
      <span>目标响度 (LUFS)</span>
      <span data-field="targetLufs">${rmsToLufs(settings.targetRms).toFixed(1)}</span>
    </label>
    <input type="range" min="-23" max="-10" step="0.5" data-role="targetLufs" value="${rmsToLufs(settings.targetRms).toFixed(1)}">
    <label>
      <span>增益上限</span>
      <span data-field="maxGain">${settings.maxGain.toFixed(1)}x</span>
    </label>
    <input type="range" min="1" max="3" step="0.1" data-role="maxGain" value="${settings.maxGain}">
    <label>
      <span>增益下限</span>
      <span data-field="minGain">${settings.minGain.toFixed(1)}x</span>
    </label>
    <input type="range" min="0.2" max="1" step="0.05" data-role="minGain" value="${settings.minGain}">
    <label>
      <span>低频增益</span>
      <span data-field="bassBoost">${settings.bassBoost > 0 ? '+' : ''}${settings.bassBoost.toFixed(1)} dB</span>
    </label>
    <input type="range" min="-6" max="6" step="0.5" data-role="bassBoost" value="${settings.bassBoost}">
    <div class="meter">
      <div class="meter-title">原始响度</div>
      <div>积分: <span data-field="meterOriginalIntegratedLufs">-∞</span> LUFS <span style="color:#888;" data-field="sampleCount">(0样本)</span></div>
      <div>瞬时: <span data-field="meterOriginalLufs">-∞</span> LUFS</div>
      
      <div class="meter-section">
        <div class="meter-title">输出响度</div>
        <div>积分: <span data-field="meterIntegratedLufs">-∞</span> LUFS</div>
        <div>瞬时: <span data-field="meterLufs">-∞</span> LUFS</div>
        <div>增益: <span data-field="meterGain">1.00x</span></div>
      </div>
    </div>
  `;
}

/**
 * 绑定面板事件
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @param {Object} initialSettings - 初始设置（会被更新）
 * @param {Function} onSettingsChange - 设置改变回调，返回更新后的设置
 */
function bindPanelEvents(shadow, initialSettings, onSettingsChange) {
  const toggleBtn = shadow.querySelector('button.toggle');
  const sliders = shadow.querySelectorAll('input[type="range"]');
  const fieldNodes = getFieldNodes(shadow);
  const sliderMap = new Map([...sliders].map((slider) => [slider.dataset.role, slider]));
  
  // 使用可变引用来跟踪当前设置状态
  let currentSettings = initialSettings;

  // 渲染开关状态
  const renderToggle = () => {
    if (currentSettings.enabled) {
      toggleBtn.textContent = '已开启';
      toggleBtn.className = 'toggle on';
    } else {
      toggleBtn.textContent = '已关闭';
      toggleBtn.className = 'toggle off';
    }
  };

  const applySettingsToUI = (settings) => {
    const targetLufs = rmsToLufs(settings.targetRms);
    const targetSlider = sliderMap.get('targetLufs');
    if (targetSlider) targetSlider.value = targetLufs;
    updateFieldText(fieldNodes, 'targetLufs', targetLufs);

    const maxGainSlider = sliderMap.get('maxGain');
    if (maxGainSlider) maxGainSlider.value = settings.maxGain;
    updateFieldText(fieldNodes, 'maxGain', settings.maxGain);

    const minGainSlider = sliderMap.get('minGain');
    if (minGainSlider) minGainSlider.value = settings.minGain;
    updateFieldText(fieldNodes, 'minGain', settings.minGain);

    const bassBoostSlider = sliderMap.get('bassBoost');
    if (bassBoostSlider) bassBoostSlider.value = settings.bassBoost;
    updateFieldText(fieldNodes, 'bassBoost', settings.bassBoost);

    renderToggle();
  };

  applySettingsToUI(currentSettings);


  // 开关按钮
  toggleBtn.addEventListener('click', () => {
    const newSettings = { ...currentSettings, enabled: !currentSettings.enabled };
    currentSettings = onSettingsChange(newSettings) || newSettings;
    renderToggle();
  });

  // 滑块事件
  sliders.forEach((slider) => {
    slider.addEventListener('input', (event) => {
      const { role } = event.target.dataset;
      const value = parseFloat(event.target.value);
      if (Number.isNaN(value)) return;

      // 基于当前最新设置创建新对象
      const newSettings = { ...currentSettings };
      newSettings._changedField = role;  // 标记是哪个字段改变了
      
      // 如果是 LUFS 滑块，转换为 RMS 存储
      if (role === 'targetLufs') {
        newSettings.targetRms = lufsToRms(value);
      } else {
        newSettings[role] = value;
      }

      currentSettings = onSettingsChange(newSettings) || newSettings;
      updateFieldText(fieldNodes, role, value);
    });
  });

  if (settingsChangedOff) settingsChangedOff();
  settingsChangedOff = eventBus.on(EVENTS.SETTINGS_CHANGED, ({ settings: nextSettings }) => {
    if (!panelHost || !document.contains(panelHost)) return;
    currentSettings = nextSettings;
    applySettingsToUI(currentSettings);
  });
}



/**
 * 获取字段节点
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @returns {Object} 字段节点映射
 */
function getFieldNodes(shadow) {
  return {
    targetLufs: shadow.querySelector('[data-field="targetLufs"]'),
    maxGain: shadow.querySelector('[data-field="maxGain"]'),
    minGain: shadow.querySelector('[data-field="minGain"]'),
    bassBoost: shadow.querySelector('[data-field="bassBoost"]'),
    meterOriginalIntegratedLufs: shadow.querySelector('[data-field="meterOriginalIntegratedLufs"]'),
    meterOriginalLufs: shadow.querySelector('[data-field="meterOriginalLufs"]'),
    meterIntegratedLufs: shadow.querySelector('[data-field="meterIntegratedLufs"]'),
    meterLufs: shadow.querySelector('[data-field="meterLufs"]'),
    meterGain: shadow.querySelector('[data-field="meterGain"]'),
    sampleCount: shadow.querySelector('[data-field="sampleCount"]')
  };
}

/**
 * 更新字段文本
 * @param {Object} fieldNodes - 字段节点映射
 * @param {string} role - 字段角色
 * @param {number} value - 值
 */
function updateFieldText(fieldNodes, role, value) {
  if (role === 'targetLufs') fieldNodes.targetLufs.textContent = value.toFixed(1);
  if (role === 'maxGain') fieldNodes.maxGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'minGain') fieldNodes.minGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'bassBoost') fieldNodes.bassBoost.textContent = `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

/**
 * 启动 meter 更新循环
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @param {Function} getMeterState - 获取 meter 状态的回调
 */
function startMeterUpdateLoop(shadow, getMeterState) {
  const fieldNodes = getFieldNodes(shadow);

  setInterval(() => {
    if (!document.contains(panelHost)) return;
    
    const meterState = getMeterState();
    const { rms, integratedRms, originalRms, originalIntegratedRms, gain, sampleCount } = meterState;

    const instantLufs = rmsToLufs(rms);
    const integratedLufs = rmsToLufs(integratedRms || rms);
    const originalInstantLufs = rmsToLufs(originalRms);
    const originalIntegratedLufs = rmsToLufs(originalIntegratedRms || originalRms);

    fieldNodes.meterOriginalLufs.textContent = originalInstantLufs > -70 ? originalInstantLufs.toFixed(1) : '-∞';
    fieldNodes.meterOriginalIntegratedLufs.textContent = originalIntegratedLufs > -70 ? originalIntegratedLufs.toFixed(1) : '-∞';
    fieldNodes.meterLufs.textContent = instantLufs > -70 ? instantLufs.toFixed(1) : '-∞';
    fieldNodes.meterIntegratedLufs.textContent = integratedLufs > -70 ? integratedLufs.toFixed(1) : '-∞';
    fieldNodes.meterGain.textContent = `${gain.toFixed(2)}x`;
    fieldNodes.sampleCount.textContent = `(${sampleCount}样本)`;
  }, 100);
}


  // ===== main.js =====
/**
 * 主入口文件 - 协调各模块
 */








// 检查浏览器支持
if (!isAudioContextSupported()) {
  console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
  throw new Error('AudioContext not supported');
}

// 全局状态
let settings = { ...DEFAULT_SETTINGS };
let meterState = { rms: 0, gain: 1 };
const controllers = new Map();

// 初始化
console.debug(`${BRAND} 初始化: 在任意媒体元素上执行音量均衡`);
installGlobalResumeHandlers();

// 加载设置并启动
loadSettings()
  .then((loaded) => {
    settings = { ...DEFAULT_SETTINGS, ...loaded };
    startScanning();
  })
  .catch((err) => {
    console.error(`${BRAND} 设置加载失败`, err);
    startScanning();
  });

/**
 * 启动媒体元素扫描
 */
function startScanning() {
  const scanCallback = () => {
    scanForMedia(
      (media) => attachController(media),
      () => cleanupControllers()
    );
  };

  scanCallback();
  observeMutations(scanCallback);
}

/**
 * 为媒体元素附加控制器
 * @param {HTMLMediaElement} media - 媒体元素
 */
function attachController(media) {
  const controller = new MediaVolumeController(
    media,
    settings,
    (state) => {
      meterState = state;
    }
  );
  controllers.set(media, controller);
  updatePanelVisibility(controllers.size);
  ensurePanel(settings, handleSettingsChange, getMeterState);
}


/**
 * 清理已断开的控制器
 */
function cleanupControllers() {
  controllers.forEach((controller, media) => {
    if (!media.isConnected) {
      controller.destroy();
      controllers.delete(media);
    }
  });
  updatePanelVisibility(controllers.size);
}

/**
 * 设置改变处理
 * @param {Object} newSettings - 新的设置
 * @returns {Object} 更新后的设置
 */
function handleSettingsChange(newSettings) {
  const changedField = newSettings._changedField || null;
  const cleanedSettings = { ...newSettings };
  delete cleanedSettings._changedField;

  settings = cleanedSettings;
  persistSettings(settings);
  
  controllers.forEach((controller) => {
    controller.updateSettings({ ...settings, _changedField: changedField });
  });

  // 如果关闭功能，重置所有增益
  if (!settings.enabled) {
    controllers.forEach((controller) => {
      controller.gainNode.gain.value = 1.0;
    });
    meterState = {
      rms: 0,
      integratedRms: 0,
      originalRms: 0,
      originalIntegratedRms: 0,
      gain: 1,
      sampleCount: 0
    };
  }

  eventBus.emit(EVENTS.SETTINGS_CHANGED, { settings, changedField });
  
  return settings;
}


/**
 * 获取当前 meter 状态
 * @returns {Object} meter 状态
 */
function getMeterState() {
  return meterState;
}

// 创建 UI 面板（延迟创建，等待第一个媒体元素出现）
setTimeout(() => {
  if (controllers.size > 0) {
    ensurePanel(settings, handleSettingsChange, getMeterState);
  }
}, 1000);


})();
