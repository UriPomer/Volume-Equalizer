import { TARGET_SELECTOR } from './config';
import { warnFailure } from './logger';

let scanScheduled = false;

export function scanForMedia(attach: (media: HTMLMediaElement) => void): void {
  document.querySelectorAll<HTMLMediaElement>(TARGET_SELECTOR).forEach((media) => {
    try {
      attach(media);
    } catch (error) {
      warnFailure('media-attach', '无法绑定媒体元素', error);
    }
  });
}

export function observeMutations(scan: () => void): void {
  new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
}
