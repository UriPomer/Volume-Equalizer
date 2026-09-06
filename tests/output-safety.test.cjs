const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const code = require('./worklet-source.cjs')();

function render({ channels = 2, seconds = 1, sample, options = {} }) {
  let Processor;
  vm.runInNewContext(code, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor(_, value) { Processor = value; }
  });
  const processor = new Processor({ processorOptions: { lookaheadMs: 15, ...options } });
  const rendered = Array.from({ length: channels }, () => []);
  for (let start = 0; start < (seconds + .1) * 48000; start += 128) {
    const input = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: 128 }, (_, frame) =>
      start + frame < seconds * 48000 ? sample((start + frame) / 48000, channel) : 0));
    const output = Array.from({ length: channels }, () => new Float32Array(128));
    processor.process([input], [output]);
    output.forEach((channel, index) => rendered[index].push(...channel));
  }
  return rendered;
}

function peak(channels) {
  return channels.reduce((maximum, channel) => channel.reduce(
    (channelMaximum, sample) => Math.max(channelMaximum, Math.abs(sample)), maximum
  ), 0);
}

function rms(samples) {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

test('final PCM is finite and peak-safe for 1, 2, and 6 channel programme audio', () => {
  for (const channels of [1, 2, 6]) {
    const output = render({ channels, sample: (t, channel) =>
      1.8 * Math.sin(2 * Math.PI * (100 + channel * 300) * t) });
    assert.ok(output.flat().every(Number.isFinite));
    assert.ok(peak(output) <= .891251, `${channels}ch peak ${peak(output)}`);
  }
});

test('final PCM preserves a 20 dB input difference when no peak limiting is needed', () => {
  const quiet = render({ seconds: .5, sample: t => .01 * Math.sin(2 * Math.PI * 997 * t) })[0];
  const loud = render({ seconds: .5, sample: t => .1 * Math.sin(2 * Math.PI * 997 * t) })[0];
  const trim = Math.round(48000 * .03);
  const difference = 20 * Math.log10(rms(loud.slice(trim)) / rms(quiet.slice(trim)));
  assert.ok(Math.abs(difference - 20) <= .2, `output difference ${difference.toFixed(3)} dB`);
});

test('meter reset changes only meter epoch, not peak limiter audio state', () => {
  let Processor;
  vm.runInNewContext(code, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor(_, value) { Processor = value; }
  });
  const processor = new Processor({ processorOptions: { lookaheadMs: 15 } });
  const input = new Float32Array(128).fill(.8);
  const first = new Float32Array(128);
  processor.process([[input]], [[first]]);
  const gain = processor.gain;
  processor.port.onmessage({ data: { type: 'reset-meter', epoch: 2 } });
  const second = new Float32Array(128);
  processor.process([[input]], [[second]]);
  assert.equal(processor.meterEpoch, 2);
  assert.equal(processor.gain, gain);
  assert.ok(second.every(Number.isFinite));
});
