export interface AgcUpdateInput {
  currentGain: number;
  minGain: number;
  maxGain: number;
  deltaSec: number;
  targetLufs: number;
  integratedLufs: number;
  momentaryLufs: number;
  gainChangePerSec: number;
}
export type AgcPhase = 'collecting' | 'calibrating' | 'stable' | 'full-track';
export interface AgcUpdateResult {
  nextGain: number;
  phase: AgcPhase;
  referenceLufs: number;
  limited: boolean;
}

/** Programme-level normalization. Only fresh audio observations advance this
 * state; UI frames, silence and missing measurements cannot recalibrate it. */
export class RealtimeAgc {
  private activeSeconds = 0;
  private externalGain: number | null = null;
  private requestGain: number | null = null;
  private referenceMark = NaN;
  private stableSeconds = 0;
  private correctionSeconds = 0;
  private correctionDirection = 0;
  private phase: AgcPhase = 'collecting';

  reset(): void {
    this.activeSeconds = 0;
    this.externalGain = this.requestGain = null;
    this.referenceMark = NaN;
    this.stableSeconds = this.correctionSeconds = 0;
    this.correctionDirection = 0;
    this.phase = 'collecting';
  }

  isLocked(): boolean { return this.externalGain !== null; }
  lockGain(gain: number): void {
    if (Number.isFinite(gain) && gain > 0) this.externalGain = gain;
  }
  unlockGain(): void {
    this.externalGain = this.requestGain = null;
    this.stableSeconds = this.correctionSeconds = 0;
    this.phase = 'calibrating';
  }

  update(input: AgcUpdateInput): AgcUpdateResult {
    const current = clamp(Number.isFinite(input.currentGain) ? input.currentGain : 1, input.minGain, input.maxGain);
    const dt = clamp(Number.isFinite(input.deltaSec) ? input.deltaSec : 0, 0, 0.25);
    const audible = Number.isFinite(input.momentaryLufs) && input.momentaryLufs > -60;
    // The meter owns gating and integration; control and UI share its reference.
    const reference = input.integratedLufs;
    if (audible && Number.isFinite(reference)) this.activeSeconds += dt;
    const rawGain = Math.pow(10, (input.targetLufs - reference) / 20);
    const result = (nextGain: number): AgcUpdateResult => ({
      nextGain, phase: this.phase, referenceLufs: reference,
      limited: Number.isFinite(rawGain) && (rawGain < input.minGain || rawGain > input.maxGain)
    });

    if (this.externalGain !== null) {
      this.phase = 'full-track';
      return result(slew(current, clamp(this.externalGain, input.minGain, input.maxGain), dt, 2, input.gainChangePerSec));
    }
    if (!audible || !Number.isFinite(reference) || dt === 0) return result(current);

    const desired = clamp(rawGain, input.minGain, input.maxGain);
    if (this.phase === 'stable') {
      const error = input.targetLufs - (reference + db(current));
      const direction = Math.abs(error) > 0.1 ? Math.sign(error) : 0;
      if (direction !== this.correctionDirection) this.correctionSeconds = 0;
      this.correctionDirection = direction;
      // The integrated meter already gates silence. Requiring a loud current
      // phrase here could freeze a stale gain throughout a quieter passage.
      if (direction) this.correctionSeconds += dt;
      if (Math.abs(error) <= 0.1) this.requestGain = current;
      if (this.correctionSeconds >= (error < 0 ? 1 : 2)) {
        // Correct only the cumulative average. A fixed early corridor would
        // prevent normalization when later programme content changes.
        this.requestGain = desired;
        this.correctionSeconds = 0;
      }
      const requested = this.requestGain ?? current;
      const downward = requested < current;
      return result(slew(current, requested, dt, downward ? 2 : 0.5,
        Math.min(downward ? 0.2 : 0.04, input.gainChangePerSec)));
    }

    if (!Number.isFinite(this.referenceMark) || Math.abs(reference - this.referenceMark) > 0.5) {
      this.referenceMark = reference;
      this.stableSeconds = 0;
    } else {
      this.stableSeconds += dt;
    }
    const activeSeconds = this.activeSeconds;
    this.phase = activeSeconds < 1 ? 'collecting' : 'calibrating';
    let destination = desired;
    // Four seconds of useful audio before boosting; a very quiet intro cannot
    // justify a large boost. Downward calibration is permitted immediately.
    if (activeSeconds < 4 || reference < input.targetLufs - 25) destination = Math.min(destination, current);
    if (input.momentaryLufs < reference - 6 && destination > current) destination = current;
    const next = slew(current, destination, dt, destination < current ? 12 : 2,
      input.gainChangePerSec * (destination < current ? 6 : 1));
    if (activeSeconds >= 10 && (this.stableSeconds >= 3 || activeSeconds >= 20)
      && Math.abs(db(next / desired)) <= 0.25) {
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
