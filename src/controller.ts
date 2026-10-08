import { createMediaMeter, ensureAudioContext, ensureMediaSource, releaseMediaSource } from './audio-context';
import { getAudioOutput, SharedAudioOutput } from './audio-output';
import { INITIAL_GAIN, Settings } from './config';
import { AgcUpdateResult, RealtimeAgc } from './gain-control';
import { warnFailure } from './logger';
import { LoudnessMeter } from './loudness-meter';
import { clamp, rmsToLufs } from './lufs-calculator';
import { EMPTY_METER_STATE, MeterState } from './types';

type MeterMessage = {
  type: 'meter';
  epoch: number;
  original: Float32Array[];
};

export class MediaVolumeController {
  private readonly media: HTMLMediaElement;
  private readonly onMeter: (state: MeterState) => void;
  private readonly onActivate: () => void;
  private settings: Settings;
  private readonly context: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly gain: GainNode;
  private readonly bass: BiquadFilterNode;
  private processor: AudioWorkletNode | null = null;
  private originalMeter: LoudnessMeter;
  private readonly output: SharedAudioOutput;
  private readonly releaseOutput: () => void;
  private agc = new RealtimeAgc();
  private meterEpoch = 0;
  private rafId = 0;
  private gainState: AgcUpdateResult = { nextGain: 1, phase: 'collecting', referenceLufs: NaN, limited: false };
  private destroyed = false;
  private mediaKey = '';

  private readonly onEmptied = () => {
    this.mediaKey = this.currentMediaKey();
    this.setGain(INITIAL_GAIN);
    this.invalidateMeasurements();
  };

  private readonly onPlay = () => {
    this.refreshMediaIdentity();
    this.onActivate();
    this.context.resume().catch((error) => {
      warnFailure('media-play-resume', 'AudioContext play resume failed', error);
    });
  };

  private readonly onLoadedMetadata = () => { this.refreshMediaIdentity(); };
  private readonly onPlaybackIdle = () => { this.onIdle?.(); };
  private readonly onSeeked = () => {
    // Same-media seeks clear discontinuous live windows, retaining the
    // integrated control reference and current gain.
    this.invalidateMeasurements(false);
  };

  constructor(
    media: HTMLMediaElement,
    settings: Settings,
    onMeter: (state: MeterState) => void,
    onActivate: () => void,
    private readonly onIdle?: () => void
  ) {
    this.media = media;
    this.mediaKey = this.currentMediaKey();
    this.settings = settings;
    this.onMeter = onMeter;
    this.onActivate = onActivate;
    this.context = ensureAudioContext();
    this.source = ensureMediaSource(media);
    this.gain = this.context.createGain();
    this.bass = this.context.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 200;
    this.bass.gain.value = settings.bassBoost;
    this.originalMeter = new LoudnessMeter(this.context.sampleRate, Infinity);
    this.output = getAudioOutput(this.context, rmsToLufs(settings.targetRms));
    this.releaseOutput = this.output.retain(() => this.restoreOriginal());
    this.output.updateSettings(rmsToLufs(settings.targetRms), settings.enabled);

    this.bindEvents();
    this.connectGraph();
    this.loadProcessor();
    if (!media.paused) this.onPlay();
    this.tick = this.tick.bind(this);
    this.rafId = requestAnimationFrame(this.tick);
  }

  updateSettings(next: Settings): void {
    const previous = this.settings;
    this.settings = next;
    this.bass.gain.value = next.bassBoost;
    this.output.updateSettings(rmsToLufs(next.targetRms), next.enabled);

    if (previous.enabled !== next.enabled) {
      this.setGain(INITIAL_GAIN);
      this.invalidateMeasurements();
      this.connectGraph();
    }

    if (previous.targetRms !== next.targetRms || previous.bassBoost !== next.bassBoost) {
      this.invalidateMeasurements(previous.bassBoost !== next.bassBoost);
      this.agc.recalibrate();
    }
    if (previous.minGain !== next.minGain || previous.maxGain !== next.maxGain) {
      this.agc.recalibrate();
      this.setGain(this.gain.gain.value);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.media.removeEventListener('emptied', this.onEmptied);
    this.media.removeEventListener('play', this.onPlay);
    this.media.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    this.media.removeEventListener('seeked', this.onSeeked);
    this.media.removeEventListener('pause', this.onPlaybackIdle);
    this.media.removeEventListener('ended', this.onPlaybackIdle);
    this.disconnectGraph();
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor = null;
    }
    this.releaseOutput();
    releaseMediaSource(this.media);
  }

  private bindEvents(): void {
    this.media.addEventListener('emptied', this.onEmptied);
    this.media.addEventListener('play', this.onPlay);
    this.media.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.media.addEventListener('seeked', this.onSeeked);
    this.media.addEventListener('pause', this.onPlaybackIdle);
    this.media.addEventListener('ended', this.onPlaybackIdle);
  }

  private loadProcessor(): void {
    this.output.ready.then(() => {
      if (this.destroyed) return;
      if (!this.output.isReady()) throw new Error('Mixed output protection unavailable');
      const node = createMediaMeter(this.context);
      node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        if (event.data?.type === 'meter') this.consumeAudio(event.data);
      };
      node.onprocessorerror = (error) => {
        warnFailure('audio-processor', 'Audio processor failed', error);
        if (this.processor === node) this.restoreOriginal();
      };
      this.processor = node;
      this.setGain(INITIAL_GAIN);
      this.invalidateMeasurements();
      this.connectGraph();
    }).catch((error) => {
      if (this.destroyed) return;
      this.restoreOriginal();
      warnFailure(
        'audio-processor-load',
        'AudioWorklet load failed; playing original audio',
        error
      );
    });
  }

  private restoreOriginal(): void {
    if (this.destroyed) return;
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.invalidateMeasurements();
    this.connectGraph();
  }

  private connectGraph(): void {
    if (this.destroyed) return;
    this.disconnectGraph();
    if (!this.settings.enabled) {
      this.source.connect(this.context.destination);
      return;
    }
    if (this.processor && this.output.isReady()) {
      this.source.connect(this.bass);
      this.bass.connect(this.gain);
      this.gain.connect(this.processor, 0, 0);
      this.bass.connect(this.processor, 0, 1);
      this.output.connect(this.processor);
      return;
    }
    // While loading or after failure, bypass both gain and bass. Never retain
    // an unprotected boost or replace the original media with permanent silence.
    this.setGain(1);
    this.source.connect(this.context.destination);
  }

  private disconnectGraph(): void {
    for (const node of [
      this.source,
      this.gain,
      this.bass,
      this.processor
    ]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
  }

  private consumeAudio(message: MeterMessage): void {
    if (!this.destroyed) this.refreshMediaIdentity();
    if (
      this.destroyed
      || !this.settings.enabled
      || !this.processor
      || !this.output.isReady()
      || message.epoch !== this.meterEpoch
      || !message.original.length
    ) return;
    this.originalMeter.processChannels(message.original);
    const duration = message.original[0].length / this.context.sampleRate;
    if (!this.media.muted && !this.media.paused && !this.media.ended) {
      this.updateGain(duration);
    }
  }

  private tick(): void {
    if (this.destroyed) return;
    if (document.hidden) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.emitMeter();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private updateGain(deltaSec: number): void {
    this.gainState = this.agc.update({
      currentGain: this.gain.gain.value,
      minGain: this.settings.minGain,
      maxGain: this.settings.maxGain,
      deltaSec,
      targetLufs: rmsToLufs(this.settings.targetRms),
      integratedLufs: this.originalMeter.getIntegratedLoudness(),
      momentaryLufs: this.originalMeter.getMomentaryLoudness(),
      gainChangePerSec: this.settings.gainChangePerSec
    });
    this.setGain(this.gainState.nextGain);
  }

  private emitMeter(): void {
    if (!this.settings.enabled) {
      this.onMeter({ ...EMPTY_METER_STATE });
      return;
    }
    if (!this.processor || !this.output.isReady()) {
      this.onMeter({ ...EMPTY_METER_STATE, processingStatus: 'processor-unavailable' });
      return;
    }
    const originalLufs = this.originalMeter.getIntegratedLoudness();
    const output = this.output.getState();
    this.onMeter({
      ...output,
      originalMomentaryLufs: this.originalMeter.getMomentaryLoudness(),
      phase: this.gainState.phase,
      gainLimited: this.gainState.limited,
      originalIntegratedLufs: originalLufs,
      gain: this.gain.gain.value * output.safetyGain,
      sampleCount: Math.floor(this.originalMeter.getIntegrationTime()),
      processingStatus: 'realtime'
    });
  }

  private setGain(value: number): void {
    const gain = !this.processor || !this.output.isReady() ? 1
      : clamp(value, this.settings.minGain, this.settings.maxGain);
    const time = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(time);
    this.gain.gain.setValueAtTime(gain, time);
  }

  private resetMeters(resetAgc = true): void {
    this.originalMeter.reset({ preserveIntegrated: !resetAgc });
    this.output.resetForMedia(!resetAgc);
    if (resetAgc) {
      this.agc.reset();
      this.gainState = { nextGain: this.gain.gain.value, phase: 'collecting', referenceLufs: NaN, limited: false };
    }
  }

  private invalidateMeasurements(resetAgc = true): void {
    this.meterEpoch++;
    this.processor?.port.postMessage({ type: 'reset-meter', epoch: this.meterEpoch });
    this.resetMeters(resetAgc);
  }

  private currentMediaKey(): string {
    const source = this.media.currentSrc || this.media.src || 'inline-media';
    // Bilibili can reuse a media element/MediaSource across SPA navigation.
    const route = typeof location !== 'undefined'
      && /(^|\.)bilibili\.com$/.test(location.hostname)
      ? location.pathname + '?p=' + (new URLSearchParams(location.search).get('p') || '1') : '';
    return source + '|' + route;
  }

  private refreshMediaIdentity(): void {
    if (this.currentMediaKey() !== this.mediaKey) this.onEmptied();
  }

}
