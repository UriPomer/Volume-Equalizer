export type AnalysisStatus =
  | 'realtime'
  | 'waiting-metadata'
  | 'waiting-play'
  | 'attach-failed'
  | 'analyzing'
  | 'full-track'
  | 'incomplete'
  | 'unsupported'
  | 'processor-unavailable'
  | 'failed';

export interface MeterState {
  originalIntegratedLufs: number;
  outputIntegratedLufs: number;
  phase: import('./gain-control').AgcPhase;
  gainLimited: boolean;
  originalMomentaryLufs: number;
  momentaryLufs: number;
  safetyGain: number;
  loudnessGain: number;
  maximumMomentaryLufs: number;
  maximumShortTermLufs: number;
  gain: number;
  sampleCount: number;
  analysisStatus: AnalysisStatus;
}

export const EMPTY_METER_STATE: MeterState = {
  originalIntegratedLufs: NaN,
  outputIntegratedLufs: NaN,
  phase: 'collecting',
  gainLimited: false,
  originalMomentaryLufs: NaN,
  momentaryLufs: NaN,
  safetyGain: 1,
  loudnessGain: 1,
  maximumMomentaryLufs: NaN,
  maximumShortTermLufs: NaN,
  gain: 1,
  sampleCount: 0,
  analysisStatus: 'realtime'
};
