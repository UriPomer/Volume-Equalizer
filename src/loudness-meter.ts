import { channelWeight, KWeighting } from './k-weighting';

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

export class LoudnessMeter {
  private readonly samplesPerBlock: number;
  private readonly stepSamples: number;
  private readonly shortTermSamples: number;
  private readonly maxBlocks: number;
  private filters: KWeighting[] = [];
  private buffers: Float64Array[] = [];
  private shortTermBuffers: Float64Array[] = [];
  private blocks: number[] = [];
  private bufferIndex = 0;
  private processedFrames = 0;
  private momentaryEnergy = NaN;
  private channelCount = 0;
  private shortTermIndex = 0;
  private shortTermFrameCount = 0;
  private shortTermEnergy = 0;

  constructor(
    private readonly sampleRate = 48000,
    maxIntegrationSeconds = 600
  ) {
    this.samplesPerBlock = Math.ceil(BLOCK_SECONDS * sampleRate);
    this.stepSamples = Math.ceil(STEP_SECONDS * sampleRate);
    this.shortTermSamples = Math.ceil(3 * sampleRate);
    this.maxBlocks = Number.isFinite(maxIntegrationSeconds)
      ? Math.ceil(maxIntegrationSeconds / STEP_SECONDS)
      : Number.POSITIVE_INFINITY;
    this.replaceChannelLayout(1);
  }

  processBlock(data: Float32Array): void {
    this.processChannels([data]);
  }

  processChannels(channels: Float32Array[]): void {
    if (!channels.length) return;
    if (channels.length !== this.channelCount) this.replaceChannelLayout(channels.length);
    const frames = Math.max(...channels.map((channel) => channel.length));
    this.processedFrames += frames;

    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const sample = this.filters[channel].process(channels[channel][frame] ?? 0);
        this.buffers[channel][this.bufferIndex] = sample;
        this.addShortTermSample(channel, sample, channels.length);
      }
      this.bufferIndex++;
      this.advanceShortTermWindow();
      if (this.bufferIndex === this.samplesPerBlock) this.commitBlock(channels.length);
    }
  }

  getIntegratedLoudness(): number {
    if (!this.blocks.length) return NaN;
    const ungatedMean = average(this.blocks);
    const relativeGate = toLufs(ungatedMean) + RELATIVE_GATE_LU;
    const gated = this.blocks.filter((energy) => toLufs(energy) >= relativeGate);
    return gated.length ? toLufs(average(gated)) : NaN;
  }

  getMomentaryLoudness(): number {
    return Number.isFinite(this.momentaryEnergy) ? toLufs(this.momentaryEnergy) : NaN;
  }

  getShortTermLoudness(): number {
    return this.shortTermFrameCount === this.shortTermSamples
      ? toLufs(this.shortTermEnergy / this.shortTermSamples)
      : NaN;
  }

  getIntegrationTime(): number {
    return this.processedFrames / this.sampleRate;
  }

  reset(): void {
    this.blocks = [];
    this.bufferIndex = 0;
    this.processedFrames = 0;
    this.momentaryEnergy = NaN;
    this.shortTermIndex = 0;
    this.shortTermFrameCount = 0;
    this.shortTermEnergy = 0;
    this.buffers.forEach((buffer) => buffer.fill(0));
    this.shortTermBuffers.forEach((buffer) => buffer.fill(0));
    this.filters.forEach((filter) => filter.reset());
  }

  private commitBlock(channelCount: number): void {
    const energy = this.weightedEnergy(channelCount, this.samplesPerBlock);
    this.momentaryEnergy = energy;
    if (toLufs(energy) >= ABSOLUTE_GATE_LUFS) {
      this.blocks.push(energy);
      if (this.blocks.length > this.maxBlocks) this.blocks.shift();
    }
    for (let channel = 0; channel < channelCount; channel++) {
      this.buffers[channel].copyWithin(0, this.stepSamples);
    }
    this.bufferIndex = this.samplesPerBlock - this.stepSamples;
  }

  private weightedEnergy(channelCount: number, length: number): number {
    let energy = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      let sum = 0;
      const buffer = this.buffers[channel];
      for (let frame = 0; frame < length; frame++) sum += buffer[frame] ** 2;
      energy += channelWeight(channel, channelCount) * sum / length;
    }
    return energy;
  }

  private addShortTermSample(channel: number, sample: number, channelCount: number): void {
    const buffer = this.shortTermBuffers[channel];
    const oldEnergy = buffer[this.shortTermIndex];
    const newEnergy = sample * sample;
    buffer[this.shortTermIndex] = newEnergy;
    this.shortTermEnergy += channelWeight(channel, channelCount) * (newEnergy - oldEnergy);
  }

  private advanceShortTermWindow(): void {
    if (this.shortTermFrameCount < this.shortTermSamples) this.shortTermFrameCount++;
    this.shortTermIndex = (this.shortTermIndex + 1) % this.shortTermSamples;
  }

  private replaceChannelLayout(count: number): void {
    this.channelCount = count;
    this.filters = Array.from({ length: count }, () => new KWeighting(this.sampleRate));
    this.buffers = Array.from({ length: count }, () => new Float64Array(this.samplesPerBlock));
    this.shortTermBuffers = Array.from({ length: count }, () => new Float64Array(this.shortTermSamples));
    this.blocks = [];
    this.bufferIndex = 0;
    this.processedFrames = 0;
    this.momentaryEnergy = NaN;
    this.shortTermIndex = 0;
    this.shortTermFrameCount = 0;
    this.shortTermEnergy = 0;
  }
}

export function calculateGainForLoudness(currentLufs: number, targetLufs: number): number {
  return Number.isFinite(currentLufs) && Number.isFinite(targetLufs)
    ? Math.pow(10, (targetLufs - currentLufs) / 20)
    : 1;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toLufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
}
