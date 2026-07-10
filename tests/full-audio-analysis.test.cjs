const assert = require('node:assert/strict');
const {
  calculateFullAudioGain,
  findBilibiliAudioUrl,
  TruePeakEstimator
} = require('../dist-test/full-audio-analysis.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('finds highest bandwidth Bilibili DASH audio URL', () => {
  const playInfo = {
    data: {
      dash: {
        audio: [
          { bandwidth: 64000, baseUrl: 'https://cdn.example/low.m4s' },
          { bandwidth: 128000, base_url: 'https://cdn.example/high.m4s' }
        ]
      }
    }
  };
  const script = `window.__playinfo__=${JSON.stringify(playInfo)};window.after={ok:true};`;
  assert.equal(findBilibiliAudioUrl([script]), 'https://cdn.example/high.m4s');
});

test('full-track gain uses one loudness gain when peak headroom is sufficient', () => {
  const gain = calculateFullAudioGain(
    { integratedLufs: -24, samplePeak: 0.2 },
    -18,
    0.5,
    2
  );
  assert.ok(Math.abs(gain - Math.pow(10, 6 / 20)) < 1e-12);
});

test('full-track gain respects static peak headroom', () => {
  const gain = calculateFullAudioGain(
    { integratedLufs: -30, samplePeak: 0.8 },
    -18,
    0.5,
    3
  );
  assert.ok(Math.abs(gain - 0.8912509381337456 / (0.8 * 1.03)) < 1e-12);
});

test('true-peak estimator catches cubic inter-sample overshoot', () => {
  const estimator = new TruePeakEstimator();
  estimator.processChannels([Float32Array.from([
    -0.89, -0.89, -0.89, -0.4,
    -0.89, -0.89, -0.89, -0.4
  ])]);
  assert.ok(estimator.getPeak() > 0.89);
});
