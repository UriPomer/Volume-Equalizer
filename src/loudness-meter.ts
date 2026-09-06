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
  private readonly momentaryFrameEnergies: Float64Array;
  private readonly momentaryInvalidFrames: Uint8Array;
  private filters: KWeighting[] = [];
  private buffers: Float64Array[] = [];
  private shortTermBuffers: Float64Array[] = [];
  private shortTermInvalidFrames: Uint8Array;
  private blocks: number[] = [];
  private bufferIndex = 0;
  private processedFrames = 0;
  private channelCount = 0;
  private momentaryIndex = 0;
  private momentaryFrameCount = 0;
  private momentaryEnergySum = 0;
  private momentaryInvalidFrameCount = 0;
  private shortTermIndex = 0;
  private shortTermFrameCount = 0;
  private shortTermEnergy = 0;
  private shortTermInvalidFrameCount = 0;

  constructor(
    private readonly sampleRate = 48000,
    maxIntegrationSeconds = 600
  ) {
    this.samplesPerBlock = Math.ceil(BLOCK_SECONDS * sampleRate);
    this.stepSamples = Math.ceil(STEP_SECONDS * sampleRate);
    this.shortTermSamples = Math.ceil(3 * sampleRate);
    this.momentaryFrameEnergies = new Float64Array(this.samplesPerBlock);
    this.momentaryInvalidFrames = new Uint8Array(this.samplesPerBlock);
    this.shortTermInvalidFrames = new Uint8Array(this.shortTermSamples);
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
      let frameInvalid = false;
      let frameEnergy = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        // A non-finite sample would poison the recursive IIR state forever.
        // Treat it as a missing/silent sample at the measurement boundary.
        const input = channels[channel][frame] ?? 0;
        const valid = Number.isFinite(input);
        frameInvalid ||= !valid;
        const sample = this.filters[channel].process(valid ? input : 0);
        this.buffers[channel][this.bufferIndex] = sample;
        frameEnergy += channelWeight(channel, channels.length) * sample ** 2;
        this.addShortTermSample(channel, sample, channels.length);
      }
      this.addMomentarySample(frameEnergy, frameInvalid);
      this.addShortTermValidity(frameInvalid);
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
    return this.momentaryFrameCount === this.samplesPerBlock && this.momentaryInvalidFrameCount === 0
      ? toLufs(this.momentaryEnergySum / this.samplesPerBlock) : NaN;
  }

  getShortTermLoudness(): number {
    return this.shortTermFrameCount === this.shortTermSamples && this.shortTermInvalidFrameCount === 0
      ? toLufs(this.shortTermEnergy > 0 ? this.shortTermEnergy / this.shortTermSamples : 0)
      : NaN;
  }

  getIntegrationTime(): number {
    return this.processedFrames / this.sampleRate;
  }

  reset(): void {
    this.blocks = [];
    this.bufferIndex = 0;
    this.processedFrames = 0;
    this.momentaryIndex = this.momentaryFrameCount = this.momentaryInvalidFrameCount = 0;
    this.momentaryEnergySum = 0;
    this.shortTermIndex = 0;
    this.shortTermFrameCount = 0;
    this.shortTermEnergy = 0;
    this.shortTermInvalidFrameCount = 0;
    this.buffers.forEach((buffer) => buffer.fill(0));
    this.momentaryFrameEnergies.fill(0);
    this.momentaryInvalidFrames.fill(0);
    this.shortTermBuffers.forEach((buffer) => buffer.fill(0));
    this.shortTermInvalidFrames.fill(0);
    this.filters.forEach((filter) => filter.reset());
  }

  private commitBlock(channelCount: number): void {
    const energy = this.momentaryEnergySum / this.samplesPerBlock;
    const valid = this.momentaryInvalidFrameCount === 0;
    if (valid && toLufs(energy) >= ABSOLUTE_GATE_LUFS) {
      this.blocks.push(energy);
      if (this.blocks.length > this.maxBlocks) this.blocks.shift();
    }
    for (let channel = 0; channel < channelCount; channel++) {
      this.buffers[channel].copyWithin(0, this.stepSamples);
    }
    this.bufferIndex = this.samplesPerBlock - this.stepSamples;
  }

  private addShortTermSample(channel: number, sample: number, channelCount: number): void {
    const buffer = this.shortTermBuffers[channel];
    const oldEnergy = buffer[this.shortTermIndex];
    const newEnergy = sample * sample;
    buffer[this.shortTermIndex] = newEnergy;
    this.shortTermEnergy += channelWeight(channel, channelCount) * (newEnergy - oldEnergy);
  }

  private addShortTermValidity(invalid: boolean): void {
    const oldInvalid = this.shortTermInvalidFrames[this.shortTermIndex];
    const nextInvalid = invalid ? 1 : 0;
    this.shortTermInvalidFrames[this.shortTermIndex] = nextInvalid;
    this.shortTermInvalidFrameCount += nextInvalid - oldInvalid;
  }

  private addMomentarySample(energy: number, invalid: boolean): void {
    const oldEnergy = this.momentaryFrameEnergies[this.momentaryIndex];
    const oldInvalid = this.momentaryInvalidFrames[this.momentaryIndex];
    const nextInvalid = invalid ? 1 : 0;
    this.momentaryFrameEnergies[this.momentaryIndex] = energy;
    this.momentaryInvalidFrames[this.momentaryIndex] = nextInvalid;
    this.momentaryEnergySum += energy - oldEnergy;
    this.momentaryInvalidFrameCount += nextInvalid - oldInvalid;
    if (this.momentaryFrameCount < this.samplesPerBlock) this.momentaryFrameCount++;
    this.momentaryIndex = (this.momentaryIndex + 1) % this.samplesPerBlock;
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
    this.momentaryIndex = this.momentaryFrameCount = this.momentaryInvalidFrameCount = 0;
    this.momentaryEnergySum = 0;
    this.momentaryFrameEnergies.fill(0);
    this.momentaryInvalidFrames.fill(0);
    this.shortTermIndex = 0;
    this.shortTermFrameCount = 0;
    this.shortTermEnergy = 0;
    this.shortTermInvalidFrameCount = 0;
    this.shortTermInvalidFrames.fill(0);
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
