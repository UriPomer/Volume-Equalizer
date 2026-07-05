/**
 * AudioContext 管理
 */

import { warnFailure } from './logger';

const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

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
          warnFailure('audio-context-resume', 'AudioContext resume failed', err);
        });
      }
    } catch (err) {
      warnFailure('audio-context-resume-handler', 'AudioContext resume handler failed', err);
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
