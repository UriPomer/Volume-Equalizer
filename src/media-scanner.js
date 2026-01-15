/**
 * 媒体扫描器 - 检测页面上的 video/audio 元素并附加控制器
 */

import { TARGET_SELECTOR, DATASET_FLAG, BRAND } from './config.js';

let scanScheduled = false;

/**
 * 扫描页面上的媒体元素
 * @param {Function} attachCallback - 附加控制器的回调函数
 * @param {Function} cleanupCallback - 清理不存在元素的回调函数
 */
export function scanForMedia(attachCallback, cleanupCallback) {
  document.querySelectorAll(TARGET_SELECTOR).forEach((media) => {
    tryAttachController(media, attachCallback);
  });

  if (cleanupCallback) {
    cleanupCallback();
  }
}

/**
 * 尝试为媒体元素附加控制器
 * @param {HTMLMediaElement} media - 媒体元素
 * @param {Function} attachCallback - 附加控制器的回调函数
 */
function tryAttachController(media, attachCallback) {
  if (!(media instanceof HTMLMediaElement)) return;
  if (media.dataset[DATASET_FLAG] === '1') return;
  
  try {
    attachCallback(media);
    media.dataset[DATASET_FLAG] = '1';
  } catch (error) {
    console.warn(`${BRAND} 无法绑定媒体元素`, error);
  }
}

/**
 * 调度扫描 (防抖)
 * @param {Function} scanCallback - 扫描回调函数
 */
export function scheduleScan(scanCallback) {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanCallback();
  });
}

/**
 * 观察 DOM 变化并自动扫描新的媒体元素
 * @param {Function} scanCallback - 扫描回调函数
 */
export function observeMutations(scanCallback) {
  const observer = new MutationObserver(() => scheduleScan(scanCallback));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}
