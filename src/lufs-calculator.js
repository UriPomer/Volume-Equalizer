/**
 * LUFS/RMS 转换工具
 */

/**
 * RMS 转 LUFS 近似计算 (用于显示)
 * @param {number} rms - RMS 值
 * @returns {number} LUFS 值
 */
export function rmsToLufs(rms) {
  if (rms <= 0.00001) return -70;
  return 20 * Math.log10(rms) - 0.691;
}

/**
 * LUFS 转 RMS (用于设置目标值)
 * @param {number} lufs - LUFS 值
 * @returns {number} RMS 值
 */
export function lufsToRms(lufs) {
  return Math.pow(10, (lufs + 0.691) / 20);
}

/**
 * 限制值在指定范围内
 * @param {number} value - 要限制的值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 限制后的值
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
