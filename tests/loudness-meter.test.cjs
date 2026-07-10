const assert = require('node:assert/strict');
const { LoudnessMeter } = require('../dist-test/loudness-meter.js');

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
  const tone = new Float32Array(4800).fill(0.1);
  const silence = new Float32Array(4800);
  fillBlocks(meter, [tone], 35);
  assert.ok(Number.isFinite(meter.getShortTermLoudness()));
  fillBlocks(meter, [silence], 35);
  assert.ok(meter.getShortTermLoudness() < -70);
  assert.ok(Math.abs(meter.getIntegrationTime() - 7) < 1e-9);
});
