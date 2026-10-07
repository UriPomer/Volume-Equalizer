export type ProcessingStatus = 'realtime' | 'attach-failed' | 'processor-unavailable';

export interface MeterState {
  originalIntegratedLufs: number;
  outputIntegratedLufs: number;
  phase: import('./gain-control').AgcPhase;
  gainLimited: boolean;
  originalMomentaryLufs: number;
  momentaryLufs: number;
  safetyGain: number;
  maximumMomentaryLufs: number;
  maximumShortTermLufs: number;
  gain: number;
  sampleCount: number;
  processingStatus: ProcessingStatus;
}

export const EMPTY_METER_STATE: MeterState = {
  originalIntegratedLufs: NaN,
  outputIntegratedLufs: NaN,
  phase: 'collecting',
  gainLimited: false,
  originalMomentaryLufs: NaN,
  momentaryLufs: NaN,
  safetyGain: 1,
  maximumMomentaryLufs: NaN,
  maximumShortTermLufs: NaN,
  gain: 1,
  sampleCount: 0,
  processingStatus: 'realtime'
};
