/**
 * 配置文件 - 常量和默认设置
 */

export const BRAND = '[Universal Volume EQ]';
export const PANEL_ID = 'universal-volume-eq-panel';
export const TARGET_SELECTOR = 'video, audio';
export const INITIAL_GAIN = 0.5;

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
  minGain: 0.25,     // 最多衰减约 12 dB；超出可达范围时提示倍率限制
  maxGain: 2.0,      // 最大增益；末端另做削波保护
  bassBoost: 0,              // 低频增益 (dB: -6 ~ +6)
  gainChangePerSec: 0.2      // 最大增益变化速度 (x/秒)，慢速调整保留动态
};

