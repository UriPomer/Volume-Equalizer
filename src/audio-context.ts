/**
 * AudioContext 管理
 */

import { warnFailure } from './logger';

const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

let audioCtx: AudioContext | null = null;
const mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const releasedSources = new WeakMap<HTMLMediaElement, () => void>();
const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();

export function loadAudioWorklets(context: BaseAudioContext): Promise<void> {
  let promise = workletModules.get(context);
  if (!promise) {
    promise = context.audioWorklet.addModule(chrome.runtime.getURL('limiter-worklet.js')).catch(error => {
      workletModules.delete(context);
      throw error;
    });
    workletModules.set(context, promise);
  }
  return promise;
}

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
  // Reacquiring an element transfers audio ownership back to its controller.
  releasedSources.get(media)?.();
  let source = mediaSources.get(media);
  if (!source) {
    source = ensureAudioContext().createMediaElementSource(media);
    mediaSources.set(media, source);
  }
  return source;
}

/** createMediaElementSource permanently redirects native playback. Releasing
 * a controller must restore original playback, including a later detached play.
 * Pause/ended disconnect that fallback; reacquisition removes its listeners. */
export function releaseMediaSource(media: HTMLMediaElement): void {
  const source = mediaSources.get(media);
  if (!source) return;
  releasedSources.get(media)?.();
  const stop = () => {
    try { source.disconnect(source.context.destination); } catch { /* not connected */ }
  };
  const play = () => {
    source.connect(source.context.destination);
    (source.context as AudioContext).resume().catch(error => {
      warnFailure('released-media-resume', 'Original audio resume failed', error);
    });
  };
  const cleanup = () => {
    media.removeEventListener('play', play);
    media.removeEventListener('pause', stop);
    media.removeEventListener('ended', stop);
    stop();
    releasedSources.delete(media);
  };
  releasedSources.set(media, cleanup);
  media.addEventListener('play', play);
  media.addEventListener('pause', stop);
  media.addEventListener('ended', stop);
  if (!media.paused && !media.ended) play();
}

/** Match the destination before measuring/limiting, so a later up/downmix
 * cannot increase loudness after the safety guard. */
export function createAudioProcessor(context: BaseAudioContext): AudioWorkletNode {
  const channels = context.destination.channelCount;
  return new AudioWorkletNode(context, 'lookahead-peak-limiter', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: {
      lookaheadMs: 15, releaseMs: 50,
      ceiling: 0.8912509381337456, interSampleMargin: 1.03
    }
  });
}

/** Per-media measurement only; safety belongs to the shared mixed output. */
export function createMediaMeter(context: BaseAudioContext): AudioWorkletNode {
  return new AudioWorkletNode(context, 'media-input-meter', {
    numberOfInputs: 2, numberOfOutputs: 1,
    outputChannelCount: [context.destination.channelCount],
    channelCount: context.destination.channelCount,
    channelCountMode: 'explicit', channelInterpretation: 'speakers'
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
