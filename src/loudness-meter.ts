type FilterState = { shelf: Biquad; highPass: Biquad };

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number
  ) {}

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

export class LoudnessMeter {
  private readonly samplesPerBlock: number;
  private readonly stepSamples: number;
  private readonly maxBlocks: number;
  private filters: FilterState[] = [];
  private buffers: Float32Array[] = [];
  private blocks: number[] = [];
  private recentBlocks: number[] = [];
  private bufferIndex = 0;
  private processedFrames = 0;
  private momentaryEnergy = NaN;

  constructor(
    private readonly sampleRate = 48000,
    maxIntegrationSeconds = 600
  ) {
    this.samplesPerBlock = Math.ceil(BLOCK_SECONDS * sampleRate);
    this.stepSamples = Math.ceil(STEP_SECONDS * sampleRate);
    this.maxBlocks = Number.isFinite(maxIntegrationSeconds)
      ? Math.ceil(maxIntegrationSeconds / STEP_SECONDS)
      : Number.POSITIVE_INFINITY;
    this.ensureChannels(1);
  }

  processBlock(data: Float32Array): void {
    this.processChannels([data]);
  }

  processChannels(channels: Float32Array[]): void {
    if (!channels.length) return;
    this.ensureChannels(channels.length);
    const frames = Math.max(...channels.map((channel) => channel.length));
    this.processedFrames += frames;

    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const state = this.filters[channel];
        const shelf = state.shelf.process(channels[channel][frame] ?? 0);
        this.buffers[channel][this.bufferIndex] = state.highPass.process(shelf);
      }
      this.bufferIndex++;
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
    if (this.recentBlocks.length < 30) return this.getIntegratedLoudness();
    return toLufs(average(this.recentBlocks));
  }

  getIntegrationTime(): number {
    return this.processedFrames / this.sampleRate;
  }

  reset(): void {
    this.blocks = [];
    this.recentBlocks = [];
    this.bufferIndex = 0;
    this.processedFrames = 0;
    this.momentaryEnergy = NaN;
    this.buffers.forEach((buffer) => buffer.fill(0));
    this.filters.forEach(({ shelf, highPass }) => {
      shelf.reset();
      highPass.reset();
    });
  }

  private commitBlock(channelCount: number): void {
    const energy = this.weightedEnergy(channelCount, this.samplesPerBlock);
    this.momentaryEnergy = energy;
    this.recentBlocks.push(energy);
    if (this.recentBlocks.length > 30) this.recentBlocks.shift();
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
      const weight = channel < 2 ? 1 : Math.pow(10, 1.5 / 10);
      energy += weight * sum / length;
    }
    return energy;
  }

  private ensureChannels(count: number): void {
    while (this.filters.length < count) {
      this.filters.push(createKWeighting(this.sampleRate));
      this.buffers.push(new Float32Array(this.samplesPerBlock));
    }
  }
}

export function calculateGainForLoudness(currentLufs: number, targetLufs: number): number {
  return Number.isFinite(currentLufs) && Number.isFinite(targetLufs)
    ? Math.pow(10, (targetLufs - currentLufs) / 20)
    : 1;
}

function createKWeighting(sampleRate: number): FilterState {
  return {
    shelf: coefficients('shelf', 1681.9744509555319, 0.7071752369554193, 3.99984385397, sampleRate),
    highPass: coefficients('highPass', 38.13547087613982, 0.5003270373253953, 0, sampleRate)
  };
}

function coefficients(
  type: 'shelf' | 'highPass',
  frequency: number,
  q: number,
  gain: number,
  sampleRate: number
): Biquad {
  const k = Math.tan(Math.PI * frequency / sampleRate);
  const a0 = 1 + k / q + k * k;
  const a1 = 2 * (k * k - 1) / a0;
  const a2 = (1 - k / q + k * k) / a0;
  if (type === 'highPass') return new Biquad(1 / a0, -2 / a0, 1 / a0, a1, a2);
  const high = Math.pow(10, gain / 20);
  const middle = Math.pow(high, 0.499666774155);
  return new Biquad(
    (high + middle * k / q + k * k) / a0,
    2 * (k * k - high) / a0,
    (high - middle * k / q + k * k) / a0,
    a1,
    a2
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toLufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
}
