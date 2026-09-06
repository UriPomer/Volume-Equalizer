const MIN_LUFS = -70;
const MAX_LUFS = 20;
const BIN_WIDTH_LU = 0.1;
const BIN_COUNT = Math.round((MAX_LUFS - MIN_LUFS) / BIN_WIDTH_LU);
const LOUDEST_FRACTION = 0.4;

/**
 * Constant-space programme loudness estimator. Observations are grouped by
 * their 0.1 LU bucket, while the duration-weighted linear energy is retained
 * for each bucket so the final result never averages LUFS values directly.
 */
export class ProgramLoudness {
  private readonly seconds = new Float64Array(BIN_COUNT);
  private readonly energySeconds = new Float64Array(BIN_COUNT);
  private activeSeconds = 0;

  observe(lufs: number, seconds: number): void {
    if (!Number.isFinite(lufs) || lufs <= MIN_LUFS
      || !Number.isFinite(seconds) || seconds <= 0) return;

    const energy = Math.pow(10, (lufs + 0.691) / 10);
    if (!Number.isFinite(energy)) return;

    const bin = Math.min(BIN_COUNT - 1, Math.floor((lufs - MIN_LUFS) / BIN_WIDTH_LU));
    this.seconds[bin] += seconds;
    this.energySeconds[bin] += energy * seconds;
    this.activeSeconds += seconds;
  }

  getLoudness(): number {
    if (!(this.activeSeconds > 0) || !Number.isFinite(this.activeSeconds)) return NaN;

    let remaining = this.activeSeconds * LOUDEST_FRACTION;
    let selectedSeconds = 0;
    let selectedEnergySeconds = 0;
    for (let bin = BIN_COUNT - 1; bin >= 0 && remaining > 0; bin--) {
      const duration = this.seconds[bin];
      if (!(duration > 0)) continue;
      const fraction = Math.min(1, remaining / duration);
      selectedSeconds += duration * fraction;
      selectedEnergySeconds += this.energySeconds[bin] * fraction;
      remaining -= duration * fraction;
    }

    const meanEnergy = selectedEnergySeconds / selectedSeconds;
    return Number.isFinite(meanEnergy) && meanEnergy > 0
      ? -0.691 + 10 * Math.log10(meanEnergy)
      : NaN;
  }

  getActiveSeconds(): number {
    return this.activeSeconds;
  }

  reset(): void {
    this.seconds.fill(0);
    this.energySeconds.fill(0);
    this.activeSeconds = 0;
  }
}
