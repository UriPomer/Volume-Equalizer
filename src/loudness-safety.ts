import { KWeighting, channelWeight } from './k-weighting';

/** Buffers 100 ms to observe a block and another 100 ms to schedule its safety
 * calculation across callbacks. K-weighting is linear: filtered output is
 * historyResponse + gain * blockResponse. Every sliding 400 ms window is a
 * quadratic in gain, including windows crossing block boundaries and tails.
 */
export class LoudnessSafety {
  readonly blockSize: number;
  readonly windowSize: number;
  gain = 1;
  private position = 0;
  private historyIndex = 0;
  private historySum = 0;
  private filters: KWeighting[] = [];
  private carry: KWeighting[] = [];
  private signal: KWeighting[] = [];
  private blockCarry: KWeighting[] = [];
  private blockSignal: KWeighting[] = [];
  private weights: number[] = [];
  private incoming: Float32Array[] = [];
  private planning: Float32Array[] = [];
  private ready: Float32Array[] = [];
  private history: Float64Array;
  private a: Float64Array;
  private b: Float64Array;
  private c: Float64Array;
  private blockA: Float64Array;
  private blockB: Float64Array;
  private blockC: Float64Array;
  private planFrame = 0;
  private sumA = 0;
  private sumB = 0;
  private sumC = 0;
  private ceiling = 1;
  private blockSumA = 0;
  private blockSumB = 0;
  private blockSumC = 0;
  private readonly energyLimit: number;

  constructor(private readonly sampleRate: number, targetLufs: number) {
    this.blockSize = Math.round(sampleRate * 0.1);
    this.windowSize = this.blockSize * 4;
    this.history = new Float64Array(this.windowSize);
    this.a = new Float64Array(this.windowSize);
    this.b = new Float64Array(this.windowSize);
    this.c = new Float64Array(this.windowSize);
    this.blockA = new Float64Array(this.blockSize);
    this.blockB = new Float64Array(this.blockSize);
    this.blockC = new Float64Array(this.blockSize);
    // Numerical headroom covers Float32 rounding and vanishing IIR tails.
    this.energyLimit = Math.pow(10, (targetLufs + 2 - 0.05 + 0.691) / 10)
      * this.windowSize;
  }

  processFrame(channels: Float32Array[], frame: number): void {
    if (channels.length !== this.filters.length) this.resetChannels(channels.length);
    for (let channel = 0; channel < channels.length; channel++) {
      const sample = channels[channel][frame];
      this.incoming[channel][this.position] = Number.isFinite(sample) ? sample : 0;
      channels[channel][frame] = this.ready[channel][this.position] * this.gain;
    }
    // Five forecast samples per input sample: 100 ms block + 400 ms tail.
    for (let step = 0; step < 5; step++) this.advancePlan();
    if (++this.position === this.blockSize) {
      this.finishPlan();
      const reusable = this.ready;
      this.ready = this.planning;
      this.planning = this.incoming;
      this.incoming = reusable;
      this.position = 0;
      this.startPlan();
    }
  }

  private resetChannels(count: number): void {
    this.filters = Array.from({ length: count }, () => new KWeighting(this.sampleRate));
    this.weights = Array.from({ length: count }, (_, channel) => channelWeight(channel, count));
    this.incoming = Array.from({ length: count }, () => new Float32Array(this.blockSize));
    this.planning = Array.from({ length: count }, () => new Float32Array(this.blockSize));
    this.ready = Array.from({ length: count }, () => new Float32Array(this.blockSize));
    this.history.fill(0);
    this.position = this.historyIndex = this.historySum = 0;
    this.gain = 1;
    this.startPlan();
  }

  private startPlan(): void {
    this.carry = this.filters.map((filter) => filter.clone());
    this.signal = this.filters.map(() => new KWeighting(this.sampleRate));
    this.a.fill(0);
    this.b.fill(0);
    this.c.set(this.history);
    this.sumA = this.sumB = this.planFrame = 0;
    this.sumC = this.historySum;
    this.ceiling = 1;
    this.blockSumA = this.blockSumB = this.blockSumC = 0;
  }

  private advancePlan(): void {
    const frame = this.planFrame++;
    let a = 0;
    let b = 0;
    let c = 0;
    for (let channel = 0; channel < this.filters.length; channel++) {
      const old = this.carry[channel].process(0);
      const fresh = this.signal[channel].process(
        frame < this.blockSize ? this.planning[channel][frame] : 0
      );
      const weight = this.weights[channel];
      a += weight * fresh * fresh;
      b += weight * 2 * fresh * old;
      c += weight * old * old;
    }
    const index = (this.historyIndex + frame) % this.windowSize;
    this.sumA += a - this.a[index];
    this.sumB += b - this.b[index];
    this.sumC += c - this.c[index];
    this.a[index] = a;
    this.b[index] = b;
    this.c[index] = c;
    if (frame < this.blockSize) {
      this.blockA[frame] = a;
      this.blockB[frame] = b;
      this.blockC[frame] = c;
      this.blockSumA += a;
      this.blockSumB += b;
      this.blockSumC += c;
    }
    if (frame === this.blockSize - 1) {
      // Any 400 ms interval intersects at most five 100 ms blocks. Reserve
      // one fifth per block so earlier output cannot exhaust the next block's
      // entire budget and force audible 100 ms dropouts.
      this.constrain(this.blockSumA, this.blockSumB, this.blockSumC, this.energyLimit / 5);
      this.blockCarry = this.carry.map(filter => filter.clone());
      this.blockSignal = this.signal.map(filter => filter.clone());
    }
    // A silent block cannot consume new energy. Avoid turning round-off in
    // the retained history into zero gain (and a minutes-long recovery).
    this.constrain(this.sumA, this.sumB, this.sumC, this.energyLimit);
  }

  private constrain(a: number, b: number, c: number, budget: number): void {
    const limit = budget * (1 + 1e-10);
    if (a > 1e-20 && a + b + c > limit) {
      const discriminant = b * b - 4 * a * (c - limit);
      const sqrt = Math.sqrt(Math.max(0, discriminant));
      const root = b >= 0 && sqrt + b > 0
        ? 2 * (limit - c) / (sqrt + b)
        : (-b + sqrt) / (2 * a);
      this.ceiling = Math.min(this.ceiling, Math.max(0, root));
    }
  }

  private finishPlan(): void {
    // A 250 ms release approaches unity even from zero, without logarithmic
    // recovery getting stuck near silence. The forecast remains the hard cap.
    this.gain = Math.min(this.ceiling, 1 - (1 - this.gain)
      * Math.exp(-this.blockSize / this.sampleRate / 0.25));
    for (let channel = 0; channel < this.filters.length; channel++) {
      this.filters[channel] = this.blockCarry[channel];
      this.filters[channel].addScaledState(this.blockSignal[channel], this.gain);
    }
    for (let frame = 0; frame < this.blockSize; frame++) {
      const energy = Math.max(0, this.blockA[frame] * this.gain * this.gain
        + this.blockB[frame] * this.gain + this.blockC[frame]);
      this.historySum += energy - this.history[this.historyIndex];
      this.history[this.historyIndex] = energy;
      this.historyIndex = (this.historyIndex + 1) % this.windowSize;
    }
  }
}
