const assert = require('node:assert/strict');
const {
  assertFullAudioDurationComplete,
  assertEstimatedDecodedAudioBudget,
  calculateFullAudioGain,
  classifyMediaDuration,
  findBilibiliAudioUrl,
  FullAudioAnalysisError
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

test('full-track gain normalizes integrated loudness', () => {
  const gain = calculateFullAudioGain(
    { integratedLufs: -24 },
    -18,
    0.5,
    2
  );
  assert.ok(Math.abs(gain - Math.pow(10, 6 / 20)) < 1e-12);
});

// Failure contract: a rare peak must not lower the entire programme. User
// gain bounds, rather than the historical peak, limit normalization.
test('full-track gain respects user bounds rather than a historical peak', () => {
  const gain = calculateFullAudioGain(
    { integratedLufs: -30, samplePeak: 0.8 },
    -18,
    0.5,
    3
  );
  assert.equal(gain, 3);
});

test('accepts small audio and video duration differences', () => {
  assert.doesNotThrow(() => assertFullAudioDurationComplete(119, 120));
});

test('rejects a partially decoded audio track', () => {
  assert.throws(
    () => assertFullAudioDurationComplete(90, 120),
    (error) => error instanceof FullAudioAnalysisError && error.code === 'incomplete'
  );
});

test('rejects full-track analysis that would decode beyond memory budget', () => {
  assert.doesNotThrow(() => assertEstimatedDecodedAudioBudget(5 * 60));
  assert.throws(
    () => assertEstimatedDecodedAudioBudget(20 * 60),
    (error) => error instanceof FullAudioAnalysisError && error.code === 'too-large'
  );
});

test('distinguishes metadata wait from unsupported live media', () => {
  assert.equal(classifyMediaDuration(NaN), 'waiting');
  assert.equal(classifyMediaDuration(Infinity), 'unsupported');
  assert.equal(classifyMediaDuration(120), 'ready');
});
