/**
 * 配置文件 - 常量和默认设置
 */

export const BRAND = '[Universal Volume EQ]';
export const PANEL_ID = 'universal-volume-eq-panel';
export const DATASET_FLAG = 'universalVolumeEqAttached';
export const TARGET_SELECTOR = 'video, audio';

export interface Settings {
  enabled: boolean;
  targetRms: number;
  minGain: number;
  maxGain: number;
  compressorThreshold: number;
  compressorKnee: number;
  compressorRatio: number;
  compressorAttack: number;
  compressorRelease: number;
  bassBoost: number;
  gainChangePerSec: number;
  _changedField?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetRms: 0.1363,  // 对应 -18 LUFS (10^((-18+0.691)/20))
  minGain: 0.5,      // 最小增益 (避免过度压缩)
  maxGain: 2.0,      // 最大增益 (避免失真)
  compressorThreshold: -20,  // 压缩器阈值 (dB)
  compressorKnee: 20,        // 压缩器拐点柔和度
  compressorRatio: 3,        // 压缩比 (3:1)
  compressorAttack: 0.003,   // 压缩器启动时间 (秒)
  compressorRelease: 0.3,    // 压缩器释放时间 (秒)
  bassBoost: 0,              // 低频增益 (dB: -6 ~ +6)
  gainChangePerSec: 0.2      // 最大增益变化速度 (x/秒)，慢速调整保留动态
};

export interface IntegrationParams {
  minIntegrationSeconds: number;
  coldStartSeconds: number;
  silenceThreshold: number;
}

// 积分响度参数 (ITU-R BS.1770-4 标准)
export const INTEGRATION_PARAMS: IntegrationParams = {
  // 标准算法使用 400ms 块 + 75% 重叠，由 LoudnessMeter 内部处理
  minIntegrationSeconds: 1,           // 启动增益控制前的最小积分时长（1秒 = ~10个块）
  coldStartSeconds: 3,                // 前几秒只允许降增益，不允许预测放大
  silenceThreshold: 0.001             // 静音阈值 (低于此值不送入响度测量)
};

