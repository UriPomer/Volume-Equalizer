const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSettings } = require('../dist-test/settings.js');

test('settings normalization rejects non-finite and out-of-range values', () => {
  const settings = normalizeSettings({
    enabled: 'yes',
    fullAudioAnalysis: true,
    targetRms: Number.NaN,
    minGain: -5,
    maxGain: 99,
    bassBoost: Number.POSITIVE_INFINITY,
    gainChangePerSec: 0
  });

  assert.equal(settings.enabled, true);
  assert.equal(settings.fullAudioAnalysis, true);
  assert.equal(settings.targetRms, 0.09650504109445904);
  assert.equal(settings.minGain, 0.2);
  assert.equal(settings.maxGain, 3);
  assert.equal(settings.bassBoost, 0);
  assert.equal(settings.gainChangePerSec, 0.01);
});
