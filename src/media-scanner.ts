/**
 * 媒体扫描器 - 检测页面上的 video/audio 元素并附加控制器
 */

import { TARGET_SELECTOR, DATASET_FLAG, BRAND } from './config';

let scanScheduled = false;

/**
 * 扫描页面上的媒体元素
 */
export function scanForMedia(
  attachCallback: (media: HTMLMediaElement) => void,
  cleanupCallback: () => void
): void {
  document.querySelectorAll(TARGET_SELECTOR).forEach((media) => {
    tryAttachController(media as HTMLMediaElement, attachCallback);
  });

  if (cleanupCallback) {
    cleanupCallback();
  }
}

/**
 * 尝试为媒体元素附加控制器
 */
function tryAttachController(
  media: HTMLMediaElement,
  attachCallback: (media: HTMLMediaElement) => void
): void {
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
 */
export function scheduleScan(scanCallback: () => void): void {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanCallback();
  });
}

/**
 * 观察 DOM 变化并自动扫描新的媒体元素
 */
export function observeMutations(scanCallback: () => void): void {
  const observer = new MutationObserver(() => scheduleScan(scanCallback));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}
