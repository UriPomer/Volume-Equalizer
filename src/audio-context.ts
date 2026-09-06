/**
 * AudioContext 管理
 */

import { warnFailure } from './logger';

const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

let audioCtx: AudioContext | null = null;
const mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/**
 * 获取或创建全局 AudioContext
 */
export function ensureAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

export function ensureMediaSource(media: HTMLMediaElement): MediaElementAudioSourceNode {
  let source = mediaSources.get(media);
  if (!source) {
    source = ensureAudioContext().createMediaElementSource(media);
    mediaSources.set(media, source);
  }
  return source;
}

/** Match the destination before measuring/limiting, so a later up/downmix
 * cannot increase loudness after the safety guard. */
export function createAudioProcessor(context: BaseAudioContext, targetLufs: number): AudioWorkletNode {
  const channels = context.destination.channelCount;
  return new AudioWorkletNode(context, 'lookahead-peak-limiter', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: {
      targetLufs, lookaheadMs: 15, releaseMs: 50,
      ceiling: 0.8912509381337456, interSampleMargin: 1.03
    }
  });
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
