import { ProgramLoudness } from './program-loudness';

export interface AgcUpdateInput {
  currentGain: number;
  minGain: number;
  maxGain: number;
  deltaSec: number;
  targetLufs: number;
  momentaryLufs: number;
  shortTermLufs: number;
  gainChangePerSec: number;
}
export type AgcPhase = 'collecting' | 'calibrating' | 'stable' | 'recalibrating' | 'full-track';
export interface AgcUpdateResult {
  nextGain: number;
  phase: AgcPhase;
  referenceLufs: number;
  limited: boolean;
  recalibrations: number;
}

/** Programme-level normalization. Only fresh audio observations advance this
 * state; UI frames, silence and missing measurements cannot recalibrate it. */
export class RealtimeAgc {
  private history = new ProgramLoudness();
  private anchor: number | null = null;
  private externalGain: number | null = null;
  private requestGain: number | null = null;
  private referenceMark = NaN;
  private stableSeconds = 0;
  private correctionSeconds = 0;
  private correctionDirection = 0;
  private louderSeconds = 0;
  private recalibrations = 0;
  private phase: AgcPhase = 'collecting';

  reset(): void {
    this.history.reset();
    this.anchor = this.externalGain = this.requestGain = null;
    this.referenceMark = NaN;
    this.stableSeconds = this.correctionSeconds = this.louderSeconds = 0;
    this.recalibrations = 0;
    this.correctionDirection = 0;
    this.phase = 'collecting';
  }

  isLocked(): boolean { return this.externalGain !== null; }
  lockGain(gain: number): void {
    if (Number.isFinite(gain) && gain > 0) this.externalGain = gain;
  }
  unlockGain(): void {
    this.externalGain = this.anchor = this.requestGain = null;
    this.stableSeconds = this.correctionSeconds = this.louderSeconds = 0;
    this.phase = 'calibrating';
  }

  update(input: AgcUpdateInput): AgcUpdateResult {
    const current = clamp(Number.isFinite(input.currentGain) ? input.currentGain : 1, input.minGain, input.maxGain);
    const dt = clamp(Number.isFinite(input.deltaSec) ? input.deltaSec : 0, 0, 0.25);
    const audible = Number.isFinite(input.momentaryLufs) && input.momentaryLufs > -60;
    // Near silence must not count as calibration evidence or bias its reference.
    if (audible) this.history.observe(input.momentaryLufs, dt);
    const reference = this.history.getLoudness();
    const rawGain = Math.pow(10, (input.targetLufs - reference) / 20);
    const result = (nextGain: number): AgcUpdateResult => ({
      nextGain, phase: this.phase, referenceLufs: reference,
      limited: Number.isFinite(rawGain) && (rawGain < input.minGain || rawGain > input.maxGain),
      recalibrations: this.recalibrations
    });

    if (this.externalGain !== null) {
      this.phase = 'full-track';
      return result(slew(current, clamp(this.externalGain, input.minGain, input.maxGain), dt, 2, input.gainChangePerSec));
    }
    if (!audible || !Number.isFinite(reference) || dt === 0) {
      this.louderSeconds = 0;
      return result(current);
    }

    const desired = clamp(rawGain, input.minGain, input.maxGain);
    const activeSeconds = this.history.getActiveSeconds();
    if (!Number.isFinite(this.referenceMark) || Math.abs(reference - this.referenceMark) > 0.5) {
      this.referenceMark = reference;
      this.stableSeconds = 0;
    } else {
      this.stableSeconds += dt;
    }

    if (this.anchor !== null) {
      this.phase = 'stable';
      const recent = Number.isFinite(input.shortTermLufs) ? input.shortTermLufs : input.momentaryLufs;
      this.louderSeconds = recent + db(this.anchor) > input.targetLufs + 4
        ? this.louderSeconds + dt : 0;
      // One exceptional downward recalibration per video. This is reported,
      // not excluded from the whole-video stability statistics.
      if (this.recalibrations === 0 && this.louderSeconds >= 8 && desired < this.anchor) {
        this.recalibrations++;
        this.anchor = null;
        this.requestGain = null;
        this.stableSeconds = this.louderSeconds = 0;
        this.phase = 'recalibrating';
      } else {
        const error = input.targetLufs - (reference + db(current));
        const representative = input.momentaryLufs >= reference - 6;
        const direction = Math.abs(error) > 0.1 ? Math.sign(error) : 0;
        if (direction !== this.correctionDirection) this.correctionSeconds = 0;
        this.correctionDirection = direction;
        // Speech has pauses: accumulate useful evidence across loud phrases.
        // Quiet windows neither add evidence nor boost.
        if (representative && direction) this.correctionSeconds += dt;
        if (representative && Math.abs(error) <= 0.1) this.requestGain = current;
        if (representative && this.correctionSeconds >= (error < 0 ? 1 : 2)) {
          // Keep a fixed 0.5x-wide interval, shifted inward at user bounds
          // rather than wasting half of the correction range outside them.
          const corridorLower = Math.max(input.minGain, Math.min(this.anchor - 0.25, input.maxGain - 0.5));
          const lower = Math.max(corridorLower, this.anchor * Math.pow(10, -3 / 20));
          const upper = Math.min(input.maxGain, corridorLower + 0.5, this.anchor * Math.pow(10, 2 / 20));
          this.requestGain = clamp(desired, lower, upper);
          this.correctionSeconds = 0;
        }
        const downward = (this.requestGain ?? current) < current;
        if (!representative && !downward) return result(current);
        return result(slew(current, this.requestGain ?? current, dt, downward ? 2 : 0.5,
          Math.min(downward ? 0.2 : 0.04, input.gainChangePerSec)));
      }
    }

    if (this.phase !== 'recalibrating') this.phase = activeSeconds < 1 ? 'collecting' : 'calibrating';
    let destination = desired;
    if (input.momentaryLufs > input.targetLufs + 4) {
      destination = Math.min(destination, clamp(Math.pow(10,
        (input.targetLufs + 1 - input.momentaryLufs) / 20), input.minGain, input.maxGain));
    }
    // Four seconds of useful audio before boosting; a very quiet intro cannot
    // justify a large boost. Downward calibration is permitted immediately.
    if (activeSeconds < 4 || reference < input.targetLufs - 25) destination = Math.min(destination, current);
    if (input.momentaryLufs < reference - 6 && destination > current) destination = current;
    if (this.phase === 'recalibrating') destination = Math.min(destination, current);
    const next = slew(current, destination, dt, destination < current ? 6 : 2,
      input.gainChangePerSec * (destination < current ? 3 : 1));
    if (activeSeconds >= 10 && (this.stableSeconds >= 3 || activeSeconds >= 20)
      && (Math.abs(db(next / desired)) <= 0.25
        || (this.phase === 'recalibrating' && next <= desired))) {
      this.anchor = next;
      this.requestGain = next;
      this.phase = 'stable';
    }
    return result(next);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function db(gain: number): number { return 20 * Math.log10(Math.max(gain, 1e-8)); }
function slew(current: number, target: number, dt: number, dbPerSecond: number, linearPerSecond: number): number {
  const ratio = Math.pow(10, dbPerSecond * dt / 20);
  const step = Math.max(0, linearPerSecond) * dt;
  return target > current
    ? Math.min(target, current * ratio, current + step)
    : Math.max(target, current / ratio, current - step);
}
