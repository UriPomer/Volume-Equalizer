/**
 * ITU-R BS.1770-4 响度测量器
 * 基于 pyloudnorm 实现的 JavaScript 版本
 *
 * 核心特性:
 * - K-weighting 滤波器 (高架 + 高通)
 * - 双门限机制 (绝对门限 -70 LUFS + 相对门限 -10 LU)
 * - 400ms 分块 + 75% 重叠
 */

type FilterType = 'high_shelf' | 'high_pass';

interface ChannelFilterState {
  highShelf: IIRFilter;
  highPass: IIRFilter;
}

/**
 * Biquad IIR 滤波器
 * 用于 K-weighting 预加权
 */
class IIRFilter {
  private type: FilterType;
  private fc: number;
  private Q: number;
  private gain: number;
  private sampleRate: number;

  // 滤波器状态
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  // 滤波器系数
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  constructor(type: FilterType, fc: number, Q: number, gain: number, sampleRate: number) {
    this.type = type;
    this.fc = fc;
    this.Q = Q;
    this.gain = gain;
    this.sampleRate = sampleRate;
    this.calculateCoefficients();
  }

  /**
   * 计算 Biquad 滤波器系数
   * 基于 ITU-R BS.1770-4 标准的 DeMan 精确实现
   */
  private calculateCoefficients(): void {
    const K = Math.tan(Math.PI * this.fc / this.sampleRate);

    if (this.type === 'high_shelf') {
      const Vh = Math.pow(10.0, this.gain / 20.0);
      const Vb = Math.pow(Vh, 0.499666774155);
      const a0_ = 1.0 + K / this.Q + K * K;

      this.b0 = (Vh + Vb * K / this.Q + K * K) / a0_;
      this.b1 = 2.0 * (K * K - Vh) / a0_;
      this.b2 = (Vh - Vb * K / this.Q + K * K) / a0_;
      this.a1 = 2.0 * (K * K - 1.0) / a0_;
      this.a2 = (1.0 - K / this.Q + K * K) / a0_;
    } else if (this.type === 'high_pass') {
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
  processSample(x: number): number {
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
  processBlock(data: Float32Array): Float32Array {
    const output = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      output[i] = this.processSample(data[i]);
    }
    return output;
  }

  /**
   * 重置滤波器状态
   */
  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/**
 * ITU-R BS.1770-4 响度测量器
 */
export class LoudnessMeter {
  private sampleRate: number;

  // ITU-R BS.1770-4 标准参数
  private blockSize = 0.4;  // 400ms 门限块
  private overlap = 0.75;   // 75% 重叠
  private absoluteThreshold = -70;  // 绝对门限 LUFS
  private relativeThreshold = -10;  // 相对门限 LU (低于平均 10 LU)

  // K-weighting 滤波器（每个声道独立状态）
  private channelFilters: ChannelFilterState[];

  // 实时积分状态
  private blocks: number[] = [];
  private blockLoudness: number[] = [];
  private blockBuffers: Float32Array[];
  private blockBufferIndex = 0;
  private samplesPerBlock: number;
  private stepSamples: number;
  private samplesSinceLastBlock = 0;

  // 最大保留的块数 (约 600 秒 = 10 分钟)
  private maxBlocks: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;

    this.channelFilters = [this.createChannelFilters(sampleRate)];

    this.samplesPerBlock = Math.ceil(this.blockSize * sampleRate);
    this.stepSamples = Math.ceil(this.samplesPerBlock * (1 - this.overlap));
    this.blockBuffers = [new Float32Array(this.samplesPerBlock)];
    // 无限积分：维护近 600 秒的 block（用于长视频的稳定测量）
    this.maxBlocks = Math.ceil(600 / (this.blockSize * (1 - this.overlap)));
  }

  /**
   * 应用 K-weighting 滤波
   */
  private applyKWeighting(sample: number, channel: number): number {
    const filters = this.channelFilters[channel];
    let filtered = filters.highShelf.processSample(sample);
    filtered = filters.highPass.processSample(filtered);
    return filtered;
  }

  /**
   * 实时处理音频块
   */
  processBlock(data: Float32Array): void {
    this.processChannels([data]);
  }

  /**
   * 实时处理多声道音频块。Web 内容通常是 mono/stereo；L/R 以 BS.1770 常规权重 1.0 求和。
   */
  processChannels(channels: Float32Array[]): void {
    const channelCount = Math.max(1, channels.length);
    this.ensureChannelCount(channelCount);

    const frameCount = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
    for (let i = 0; i < frameCount; i++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const sample = channels[channel]?.[i] ?? 0;
        this.blockBuffers[channel][this.blockBufferIndex] = this.applyKWeighting(sample, channel);
      }

      this.blockBufferIndex++;
      this.samplesSinceLastBlock++;

      if (this.blockBufferIndex >= this.samplesPerBlock) {
        const meanSquare = this.calculateWeightedMeanSquare(this.blockBuffers, this.samplesPerBlock);
        const blockLufs = -0.691 + 10 * Math.log10(meanSquare);

        if (blockLufs >= this.absoluteThreshold) {
          this.blocks.push(meanSquare);
          this.blockLoudness.push(blockLufs);

          if (this.blocks.length > this.maxBlocks) {
            this.blocks.shift();
            this.blockLoudness.shift();
          }
        }

        if (this.samplesSinceLastBlock >= this.stepSamples) {
          for (let channel = 0; channel < this.blockBuffers.length; channel++) {
            this.blockBuffers[channel].copyWithin(0, this.stepSamples);
          }
          this.blockBufferIndex = this.samplesPerBlock - this.stepSamples;
          this.samplesSinceLastBlock = 0;
        }
      }
    }
  }

  /**
   * 计算均方值
   */
  private calculateMeanSquare(buffer: Float32Array, length = buffer.length): number {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return sum / length;
  }

  private calculateWeightedMeanSquare(buffers: Float32Array[], length: number): number {
    let sum = 0;
    for (let channel = 0; channel < buffers.length; channel++) {
      sum += this.channelWeight(channel) * this.calculateMeanSquare(buffers[channel], length);
    }
    return sum;
  }

  private channelWeight(channel: number): number {
    // ITU-R BS.1770 uses +1.5 dB for surround channels and ignores LFE. Browser media here is stereo.
    return channel <= 1 ? 1 : Math.pow(10, 1.5 / 10);
  }

  /**
   * 计算积分响度 (ITU-R BS.1770-4 双门限算法)
   */
  getIntegratedLoudness(): number {
    if (this.blocks.length === 0) {
      return NaN;
    }

    const avgMeanSquare = this.blocks.reduce((a, b) => a + b, 0) / this.blocks.length;
    const avgLoudness = -0.691 + 10 * Math.log10(avgMeanSquare);

    const relativeThresholdLufs = avgLoudness + this.relativeThreshold;

    let gatedSum = 0;
    let gatedCount = 0;

    for (let i = 0; i < this.blocks.length; i++) {
      const blockLufs = this.blockLoudness[i];
      if (blockLufs >= this.absoluteThreshold && blockLufs >= relativeThresholdLufs) {
        gatedSum += this.blocks[i];
        gatedCount++;
      }
    }

    if (gatedCount === 0) {
      return NaN;
    }

    const gatedMeanSquare = gatedSum / gatedCount;
    return -0.691 + 10 * Math.log10(gatedMeanSquare);
  }

  /**
   * 获取瞬时响度 (400ms 窗口，无门限)
   */
  getMomentaryLoudness(): number {
    if (this.blockBufferIndex < this.samplesPerBlock * 0.5) {
      return NaN;
    }

    let sum = 0;
    for (let channel = 0; channel < this.blockBuffers.length; channel++) {
      sum += this.channelWeight(channel) * this.calculateMeanSquare(this.blockBuffers[channel], this.blockBufferIndex);
    }
    const meanSquare = sum;

    if (meanSquare <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(meanSquare);
  }

  /**
   * 获取短时响度 (3秒窗口)
   */
  getShortTermLoudness(): number {
    const blocksFor3s = Math.ceil(3 / (this.blockSize * (1 - this.overlap)));

    if (this.blocks.length < blocksFor3s) {
      return this.getIntegratedLoudness();
    }

    const recentBlocks = this.blocks.slice(-blocksFor3s);
    const avgMeanSquare = recentBlocks.reduce((a, b) => a + b, 0) / recentBlocks.length;

    if (avgMeanSquare <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(avgMeanSquare);
  }

  /**
   * 获取积分时长 (秒)
   */
  getIntegrationTime(): number {
    return this.blocks.length * this.blockSize * (1 - this.overlap);
  }

  /**
   * 重置测量器
   */
  reset(): void {
    this.blocks = [];
    this.blockLoudness = [];
    this.blockBuffers.forEach((buffer) => buffer.fill(0));
    this.blockBufferIndex = 0;
    this.samplesSinceLastBlock = 0;
    this.channelFilters.forEach((filters) => {
      filters.highShelf.reset();
      filters.highPass.reset();
    });
  }

  /**
   * 更新采样率
   */
  setSampleRate(sampleRate: number): void {
    if (this.sampleRate !== sampleRate) {
      this.sampleRate = sampleRate;

      this.channelFilters = this.channelFilters.map(() => this.createChannelFilters(sampleRate));

      this.samplesPerBlock = Math.ceil(this.blockSize * sampleRate);
      this.stepSamples = Math.ceil(this.samplesPerBlock * (1 - this.overlap));
      this.blockBuffers = this.blockBuffers.map(() => new Float32Array(this.samplesPerBlock));

      this.reset();
    }
  }

  private createChannelFilters(sampleRate: number): ChannelFilterState {
    return {
      highShelf: new IIRFilter(
        'high_shelf', 1681.9744509555319, 0.7071752369554193, 3.99984385397, sampleRate
      ),
      highPass: new IIRFilter(
        'high_pass', 38.13547087613982, 0.5003270373253953, 0, sampleRate
      )
    };
  }

  private ensureChannelCount(channelCount: number): void {
    while (this.channelFilters.length < channelCount) {
      this.channelFilters.push(this.createChannelFilters(this.sampleRate));
      this.blockBuffers.push(new Float32Array(this.samplesPerBlock));
    }
  }
}

/**
 * 响度归一化工具
 */
export function calculateGainForLoudness(currentLufs: number, targetLufs: number): number {
  if (!isFinite(currentLufs) || !isFinite(targetLufs)) {
    return 1.0;
  }

  const delta = targetLufs - currentLufs;
  return Math.pow(10, delta / 20);
}

/**
 * RMS 转 LUFS (近似，无 K-weighting)
 */
export function rmsToLufs(rms: number): number {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS
 */
export function lufsToRms(lufs: number): number {
  return Math.pow(10, (lufs + 0.691) / 20);
}
