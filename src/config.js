/**
 * 配置文件 - 常量和默认设置
 */

export const BRAND = '[Universal Volume EQ]';
export const PANEL_ID = 'universal-volume-eq-panel';
export const DATASET_FLAG = 'universalVolumeEqAttached';
export const TARGET_SELECTOR = 'video, audio';

export const DEFAULT_SETTINGS = {
  enabled: true,
  targetRms: 0.1924,  // 对应 -15 LUFS (YouTube标准, 实际计算: 10^((-15+0.691)/20))
  minGain: 0.5,      // 最小增益 (避免过度压缩)
  maxGain: 2.0,      // 最大增益 (避免失真)
  compressorThreshold: -20,  // 压缩器阈值 (dB)
  compressorKnee: 20,        // 压缩器拐点柔和度
  compressorRatio: 3,        // 压缩比 (3:1)
  compressorAttack: 0.003,   // 压缩器启动时间 (秒)
  compressorRelease: 0.3,    // 压缩器释放时间 (秒)
  bassBoost: 0               // 低频增益 (dB: -6 ~ +6)
};

// PID 控制器参数
export const PID_PARAMS = {
  Kp: 0.15,  // 比例系数：响应速度
  Ki: 0.005, // 积分系数：消除稳态误差
  Kd: 0.08,  // 微分系数：抑制震荡
  integralLimit: 5  // 积分抗饱和限制
};

// 积分响度参数
export const INTEGRATION_PARAMS = {
  maxHistorySize: 600,  // 滑动窗口大小 (约10秒@60fps)
  minSamples: 30,       // 启动PID前的最少样本数
  silenceThreshold: 0.001  // 静音阈值 (低于此值不计入积分)
};
