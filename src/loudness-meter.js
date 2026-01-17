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
export class LoudnessMeter {
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
export function calculateGainForLoudness(currentLufs, targetLufs) {
  if (!isFinite(currentLufs) || !isFinite(targetLufs)) {
    return 1.0;
  }
  
  const delta = targetLufs - currentLufs;
  return Math.pow(10, delta / 20);
}

/**
 * RMS 转 LUFS (近似，无 K-weighting)
 */
export function rmsToLufs(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS
 */
export function lufsToRms(lufs) {
  return Math.pow(10, (lufs + 0.691) / 20);
}
