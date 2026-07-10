const assert = require('node:assert/strict');
const {
  RealtimeAgc,
  chooseControlLoudness
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

test('program control uses integrated loudness after startup', () => {
  assert.equal(
    chooseControlLoudness({
      integratedLufs: -24,
      shortTermLufs: -18,
      momentaryLufs: -35,
      integrationTime: 3,
      minIntegrationSeconds: 1
    }),
    -24
  );
});

test('program control falls back to short-term loudness when integrated is unavailable', () => {
  assert.equal(
    chooseControlLoudness({
      integratedLufs: NaN,
      shortTermLufs: -18,
      momentaryLufs: -35,
      integrationTime: 3,
      minIntegrationSeconds: 1
    }),
    -18
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
  assert.ok(held.nextGain <= 1.3);
});

test('startup calibration may boost quiet content', () => {
  const agc = new RealtimeAgc();

  assert.ok(
    agc.update(agcInput({
      currentGain: 1,
      desiredGain: 2,
      controlLufs: -35,
      deltaSec: 1,
      integrationTime: 1,
      momentaryLufs: -35,
      shortTermLufs: -35,
      sourcePeak: 0.2
    })).nextGain > 1
  );
});

test('source peak headroom limits gain before the limiter has to work', () => {
  const agc = new RealtimeAgc();
  const nextGain = agc.update(agcInput({
    currentGain: 1.1,
    desiredGain: 2,
    deltaSec: 1,
    controlLufs: -24,
    momentaryLufs: -24,
    shortTermLufs: -24,
    sourcePeak: 0.95
  })).nextGain;

  assert.ok(Math.abs(nextGain - 0.8912509381337456 / 0.95) < 1e-12);
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
  assert.ok(held.nextGain <= 1.2);
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

test('startup predictor attenuates sudden loud content', () => {
  const agc = new RealtimeAgc();

  const initial = agc.update(agcInput({
    desiredGain: 1,
    controlLufs: -21,
    momentaryLufs: -21,
    shortTermLufs: -21,
    sourcePeak: 0.1
  }));
  const attenuated = agc.update(agcInput({
    currentGain: initial.nextGain,
    desiredGain: 0.3,
    controlLufs: -8,
    momentaryLufs: -8,
    shortTermLufs: -8,
    sourcePeak: 0.9
  }));

  assert.ok(attenuated.nextGain < initial.nextGain);
});

test('peak headroom only tightens for the current programme', () => {
  const agc = new RealtimeAgc();
  const peakLimited = agc.update(agcInput({
    currentGain: 1,
    desiredGain: 2,
    deltaSec: 0.5,
    sourcePeak: 0.8
  }));
  const afterQuietBlock = agc.update(agcInput({
    currentGain: peakLimited.nextGain,
    desiredGain: 2,
    deltaSec: 0.5,
    sourcePeak: 0.1
  }));

  assert.ok(afterQuietBlock.nextGain <= 0.8912509381337456 / 0.8);
});

test('gain stays within a fixed 0.2x corridor after ten seconds', () => {
  const agc = new RealtimeAgc();
  let gain = 1;
  let result;

  for (let time = 1; time <= 10; time += 1) {
    result = agc.update(agcInput({
      currentGain: gain,
      desiredGain: 1.5,
      deltaSec: 1,
      integrationTime: time,
      sourcePeak: 0.1
    }));
    gain = result.nextGain;
  }

  assert.equal(result.state, 'bounded');
  const lowerBound = agc.update(agcInput({
    currentGain: gain,
    desiredGain: 0.8,
    deltaSec: 5,
    integrationTime: 15,
    sourcePeak: 0.95
  }));
  const upperBound = agc.update(agcInput({
    currentGain: lowerBound.nextGain,
    desiredGain: 2,
    deltaSec: 5,
    integrationTime: 20,
    sourcePeak: 0.1
  }));
  assert.equal(lowerBound.state, 'bounded');
  assert.equal(upperBound.state, 'bounded');
  assert.ok(upperBound.nextGain - lowerBound.nextGain <= 0.200001);
});

test('low gain attenuation is also limited in the decibel domain', () => {
  const agc = new RealtimeAgc();
  const result = agc.update(agcInput({
    currentGain: 0.4,
    desiredGain: 0.25,
    minGain: 0.2,
    deltaSec: 0.1,
    integrationTime: 10,
    sourcePeak: 0.1
  }));
  const stepDb = Math.abs(20 * Math.log10(result.nextGain / 0.4));
  assert.ok(stepDb <= 0.500001);
});

test('external full-track result locks gain immediately', () => {
  const agc = new RealtimeAgc();
  agc.lockGain(0.75);
  assert.equal(agc.isLocked(), true);
  assert.equal(agc.update(agcInput({ desiredGain: 2, sourcePeak: 0.99 })).nextGain, 0.75);
});
