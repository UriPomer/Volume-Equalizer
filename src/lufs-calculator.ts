/**
 * LUFS/RMS 转换工具
 */

/**
 * RMS 转 LUFS 近似计算 (用于显示)
 */
export function rmsToLufs(rms: number): number {
  if (rms <= 0.00001) return -70;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS (用于设置目标值)
 */
export function lufsToRms(lufs: number): number {
  return Math.pow(10, (lufs + 0.691) / 20);
}

/**
 * 限制值在指定范围内
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
