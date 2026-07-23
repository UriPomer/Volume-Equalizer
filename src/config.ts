/**
 * 配置文件 - 常量和默认设置
 */

export const BRAND = '[Universal Volume EQ]';
export const PANEL_ID = 'universal-volume-eq-panel';
export const TARGET_SELECTOR = 'video, audio';

export interface Settings {
  enabled: boolean;
  fullAudioAnalysis: boolean;
  targetRms: number;
  minGain: number;
  maxGain: number;
  bassBoost: number;
  gainChangePerSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  fullAudioAnalysis: false,
  targetRms: 0.09650504109445904,  // 对应 -21 LUFS
  minGain: 0.25,     // 最多衰减约 12 dB，保证高响度内容可接近 -21 LUFS
  maxGain: 2.0,      // 最大增益 (避免失真)
  bassBoost: 0,              // 低频增益 (dB: -6 ~ +6)
  gainChangePerSec: 0.2      // 最大增益变化速度 (x/秒)，慢速调整保留动态
};

export interface IntegrationParams {
  minIntegrationSeconds: number;
  coldStartSeconds: number;
  calibrationBoostStartSeconds: number;
  postCalibrationCorridor: number;
  postCalibrationDbCorridor: number;
}

// 积分响度参数 (ITU-R BS.1770-4 标准)
export const INTEGRATION_PARAMS: IntegrationParams = {
  // 标准算法使用 400ms 块 + 75% 重叠，由 LoudnessMeter 内部处理
  minIntegrationSeconds: 1,           // 启动增益控制前的最小积分时长（1秒 = ~10个块）
  coldStartSeconds: 10,
  calibrationBoostStartSeconds: 6,    // 前 6 秒最多恢复到 1x，避免安静片头触发放大
  postCalibrationCorridor: 0.2,       // 校准完成后限制在锚点 gain ±0.2x
  postCalibrationDbCorridor: 0.75     // 同时限制为 ±0.75 dB，保证常态总跨度不超过 1.5 dB
};

