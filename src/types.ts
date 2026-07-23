export type AnalysisStatus =
  | 'realtime'
  | 'waiting-metadata'
  | 'analyzing'
  | 'full-track'
  | 'incomplete'
  | 'unsupported'
  | 'processor-unavailable'
  | 'failed';

export interface MeterState {
  rms: number;
  integratedRms: number;
  originalRms: number;
  originalIntegratedRms: number;
  gain: number;
  sampleCount: number;
  analysisStatus: AnalysisStatus;
}

export const EMPTY_METER_STATE: MeterState = {
  rms: 0,
  integratedRms: 0,
  originalRms: 0,
  originalIntegratedRms: 0,
  gain: 1,
  sampleCount: 0,
  analysisStatus: 'realtime'
};
