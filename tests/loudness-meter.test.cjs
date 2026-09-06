const assert = require('node:assert/strict');
const { LoudnessMeter } = require('../dist-test/loudness-meter.js');
const { KWeighting, channelWeight } = require('../dist-test/k-weighting.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function fillBlocks(meter, channels, blockCount = 24) {
  for (let i = 0; i < blockCount; i++) {
    meter.processChannels(channels);
  }
}

test('stereo loudness sums channel energy instead of measuring a mono mix only', () => {
  const sampleRate = 48000;
  const left = new Float32Array(2048).fill(0.1);
  const right = new Float32Array(2048).fill(0.1);

  const mono = new LoudnessMeter(sampleRate);
  const stereo = new LoudnessMeter(sampleRate);

  fillBlocks(mono, [left]);
  fillBlocks(stereo, [left, right]);

  const deltaLu = stereo.getIntegratedLoudness() - mono.getIntegratedLoudness();
  assert.ok(deltaLu > 2.9 && deltaLu < 3.2);
});

test('short-term loudness includes recent silence', () => {
  const meter = new LoudnessMeter(48000);
  const tone = Float32Array.from({ length: 4800 }, (_, i) => .1 * Math.sin(2 * Math.PI * 1000 * i / 48000));
  const silence = new Float32Array(4800);
  fillBlocks(meter, [tone], 35);
  assert.ok(Number.isFinite(meter.getShortTermLoudness()));
  fillBlocks(meter, [silence], 35);
  assert.ok(meter.getShortTermLoudness() < -70);
  assert.ok(Math.abs(meter.getIntegrationTime() - 7) < 1e-9);
});

test('short-term loudness requires an exact three-second continuous sample window', () => {
  const sampleRate = 48000;
  const meter = new LoudnessMeter(sampleRate);
  const tone = new Float32Array(sampleRate).fill(0.1);

  meter.processBlock(tone);
  assert.ok(Number.isFinite(meter.getIntegratedLoudness()));
  assert.ok(Number.isNaN(meter.getShortTermLoudness()));

  meter.processBlock(new Float32Array(sampleRate * 2 - 1).fill(0.1));
  assert.ok(Number.isNaN(meter.getShortTermLoudness()));
  meter.processBlock(new Float32Array(1).fill(0.1));
  assert.ok(Number.isFinite(meter.getShortTermLoudness()));
});

test('multichannel layouts use BS.1770 center, LFE, and surround weights', () => {
  const surround = Math.pow(10, 1.5 / 10);
  assert.equal(channelWeight(2, 6), 1);
  assert.equal(channelWeight(3, 6), 0);
  assert.equal(channelWeight(4, 6), surround);
  assert.equal(channelWeight(5, 6), surround);
  assert.equal(channelWeight(0, 4), 1);
  assert.equal(channelWeight(1, 4), 1);
  assert.equal(channelWeight(2, 4), surround);
  assert.equal(channelWeight(3, 4), surround);
  assert.equal(channelWeight(3, 8), 0);
  assert.equal(channelWeight(7, 8), surround);
});

test('changing the channel layout discards the previous layout state', () => {
  const sampleRate = 48000;
  const meter = new LoudnessMeter(sampleRate);
  const tone = new Float32Array(sampleRate).fill(0.1);

  meter.processBlock(tone);
  assert.ok(Number.isFinite(meter.getIntegratedLoudness()));
  meter.processChannels([new Float32Array(1), new Float32Array(1)]);

  assert.equal(meter.getIntegrationTime(), 1 / sampleRate);
  assert.ok(Number.isNaN(meter.getIntegratedLoudness()));
  assert.ok(Number.isNaN(meter.getShortTermLoudness()));
});

test('K-weighting clones filter coefficients and history exactly', () => {
  const original = new KWeighting(48000);
  for (const sample of [0.2, -0.1, 0.35, 0]) original.process(sample);
  const copy = original.clone();

  for (const sample of [0.4, -0.3, 0.1]) {
    assert.equal(copy.process(sample), original.process(sample));
  }

  copy.reset();
  original.reset();
  assert.equal(copy.process(0.25), original.process(0.25));
});
