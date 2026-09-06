class LookaheadPeakLimiterProcessor extends AudioWorkletProcessor {
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
    this.writeIndex = 0;
    this.delayLines = [];
    this.previousSamples = [];
    this.gainLine = new Float32Array(this.lookaheadSamples);
    this.gainLine.fill(1);
    this.meterSize = Math.max(128, Math.round(sampleRate / 10));
    this.meterIndex = 0;
    this.originalMeter = [];
    this.outputMeter = [];
    this.meterEpoch = 0;
    this.meterMinimumGain = 1;
    this.meterLimitedFrames = 0;
    this.meterFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'reset-meter') return;
      this.meterEpoch = Number.isFinite(event.data.epoch) ? event.data.epoch : 0;
      this.resetMeter();
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const original = inputs[1] && inputs[1].length ? inputs[1] : input;
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    this.ensureDelayLines(Math.max(input.length, output.length));
    this.ensureMeterBuffers(original.length, output.length);

    const frames = output[0].length;
    const channelCount = output.length;

    for (let frame = 0; frame < frames; frame++) {
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
        const guardedPeak = truePeak * this.interSampleMargin * 1.0001;
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
      this.meterMinimumGain = Math.min(this.meterMinimumGain, delayedGain);
      if (delayedGain < 1) this.meterLimitedFrames++;
      this.meterFrames++;

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

      this.writeIndex = readIndex;
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
        limitedFrames: this.meterLimitedFrames,
        frames: this.meterFrames,
        original,
        output
      }, transfers);
    }
    this.resetMeter();
  }

  resetMeter() {
    this.meterIndex = 0;
    this.meterMinimumGain = 1;
    this.meterLimitedFrames = 0;
    this.meterFrames = 0;
    this.originalMeter.forEach((channel) => channel.fill(0));
    this.outputMeter.forEach((channel) => channel.fill(0));
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
