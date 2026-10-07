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
  private inputFilled = 0;
  private momentaryIndex = 0;
  private shortTermIndex = 0;
  private momentarySum = 0;
  private shortTermSum = 0;
  private gain = 1;
  private heldGain = Infinity;
  private observedFrames = 0;
  private previousCeiling = NaN;

  constructor(private readonly rate: number) {
    this.momentary = new Float64Array(Math.ceil(rate * .4));
    this.shortTerm = new Float64Array(Math.ceil(rate * 3));
    // Reserve time before the 400 ms output window fills, while keeping the
    // steady fixed-gain cost below 10*log10(400/350) = 0.58 LU.
    this.inputEnergy = new Float64Array(Math.ceil(rate * .35));
  }

  getGain(programmeGain = 1): number { return Math.min(1, this.heldGain / programmeGain); }

  /** Recalibrate for an explicit source/settings change, retaining already
   * emitted PCM's window budget. A seek or meter reset must not release gain. */
  restart(): void {
    this.gain = 1;
    this.heldGain = Infinity;
    this.observedFrames = 0;
    this.inputEnergy.fill(0); this.inputSum = this.inputIndex = this.inputFilled = 0;
    for (const filter of this.inputFilters) filter.reset();
  }

  setCeiling(ceilingLufs: number): boolean {
    if (ceilingLufs === this.previousCeiling) return false;
    this.previousCeiling = ceilingLufs;
    this.resetOutputWindows();
    return true;
  }

  process(channels: Float32Array[], ceilingLufs: number, programmeGains?: Float32Array): number {
    const frames = channels[0]?.length ?? 0;
    if (!frames) return this.gain;
    this.prepare(channels.length);
    if (this.setCeiling(ceilingLufs)) this.restart();
    // Small implementation margin covers float PCM and the reference meter's
    // coefficient rounding; this is not an extra user-visible loudness target.
    const energyLimit = Math.pow(10, (ceilingLufs - .15 + .691) / 10);
    // Learn the source level independently of ordinary gain. Its delayed
    // per-frame value avoids confusing a calibration change with louder audio.
    for (let frame = 0; frame < frames; frame++) {
      let energy = 0;
      const programmeGain = programmeGains?.[frame] ?? 1;
      for (let channel = 0; channel < channels.length; channel++) {
        const input = this.inputFilters[channel].process(channels[channel][frame] / programmeGain);
        energy += this.weights[channel] * input * input;
      }
      this.inputSum += energy - this.inputEnergy[this.inputIndex];
      this.inputEnergy[this.inputIndex] = energy;
      this.inputIndex = (this.inputIndex + 1) % this.inputEnergy.length;
      if (this.inputFilled || energy > 1e-12) this.inputFilled = Math.min(this.inputEnergy.length, this.inputFilled + 1);
    }
    const envelopeGain = this.inputFilled > 0 && this.inputSum > 0
      ? Math.sqrt(energyLimit * Math.max(this.inputFilled === this.inputEnergy.length
        ? this.inputFilled : Math.min(this.inputFilled, this.inputEnergy.length / 2), Math.ceil(this.rate * .02)) / this.inputSum) : Infinity;
    // Startup filter transients are not representative programme evidence.
    // Protect them immediately, but only retain complete input windows.
    if (this.inputFilled === this.inputEnergy.length) this.heldGain = Math.min(this.heldGain, envelopeGain);
    let normalizationGain = 1, maximumEffectiveGain = 0;
    for (let frame = 0; frame < frames; frame++) {
      const gain = Math.min(this.getGain(programmeGains?.[frame] ?? 1), envelopeGain / (programmeGains?.[frame] ?? 1));
      normalizationGain = Math.min(normalizationGain, gain);
      maximumEffectiveGain = Math.max(maximumEffectiveGain, gain * (programmeGains?.[frame] ?? 1));
      for (const channel of channels) channel[frame] *= gain;
    }
    for (let channel = 0; channel < channels.length; channel++) {
      this.signalFilters[channel].reset();
      this.tailFilters[channel].copyStateFrom(this.filters[channel]);
    }
    let a = 0, b = 0, c = 0, next = 1;
    let oldMomentary = this.momentarySum, oldShortTerm = this.shortTermSum;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const signal = this.signalFilters[channel].process(channels[channel][frame]);
        const tail = this.tailFilters[channel].process(0);
        const weight = this.weights[channel];
        a += weight * signal * signal;
        b += 2 * weight * signal * tail;
        c += weight * tail * tail;
      }
      oldMomentary -= this.momentary[(this.momentaryIndex + frame) % this.momentary.length];
      oldShortTerm -= this.shortTerm[(this.shortTermIndex + frame) % this.shortTerm.length];
      const budget = Math.min(energyLimit * this.momentary.length - oldMomentary,
        energyLimit * this.shortTerm.length - oldShortTerm);
      next = Math.min(next, maximumGain(a, b, c, budget));
    }
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
    this.observedFrames += frames;
    // Unexpected louder content still needs an immediate safety reduction.
    // After calibration, recovering the temporary window guard may add at
    // most 0.05x per second to overall gain, regardless of programme gain.
    const recovery = this.observedFrames < this.rate * 10 ? 1
      : .05 * frames / this.rate / Math.max(maximumEffectiveGain, 1e-6);
    this.gain = Math.max(0, Math.min(next, this.gain + recovery));
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
    return this.gain * normalizationGain;
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
    this.restart();
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
