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
  programmeLufs: number;
  outputProgrammeLufs: number;
  originalIntegratedLufs: number;
  outputIntegratedLufs: number;
  phase: import('./gain-control').AgcPhase;
  gainLimited: boolean;
  recalibrations: number;
  originalMomentaryLufs: number;
  momentaryLufs: number;
  safetyGain: number;
  rms: number;
  integratedRms: number;
  originalRms: number;
  originalIntegratedRms: number;
  gain: number;
  sampleCount: number;
  analysisStatus: AnalysisStatus;
}

export const EMPTY_METER_STATE: MeterState = {
  programmeLufs: NaN,
  outputProgrammeLufs: NaN,
  originalIntegratedLufs: NaN,
  outputIntegratedLufs: NaN,
  phase: 'collecting',
  gainLimited: false,
  recalibrations: 0,
  originalMomentaryLufs: NaN,
  momentaryLufs: NaN,
  safetyGain: 1,
  rms: 0,
  integratedRms: 0,
  originalRms: 0,
  originalIntegratedRms: 0,
  gain: 1,
  sampleCount: 0,
  analysisStatus: 'realtime'
};
