import { channelWeight, KWeighting } from './k-weighting';

/** Linked, attenuation-only guard on final PCM. Previewing a render quantum
 * accounts for the K-filter tail, then bounds every 400 ms / 3 s window ending
 * inside it. No main-thread timing or programme gain floor can bypass it. */
export class LoudnessCeiling {
  private filters: KWeighting[] = [];
  private signalFilters: KWeighting[] = [];
  private tailFilters: KWeighting[] = [];
  private inputFilters: KWeighting[] = [];
  private weights: number[] = [];
  private tailEnergy = new Float64Array(3);
  private readonly momentary: Float64Array;
  private readonly shortTerm: Float64Array;
  private readonly inputEnergy: Float64Array;
  private inputIndex = 0;
  private inputSum = 0;
  private momentaryIndex = 0;
  private shortTermIndex = 0;
  private momentarySum = 0;
  private shortTermSum = 0;
  private gain = 1;
  private previousCeiling = NaN;

  constructor(private readonly rate: number) {
    this.momentary = new Float64Array(Math.ceil(rate * .4));
    this.shortTerm = new Float64Array(Math.ceil(rate * 3));
    this.inputEnergy = new Float64Array(Math.ceil(rate * .1));
  }

  process(channels: Float32Array[], ceilingLufs: number): number {
    const frames = channels[0]?.length ?? 0;
    if (!frames) return this.gain;
    this.prepare(channels.length);
    if (ceilingLufs !== this.previousCeiling) {
      // A changed target starts a new measurement epoch. Already-played audio
      // cannot satisfy a lower retrospective ceiling; retain the filter tail
      // and gain, but do not mute for three seconds to repay its old energy.
      this.resetOutputWindows();
      this.previousCeiling = ceilingLufs;
    }
    // Small implementation margin covers float PCM and the reference meter's
    // coefficient rounding; this is not an extra user-visible loudness target.
    const energyLimit = Math.pow(10, (ceilingLufs - .15 + .691) / 10);
    for (let channel = 0; channel < channels.length; channel++) {
      this.signalFilters[channel].reset();
      this.tailFilters[channel].copyStateFrom(this.filters[channel]);
    }
    let a = 0, b = 0, c = 0, next = 1;
    let oldMomentary = this.momentarySum, oldShortTerm = this.shortTermSum;
    for (let frame = 0; frame < frames; frame++) {
      let inputEnergy = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        const signal = this.signalFilters[channel].process(channels[channel][frame]);
        const tail = this.tailFilters[channel].process(0);
        const weight = this.weights[channel];
        a += weight * signal * signal;
        b += 2 * weight * signal * tail;
        c += weight * tail * tail;
        const input = this.inputFilters[channel].process(channels[channel][frame]);
        inputEnergy += weight * input * input;
      }
      this.inputSum += inputEnergy - this.inputEnergy[this.inputIndex];
      this.inputEnergy[this.inputIndex] = inputEnergy;
      this.inputIndex = (this.inputIndex + 1) % this.inputEnergy.length;
      oldMomentary -= this.momentary[(this.momentaryIndex + frame) % this.momentary.length];
      oldShortTerm -= this.shortTerm[(this.shortTermIndex + frame) % this.shortTerm.length];
      const budget = Math.min(energyLimit * this.momentary.length - oldMomentary,
        energyLimit * this.shortTerm.length - oldShortTerm);
      next = Math.min(next, maximumGain(a, b, c, budget));
    }
    // A 100 ms input envelope approaches the ceiling smoothly. The exact
    // output-window constraints below remain authoritative during new bursts.
    // Limiting each 128-frame quantum's average instead would flatten speech
    // and attenuate bass merely because of its phase within that tiny block.
    const envelopeGain = this.inputSum > energyLimit * this.inputEnergy.length
      ? Math.sqrt(energyLimit * this.inputEnergy.length / this.inputSum) : 1;
    next = Math.min(next, envelopeGain, 1 - (1 - this.gain) * Math.exp(-frames / (this.rate * .05)));
    // Reserve the complete filter decay before emitting this quantum. Without
    // this reserve, a spent window budget could overflow even at zero gain:
    // the measurement filters still contain energy from earlier output.
    this.tailEnergy.fill(0);
    for (let channel = 0; channel < channels.length; channel++) {
      this.signalFilters[channel].drainTailEnergy(this.tailFilters[channel], Math.ceil(this.rate * .006), this.weights[channel], this.tailEnergy);
    }
    const tailBudget = Math.min(energyLimit * this.momentary.length - oldMomentary,
      energyLimit * this.shortTerm.length - oldShortTerm);
    next = Math.min(next, maximumGain(a + this.tailEnergy[0], b + this.tailEnergy[1], c + this.tailEnergy[2], tailBudget));
    this.gain = Math.max(0, next);
    for (let frame = 0; frame < frames; frame++) {
      let energy = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        channels[channel][frame] *= this.gain;
        const filtered = this.filters[channel].process(channels[channel][frame]);
        energy += this.weights[channel] * filtered * filtered;
      }
      this.momentarySum += energy - this.momentary[this.momentaryIndex];
      this.shortTermSum += energy - this.shortTerm[this.shortTermIndex];
      this.momentary[this.momentaryIndex] = this.shortTerm[this.shortTermIndex] = energy;
      this.momentaryIndex = (this.momentaryIndex + 1) % this.momentary.length;
      this.shortTermIndex = (this.shortTermIndex + 1) % this.shortTerm.length;
    }
    return this.gain;
  }

  private resetOutputWindows(): void {
    this.momentary.fill(0); this.shortTerm.fill(0);
    this.momentarySum = this.shortTermSum = this.momentaryIndex = this.shortTermIndex = 0;
  }

  private prepare(count: number): void {
    if (this.filters.length === count) return;
    this.filters = Array.from({ length: count }, () => new KWeighting(this.rate));
    this.signalFilters = Array.from({ length: count }, () => new KWeighting(this.rate));
    this.tailFilters = Array.from({ length: count }, () => new KWeighting(this.rate));
    this.inputFilters = Array.from({ length: count }, () => new KWeighting(this.rate));
    this.weights = Array.from({ length: count }, (_, channel) => channelWeight(channel, count));
    this.resetOutputWindows();
    this.inputEnergy.fill(0); this.inputSum = this.inputIndex = 0;
  }
}

// Filtered energy for a common gain g is a*g^2 + b*g + c. c is the
// contribution of already-emitted samples still ringing in the K filters.
function maximumGain(a: number, b: number, c: number, budget: number): number {
  if (a + b + c <= budget) return 1;
  if (a <= 1e-20) return b > 0 ? Math.max(0, Math.min(1, (budget - c) / b)) : 0;
  const discriminant = b * b - 4 * a * (c - budget);
  return discriminant > 0 ? Math.max(0, Math.min(1, (-b + Math.sqrt(discriminant)) / (2 * a))) : 0;
}
