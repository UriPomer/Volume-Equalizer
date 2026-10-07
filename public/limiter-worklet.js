import { LoudnessCeiling } from '../src/loudness-ceiling';

class LookaheadPeakLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'loudnessCeilingLufs', defaultValue: -19, minValue: -68, maxValue: 2, automationRate: 'k-rate' },
      { name: 'programmeGain', defaultValue: 1, minValue: 0, maxValue: 32, automationRate: 'a-rate' }
    ];
  }

  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.ceiling = clampNumber(processorOptions.ceiling, 0.1, 1, 0.8912509381337456);
    this.interSampleMargin = clampNumber(processorOptions.interSampleMargin, 1, 1.1, 1.03);
    this.releaseMs = clampNumber(processorOptions.releaseMs, 5, 1000, 50);
    this.lookaheadSamples = Math.max(
      1,
      Math.round(sampleRate * clampNumber(processorOptions.lookaheadMs, 1, 50, 15) / 1000)
    );
    this.releaseCoeff = Math.exp(-1 / (sampleRate * this.releaseMs / 1000));
    this.gain = 1;
    this.loudnessCeiling = new LoudnessCeiling(sampleRate);
    this.peakGains = new Float32Array(128);
    this.programmeGains = new Float32Array(128);
    this.writeIndex = 0;
    this.delayLines = [];
    this.previousSamples = [];
    this.gainLine = new Float32Array(this.lookaheadSamples);
    this.gainLine.fill(1);
    this.programmeLine = new Float32Array(this.lookaheadSamples);
    this.programmeLine.fill(1);
    this.meterSize = Math.max(128, Math.round(sampleRate / 10));
    this.meterIndex = 0;
    this.originalMeter = [];
    this.outputMeter = [];
    this.meterEpoch = 0;
    this.meterMinimumGain = 1;
    this.meterMinimumLoudnessGain = 1;
    this.meterLoudnessLimitedFrames = 0;
    this.meterLimitedFrames = 0;
    this.pendingMeterReset = null;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'reset-meter') return;
      if (Number.isFinite(event.data.loudnessCeilingLufs)) {
        this.pendingMeterReset = event.data;
        return;
      }
      this.meterEpoch = Number.isFinite(event.data.epoch) ? event.data.epoch : 0;
      this.resetMeter();
    };
  }

  process(inputs, outputs, parameters) {
    const ceiling = parameters?.loudnessCeilingLufs?.[0] ?? -19;
    const programmeGain = Math.max(.000001, parameters?.programmeGain?.[0] ?? 1);
    let restart = this.loudnessCeiling.setCeiling(ceiling);
    // Couple the new meter epoch to the audio parameter becoming effective;
    // messages containing old-target samples must not enter the new maxima.
    if (this.pendingMeterReset && Math.abs(ceiling - this.pendingMeterReset.loudnessCeilingLufs) < 1e-4) {
      this.meterEpoch = this.pendingMeterReset.epoch;
      restart ||= this.pendingMeterReset.resetProtection === true;
      this.pendingMeterReset = null;
      this.resetMeter();
    }
    if (restart) {
      this.loudnessCeiling.restart();
      this.gain = 1;
      this.gainLine.fill(1);
      this.programmeLine.fill(programmeGain);
      for (const line of this.delayLines) line.fill(0);
      for (const history of this.previousSamples) history.fill(0);
    }
    const input = inputs[0] || [];
    const original = inputs[1] && inputs[1].length ? inputs[1] : input;
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // A stopped source has no input channels. Render silence through the delay
    // line so its last samples reach the destination instead of being cut off.
    this.ensureDelayLines(Math.max(input.length, output.length));
    this.ensureMeterBuffers(original.length || this.originalMeter.length || output.length, output.length);

    const frames = output[0].length;
    const channelCount = output.length;
    if (this.peakGains.length < frames) {
      this.peakGains = new Float32Array(frames);
      this.programmeGains = new Float32Array(frames);
    }

    for (let frame = 0; frame < frames; frame++) {
      const frameProgrammeGain = Math.max(.000001, parameters?.programmeGain?.[frame] ?? programmeGain);
      // The retained source ceiling only decreases. Detect at its normalized
      // level, avoiding clipping PCM that final loudness protection makes safe.
      const normalizationGain = this.loudnessCeiling.getGain(frameProgrammeGain);
      let linkedPeak = 0;

      for (let channel = 0; channel < channelCount; channel++) {
        const inputChannel = input[channel] || input[0];
        const candidate = inputChannel ? inputChannel[frame] : 0;
        // A malformed source must not poison the delay line, peak history, or
        // release state forever. Treat non-finite PCM as silence at the edge.
        const sample = Number.isFinite(candidate) ? candidate : 0;
        const history = this.previousSamples[channel];
        const truePeak = Math.max(
          Math.abs(sample),
          this.estimateCubicPeak(history[0], history[1], history[2], sample)
        );
        const guardedPeak = truePeak * normalizationGain * this.interSampleMargin * 1.0001;
        if (guardedPeak > linkedPeak) linkedPeak = guardedPeak;
        this.delayLines[channel][this.writeIndex] = sample;
        history[0] = history[1];
        history[1] = history[2];
        history[2] = sample;
      }

      const targetGain = linkedPeak > this.ceiling ? this.ceiling / linkedPeak : 1;
      if (targetGain < this.gain) {
        this.gain = targetGain;
      } else {
        this.gain = Math.min(1, targetGain + (this.gain - targetGain) * this.releaseCoeff);
      }
      this.gainLine[this.writeIndex] = this.gain;
      this.programmeLine[this.writeIndex] = frameProgrammeGain;
      const previousIndex = (this.writeIndex - 1 + this.lookaheadSamples) % this.lookaheadSamples;
      const prePreviousIndex = (this.writeIndex - 2 + this.lookaheadSamples) % this.lookaheadSamples;
      this.gainLine[previousIndex] = Math.min(this.gainLine[previousIndex], this.gain);
      this.gainLine[prePreviousIndex] = Math.min(this.gainLine[prePreviousIndex], this.gain);

      const readIndex = (this.writeIndex + 1) % this.lookaheadSamples;
      const delayedGain = this.gainLine[readIndex];
      for (let channel = 0; channel < channelCount; channel++) {
        const delayedSample = this.delayLines[channel][readIndex];
        output[channel][frame] = Number.isFinite(delayedSample) && Number.isFinite(delayedGain)
          ? delayedSample * delayedGain : 0;
      }
      this.peakGains[frame] = delayedGain;
      this.programmeGains[frame] = this.programmeLine[readIndex];
      this.writeIndex = readIndex;
    }

    const loudnessGain = this.loudnessCeiling.process(output, ceiling, this.programmeGains);
    for (let frame = 0; frame < frames; frame++) {
      this.meterMinimumGain = Math.min(this.meterMinimumGain, this.peakGains[frame]);
      this.meterMinimumLoudnessGain = Math.min(this.meterMinimumLoudnessGain, loudnessGain);
      if (this.peakGains[frame] < 1) this.meterLimitedFrames++;
      if (loudnessGain < .999) this.meterLoudnessLimitedFrames++;

      for (let channel = 0; channel < this.originalMeter.length; channel++) {
        const originalChannel = original[channel];
        const sample = originalChannel?.[frame];
        this.originalMeter[channel][this.meterIndex] = Number.isFinite(sample) ? sample : 0;
      }
      for (let channel = 0; channel < this.outputMeter.length; channel++) {
        const outputChannel = output[channel];
        const sample = outputChannel?.[frame];
        this.outputMeter[channel][this.meterIndex] = Number.isFinite(sample) ? sample : 0;
      }
      this.meterIndex++;
      if (this.meterIndex === this.meterSize) this.flushMeter();

    }

    return true;
  }

  ensureDelayLines(channelCount) {
    while (this.delayLines.length < channelCount) {
      this.delayLines.push(new Float32Array(this.lookaheadSamples));
      this.previousSamples.push(new Float32Array(3));
    }
  }

  ensureMeterBuffers(originalChannels, outputChannels) {
    if (this.originalMeter.length === originalChannels
      && this.outputMeter.length === outputChannels) return;
    // A layout change must not leave phantom surround/LFE channels in meters.
    this.originalMeter = Array.from({ length: originalChannels }, () => new Float32Array(this.meterSize));
    this.outputMeter = Array.from({ length: outputChannels }, () => new Float32Array(this.meterSize));
    this.resetMeter();
  }

  flushMeter() {
    if (this.port && this.port.postMessage) {
      const original = this.originalMeter.map((channel) => channel.slice());
      const output = this.outputMeter.map((channel) => channel.slice());
      const transfers = [...original, ...output].map((channel) => channel.buffer);
      this.port.postMessage({
        type: 'meter',
        epoch: this.meterEpoch,
        safetyGain: this.meterMinimumGain,
        loudnessGain: this.meterMinimumLoudnessGain,
        loudnessLimitedFrames: this.meterLoudnessLimitedFrames,
        limitedFrames: this.meterLimitedFrames,
        frames: this.meterIndex,
        original,
        output
      }, transfers);
    }
    this.resetMeter();
  }

  resetMeter() {
    this.meterIndex = 0;
    this.meterMinimumGain = 1;
    this.meterMinimumLoudnessGain = 1;
    this.meterLoudnessLimitedFrames = 0;
    this.meterLimitedFrames = 0;
    // Each channel is overwritten completely before the next flush.
  }

  estimateCubicPeak(p0, p1, p2, p3) {
    let peak = 0;
    for (let step = 0; step < 4; step++) {
      const t = step / 4;
      const t2 = t * t;
      const t3 = t2 * t;
      const value = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
      if (Math.abs(value) > peak) peak = Math.abs(value);
    }
    return peak;
  }
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

registerProcessor('lookahead-peak-limiter', LookaheadPeakLimiterProcessor);

/** Pass programme PCM to the common output and measure this media's input.
 * There is no per-media limiter, filter preview or additional delay here. */
class MediaInputMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate / 10));
    this.index = 0;
    this.epoch = 0;
    this.channels = [];
    this.port.onmessage = event => {
      if (event.data?.type !== 'reset-meter') return;
      this.epoch = event.data.epoch;
      this.index = 0;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0], input = inputs[0] || [], original = inputs[1] || [];
    const frames = output[0]?.length || 128;
    if (this.channels.length !== original.length) {
      this.channels = Array.from({length:original.length}, () => new Float32Array(this.size));
      this.index = 0;
    }
    for (let channel = 0; channel < output.length; channel++) {
      if (input[channel]) output[channel].set(input[channel]);
      else output[channel].fill(0);
    }
    // A disconnected/paused source need not advance programme observations.
    if (!original.length) return true;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < original.length; channel++) {
        const value = original[channel][frame];
        this.channels[channel][this.index] = Number.isFinite(value) ? value : 0;
      }
      if (++this.index === this.size) {
        const pcm = this.channels.map(channel => channel.slice());
        this.port.postMessage({type:'meter',epoch:this.epoch,original:pcm},pcm.map(channel=>channel.buffer));
        this.index = 0;
      }
    }
    return true;
  }
}

registerProcessor('media-input-meter', MediaInputMeterProcessor);
