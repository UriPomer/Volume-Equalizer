/**
 * AudioContext 管理
 */

import { BRAND } from './config';

const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

if (!AudioContextClass) {
  console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
}

let audioCtx: AudioContext | null = null;

/**
 * 获取或创建全局 AudioContext
 */
export function ensureAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

/**
 * 安装全局 AudioContext resume 处理器
 * 在用户交互时自动恢复 AudioContext
 */
export function installGlobalResumeHandlers(): void {
  const resume = () => {
    try {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch((err) => {
          console.debug(`${BRAND} AudioContext resume failed:`, err);
        });
      }
    } catch (err) {
      console.debug(`${BRAND} Resume handler error:`, err);
    }
  };

  (['pointerdown', 'keydown', 'click', 'touchstart'] as const).forEach((evt) => {
    document.addEventListener(evt, resume, { capture: true, passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
}

/**
 * 检查浏览器是否支持 Web Audio API
 */
export function isAudioContextSupported(): boolean {
  return !!AudioContextClass;
}
