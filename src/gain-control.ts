export interface LoudnessSelectionInput {
  integratedLufs: number;
  shortTermLufs: number;
  momentaryLufs: number;
  integrationTime: number;
  minIntegrationSeconds: number;
  calibrationSeconds?: number;
  calibrationSafetyThresholdLufs?: number;
}

export interface AgcUpdateInput {
  currentGain: number;
  desiredGain?: number;
  calibrationGain?: number;
  minGain: number;
  maxGain: number;
  deltaSec: number;
  controlLufs: number;
  targetLufs: number;
  integrationTime: number;
  coldStartSeconds: number;
  sourcePeak: number;
  momentaryLufs: number;
  shortTermLufs: number;
  gainChangePerSec: number;
  calibrationBoostStartSeconds: number;
  postCalibrationCorridor: number;
  postCalibrationDbCorridor: number;
  programTimeSeconds?: number;
}

export interface AgcUpdateResult {
  nextGain: number;
  allowBelowMin: boolean;
  gateOpen: boolean;
  state: 'cold-start' | 'noise-hold' | 'attenuate' | 'boost' | 'hold' | 'locked';
  peakLimitedGain: number;
  riseScale: number;
}

const LOW_CONFIDENCE_LU = 18;
const SOFT_CONFIDENCE_LU = 10;
const LOW_CONFIDENCE_RISE_SCALE = 0.1;
const SOFT_CONFIDENCE_RISE_SCALE = 0.35;
const LOW_CONFIDENCE_GAIN_CEILING = 1.3;
const NOISE_FLOOR_INITIAL_LUFS = -62;
const NOISE_FLOOR_MIN_LUFS = -80;
const NOISE_FLOOR_MAX_LUFS = -30;
const GATE_OPEN_ABOVE_NOISE_LU = 10;
const GATE_CLOSE_ABOVE_NOISE_LU = 6;
const GATE_PROGRAM_OPEN_BELOW_TARGET_LU = 28;
const GATE_PROGRAM_CLOSE_BELOW_TARGET_LU = 34;
const GATE_PEAK_OPEN = 0.04;
const GATE_PEAK_CLOSE = 0.025;
const GATE_CLOSE_HOLD_SEC = 0.8;
const MAX_BOOST_DB_PER_SEC = 2;
const CALIBRATION_ATTENUATION_DB_PER_SEC = 8;
// 稳态稳定性约束：校准完成后，gain 任意方向变化不超过 0.1x/分钟（≈0.87 dB @ 1x）。
// 突发动态不再快速改写节目 gain，峰值由末端 lookahead limiter 处理。
const MAX_GAIN_CHANGE_PER_SEC = 0.1 / 60;

export function chooseControlLoudness(input: LoudnessSelectionInput): number {
  if (input.integrationTime < input.minIntegrationSeconds) {
    return isFinite(input.momentaryLufs) ? input.momentaryLufs : NaN;
  }

  if (
    input.calibrationSeconds !== undefined
    && input.integrationTime < input.calibrationSeconds
  ) {
    const candidates = [
      input.integratedLufs,
      input.shortTermLufs,
      input.momentaryLufs
    ].filter((value) => isFinite(value));
    if (!candidates.length) return NaN;
    const loudest = Math.max(...candidates);
    if (
      input.calibrationSafetyThresholdLufs === undefined
      || loudest >= input.calibrationSafetyThresholdLufs
    ) {
      return loudest;
    }
  }

  if (isFinite(input.integratedLufs)) return input.integratedLufs;
  if (isFinite(input.shortTermLufs)) return input.shortTermLufs;
  return isFinite(input.momentaryLufs) ? input.momentaryLufs : NaN;
}

export function computeGainRiseScale(controlLufs: number, targetLufs: number): number {
  if (!isFinite(controlLufs) || !isFinite(targetLufs)) return 0;
  const deficit = targetLufs - controlLufs;
  if (deficit > LOW_CONFIDENCE_LU) return LOW_CONFIDENCE_RISE_SCALE;
  if (deficit > SOFT_CONFIDENCE_LU) return SOFT_CONFIDENCE_RISE_SCALE;
  return 1;
}

export class RealtimeAgc {
  private gateOpen = false;
  private noiseFloorLufs = NOISE_FLOOR_INITIAL_LUFS;
  private closeHoldSec = 0;
  private predictionElapsedSec = 0;
  private lockedProgramGain: number | null = null;
  private calibrationAnchorGain: number | null = null;

  reset(): void {
    this.gateOpen = false;
    this.noiseFloorLufs = NOISE_FLOOR_INITIAL_LUFS;
    this.closeHoldSec = 0;
    this.predictionElapsedSec = 0;
    this.lockedProgramGain = null;
    this.calibrationAnchorGain = null;
  }

  isLocked(): boolean {
    return this.lockedProgramGain !== null;
  }

  lockGain(gain: number): void {
    if (Number.isFinite(gain)) this.lockedProgramGain = gain;
  }

  unlockGain(): void {
    this.lockedProgramGain = null;
    this.calibrationAnchorGain = null;
  }

  update(input: AgcUpdateInput): AgcUpdateResult {
    const currentGain = Math.min(Math.max(input.currentGain, 0), input.maxGain);
    // Final post-EQ DSP owns output safety; programme gain remains slew-limited.
    if (this.lockedProgramGain !== null) {
      const targetGain = Math.min(Math.max(this.lockedProgramGain, input.minGain), input.maxGain);
      const candidateGain = this.slewLimitGain(input, currentGain, targetGain, 1);
      return {
        nextGain: candidateGain,
        allowBelowMin: this.isBelowMinimum(
          candidateGain,
          input.minGain
        ),
        gateOpen: this.gateOpen,
        state: 'locked',
        peakLimitedGain: targetGain,
        riseScale: 0
      };
    }

    this.updateGate(input);
    this.predictionElapsedSec += Math.max(0, input.deltaSec);

    const programTimeSeconds = Number.isFinite(input.programTimeSeconds)
      ? input.programTimeSeconds as number
      : this.predictionElapsedSec;
    // 校准期只在尚未建立校准锚点时进入：seek/切标签后锚点仍在，不应重新快速校准。
    const isCalibrating = this.calibrationAnchorGain === null
      && (programTimeSeconds < input.coldStartSeconds
        || input.integrationTime < input.coldStartSeconds);
    const calibrationBoostReady = input.integrationTime
      >= input.calibrationBoostStartSeconds;
    const riseScale = isCalibrating
      ? 1
      : computeGainRiseScale(input.controlLufs, input.targetLufs);
    const peakLimitedGain = this.computePeakLimitedMaxGain(input, riseScale);
    const targetGain = isFinite(input.desiredGain ?? NaN)
      ? input.desiredGain as number
      : calculateGainForLoudness(input.controlLufs, input.targetLufs);
    let desiredGain = this.computeDesiredGain(
      input,
      targetGain,
      peakLimitedGain,
      riseScale,
      isCalibrating
    );
    if (isCalibrating && !calibrationBoostReady && desiredGain > currentGain) {
      desiredGain = Math.min(desiredGain, 1);
    }

    if (!this.gateOpen && desiredGain > currentGain) {
      const nextGain = currentGain;
      return {
        nextGain,
        allowBelowMin: this.isBelowMinimum(nextGain, input.minGain),
        gateOpen: this.gateOpen,
        state: nextGain < currentGain ? 'attenuate' : 'noise-hold',
        peakLimitedGain,
        riseScale
      };
    }

    const candidateGain = this.slewLimitGain(
      input,
      currentGain,
      desiredGain,
      riseScale,
      isCalibrating
    );
    const nextGain = candidateGain;

    return {
      nextGain,
      allowBelowMin: this.isBelowMinimum(nextGain, input.minGain),
      gateOpen: this.gateOpen,
      state: this.classifyState(isCalibrating, nextGain, currentGain),
      peakLimitedGain,
      riseScale
    };
  }

  private updateGate(input: AgcUpdateInput): void {
    // Silence (-Infinity) is a valid current observation. Programme history
    // must never keep the gate open after current audio has disappeared.
    const gateCandidates = [input.momentaryLufs]
      .filter((value) => !Number.isNaN(value) && value !== Infinity);
    const gateLufs = gateCandidates.length > 0 ? Math.max(...gateCandidates) : NaN;
    if (!isFinite(gateLufs)) {
      this.gateOpen = false;
      this.closeHoldSec = 0;
      return;
    }

    this.updateNoiseFloor(gateLufs, input.deltaSec);

    const openThreshold = Math.max(
      this.noiseFloorLufs + GATE_OPEN_ABOVE_NOISE_LU,
      input.targetLufs - GATE_PROGRAM_OPEN_BELOW_TARGET_LU
    );
    const closeThreshold = Math.max(
      this.noiseFloorLufs + GATE_CLOSE_ABOVE_NOISE_LU,
      input.targetLufs - GATE_PROGRAM_CLOSE_BELOW_TARGET_LU
    );

    if (!this.gateOpen) {
      // 峰值开门的先决条件是节目响度不低于关门阈值：单次瞬态峰值（咳嗽/爆音）出现在
      // 安静片段中时不应开门爬升增益，否则长静音会被重复瞬态缓慢放大。
      this.gateOpen = gateLufs >= openThreshold
        || (input.sourcePeak >= GATE_PEAK_OPEN && gateLufs >= closeThreshold);
      this.closeHoldSec = 0;
      return;
    }

    const shouldClose = gateLufs <= closeThreshold && input.sourcePeak <= GATE_PEAK_CLOSE;
    if (shouldClose) {
      this.closeHoldSec += Math.max(0, input.deltaSec);
      if (this.closeHoldSec >= GATE_CLOSE_HOLD_SEC) {
        this.gateOpen = false;
      }
    } else {
      this.closeHoldSec = 0;
    }
  }

  private updateNoiseFloor(gateLufs: number, deltaSec: number): void {
    if (this.gateOpen && gateLufs > this.noiseFloorLufs + GATE_OPEN_ABOVE_NOISE_LU) return;

    const bounded = Math.min(Math.max(gateLufs, NOISE_FLOOR_MIN_LUFS), NOISE_FLOOR_MAX_LUFS);
    const timeConstant = bounded > this.noiseFloorLufs ? 8 : 2;
    const alpha = 1 - Math.exp(-Math.max(0, deltaSec) / timeConstant);
    this.noiseFloorLufs += (bounded - this.noiseFloorLufs) * alpha;
  }

  private computePeakLimitedMaxGain(input: AgcUpdateInput, riseScale: number): number {
    let maxAllowedGain = input.maxGain;

    if (riseScale === LOW_CONFIDENCE_RISE_SCALE) {
      maxAllowedGain = Math.min(maxAllowedGain, LOW_CONFIDENCE_GAIN_CEILING);
    }

    return maxAllowedGain;
  }

  private isBelowMinimum(gain: number, minGain: number): boolean {
    return gain < minGain;
  }

  private computeDesiredGain(
    input: AgcUpdateInput,
    targetGain: number,
    peakLimitedGain: number,
    riseScale: number,
    isCalibrating: boolean
  ): number {
    let maxAllowedGain = peakLimitedGain;
    if (riseScale === LOW_CONFIDENCE_RISE_SCALE) {
      maxAllowedGain = Math.min(maxAllowedGain, LOW_CONFIDENCE_GAIN_CEILING);
    }
    let desiredGain = Math.min(Math.max(targetGain, input.minGain), maxAllowedGain);
    const corridor = Math.max(0, input.postCalibrationCorridor);
    const dbCorridor = Math.max(0, input.postCalibrationDbCorridor);
    const dbLowerRatio = Math.pow(10, -dbCorridor / 20);
    const dbUpperRatio = Math.pow(10, dbCorridor / 20);
    if (!isCalibrating && this.calibrationAnchorGain === null) {
      const calibrationGain = isFinite(input.calibrationGain ?? NaN)
        ? input.calibrationGain as number
        : targetGain;
      const currentGain = Math.min(
        Math.max(input.currentGain, input.minGain),
        input.maxGain
      );
      const minimumAnchor = Math.max(
        input.minGain,
        currentGain - corridor,
        currentGain / dbUpperRatio
      );
      const maximumAnchor = Math.min(
        input.maxGain,
        currentGain + corridor,
        currentGain / dbLowerRatio
      );
      this.calibrationAnchorGain = Math.min(
        Math.max(calibrationGain, minimumAnchor),
        Math.max(minimumAnchor, maximumAnchor)
      );
    }
    if (!isCalibrating && this.calibrationAnchorGain !== null) {
      const dbLower = this.calibrationAnchorGain * dbLowerRatio;
      const dbUpper = this.calibrationAnchorGain * dbUpperRatio;
      const lower = Math.max(this.calibrationAnchorGain - corridor, dbLower);
      const upper = Math.min(this.calibrationAnchorGain + corridor, dbUpper);
      desiredGain = Math.min(
        Math.max(desiredGain, lower),
        upper
      );
      desiredGain = Math.min(desiredGain, maxAllowedGain);
    }
    return desiredGain;
  }

  private slewLimitGain(
    input: AgcUpdateInput,
    currentGain: number,
    desiredGain: number,
    riseScale: number,
    isCalibrating = false
  ): number {
    // 校准期以用户设置的速率快速收敛；校准完成后受 MAX_GAIN_CHANGE_PER_SEC 硬上限约束，
    // 升压与衰减均不超过 0.1x/分钟（升压仍按置信度 riseScale 进一步降速）。
    const maxRate = isCalibrating
      ? Math.max(0, input.gainChangePerSec)
      : Math.max(0, Math.min(input.gainChangePerSec, MAX_GAIN_CHANGE_PER_SEC));
    const deltaLimit = maxRate * input.deltaSec;
    if (desiredGain > currentGain) {
      if (!isCalibrating) {
        return Math.min(desiredGain, currentGain + deltaLimit * riseScale);
      }
      const dbLimitedGain = currentGain * Math.pow(
        10,
        MAX_BOOST_DB_PER_SEC * input.deltaSec * riseScale / 20
      );
      return Math.min(desiredGain, currentGain + deltaLimit * riseScale, dbLimitedGain);
    }
    if (!isCalibrating) {
      return Math.max(desiredGain, currentGain - deltaLimit);
    }
    const dbLimitedGain = currentGain * Math.pow(
      10,
      -CALIBRATION_ATTENUATION_DB_PER_SEC * input.deltaSec / 20
    );
    return Math.max(desiredGain, currentGain - deltaLimit * 3, dbLimitedGain);
  }

  private classifyState(
    isPredicting: boolean,
    nextGain: number,
    currentGain: number
  ): AgcUpdateResult['state'] {
    if (isPredicting) return 'cold-start';
    if (nextGain < currentGain) return 'attenuate';
    if (nextGain > currentGain) return 'boost';
    return 'hold';
  }
}

function calculateGainForLoudness(currentLufs: number, targetLufs: number): number {
  if (!isFinite(currentLufs) || !isFinite(targetLufs)) return 1;
  return Math.pow(10, (targetLufs - currentLufs) / 20);
}
