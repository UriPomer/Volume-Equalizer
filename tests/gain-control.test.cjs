const assert = require('node:assert/strict');
const {
  RealtimeAgc,
  chooseControlLoudness,
  computeGainRiseScale
} = require('../dist-test/gain-control.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function agcInput(overrides) {
  return {
    currentGain: 1,
    desiredGain: 1,
    minGain: 0.5,
    maxGain: 2,
    deltaSec: 1,
    controlLufs: -18,
    targetLufs: -18,
    integrationTime: 5,
    coldStartSeconds: 3,
    sourcePeak: 0.1,
    momentaryLufs: -18,
    shortTermLufs: -18,
    gainChangePerSec: 0.2,
    ...overrides
  };
}

test('cold start uses momentary loudness before integrated window is ready', () => {
  assert.equal(
    chooseControlLoudness({
      integratedLufs: -30,
      shortTermLufs: -26,
      momentaryLufs: -20,
      integrationTime: 0.2,
      minIntegrationSeconds: 1
    }),
    -20
  );
});

test('program control uses short-term loudness after startup', () => {
  assert.equal(
    chooseControlLoudness({
      integratedLufs: -24,
      shortTermLufs: -18,
      momentaryLufs: -35,
      integrationTime: 3,
      minIntegrationSeconds: 1
    }),
    -18
  );
});

test('very quiet content can still rise slowly instead of being blocked', () => {
  const agc = new RealtimeAgc();

  assert.ok(computeGainRiseScale(-39, -18) > 0);
  assert.equal(
    agc.update(agcInput({
      currentGain: 1.1,
      desiredGain: 2,
      controlLufs: -39,
      momentaryLufs: -39,
      shortTermLufs: -39,
      sourcePeak: 0.2
    })).nextGain,
    1.12
  );
});

test('very quiet background cannot climb through the adaptive noise gate', () => {
  const agc = new RealtimeAgc();

  const held = agc.update(agcInput({
    currentGain: 1.3,
    desiredGain: 2,
    deltaSec: 10,
    controlLufs: -55,
    momentaryLufs: -55,
    shortTermLufs: -55,
    sourcePeak: 0.02
  }));

  assert.equal(held.gateOpen, false);
  assert.equal(held.nextGain, 1.3);
});

test('cold start never boosts above unity even when loudness is low', () => {
  const agc = new RealtimeAgc();

  assert.equal(
    agc.update(agcInput({
      currentGain: 1,
      desiredGain: 2,
      controlLufs: -35,
      integrationTime: 1,
      momentaryLufs: -35,
      shortTermLufs: -35,
      sourcePeak: 0.2
    })).nextGain,
    1
  );
});

test('source peak headroom limits gain before the limiter has to work', () => {
  const agc = new RealtimeAgc();
  const nextGain = agc.update(agcInput({
    currentGain: 1.1,
    desiredGain: 2,
    deltaSec: 10,
    controlLufs: -24,
    momentaryLufs: -24,
    shortTermLufs: -24,
    sourcePeak: 0.8
  })).nextGain;

  assert.ok(Math.abs(nextGain - 1.114063672667182) < 1e-12);
});

test('agc reset closes the gate so foreground recovery cannot inherit stale boost state', () => {
  const agc = new RealtimeAgc();

  const opened = agc.update(agcInput({
    currentGain: 1.4,
    desiredGain: 2,
    controlLufs: -30,
    momentaryLufs: -30,
    shortTermLufs: -30,
    sourcePeak: 0.1
  }));
  agc.reset();
  const afterReset = agc.update(agcInput({
    currentGain: opened.nextGain,
    desiredGain: 2,
    controlLufs: -56,
    momentaryLufs: -56,
    shortTermLufs: -56,
    sourcePeak: 0.01
  }));

  assert.equal(opened.gateOpen, true);
  assert.equal(afterReset.gateOpen, false);
  assert.ok(afterReset.nextGain <= opened.nextGain);
});

test('agc gate holds gain through sustained noise floor', () => {
  const agc = new RealtimeAgc();

  agc.update(agcInput({
    currentGain: 1.2,
    desiredGain: 2,
    controlLufs: -55,
    momentaryLufs: -55,
    shortTermLufs: -55,
    sourcePeak: 0.02
  }));

  const held = agc.update(agcInput({
    currentGain: 1.2,
    desiredGain: 2,
    controlLufs: -54,
    momentaryLufs: -54,
    shortTermLufs: -54,
    sourcePeak: 0.02
  }));

  assert.equal(held.gateOpen, false);
  assert.equal(held.nextGain, 1.2);
});

test('agc gate uses hysteresis near the adaptive threshold', () => {
  const agc = new RealtimeAgc();

  const opened = agc.update(agcInput({
    desiredGain: 2,
    controlLufs: -42,
    momentaryLufs: -42,
    shortTermLufs: -42,
    sourcePeak: 0.08
  }));
  const nearThreshold = agc.update(agcInput({
    currentGain: opened.nextGain,
    desiredGain: 2,
    controlLufs: -46,
    momentaryLufs: -46,
    shortTermLufs: -46,
    sourcePeak: 0.05
  }));

  assert.equal(opened.gateOpen, true);
  assert.equal(nearThreshold.gateOpen, true);
});

test('agc uses faster attenuation than boost for sudden loud content', () => {
  const agc = new RealtimeAgc();

  const boosted = agc.update(agcInput({
    desiredGain: 2,
    controlLufs: -30,
    momentaryLufs: -30,
    shortTermLufs: -30,
    sourcePeak: 0.1
  }));
  const attenuated = agc.update(agcInput({
    currentGain: boosted.nextGain,
    desiredGain: 0.3,
    controlLufs: -8,
    momentaryLufs: -8,
    shortTermLufs: -8,
    sourcePeak: 0.9
  }));

  assert.ok(boosted.nextGain > 1);
  assert.ok(boosted.nextGain <= 1.07);
  assert.ok(attenuated.nextGain < boosted.nextGain - 0.2);
});
