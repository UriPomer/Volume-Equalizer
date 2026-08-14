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
    calibrationBoostStartSeconds: 2,
    postCalibrationCorridor: 0.2,
    postCalibrationDbCorridor: 0.75,
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

test('calibration uses the loudest window to react to sudden loud content', () => {
  assert.equal(chooseControlLoudness({
    integratedLufs: -24,
    shortTermLufs: -18,
    momentaryLufs: -12,
    integrationTime: 6,
    minIntegrationSeconds: 1,
    calibrationSeconds: 10,
    calibrationSafetyThresholdLufs: -18
  }), -12);
});

test('calibration ignores near-target short windows when integrated content is quiet', () => {
  assert.equal(chooseControlLoudness({
    integratedLufs: -30,
    shortTermLufs: -24,
    momentaryLufs: -20,
    integrationTime: 6,
    minIntegrationSeconds: 1,
    calibrationSeconds: 10,
    calibrationSafetyThresholdLufs: -18
  }), -30);
});

test('a transient peak in quiet content does not open the noise gate', () => {
  const agc = new RealtimeAgc();

  const result = agc.update(agcInput({
    currentGain: 1,
    desiredGain: 2,
    controlLufs: -60,
    momentaryLufs: -60,
    shortTermLufs: -60,
    sourcePeak: 0.9,
    deltaSec: 0.1
  }));

  assert.equal(result.gateOpen, false);
  assert.ok(result.nextGain <= 1);
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

test('startup calibration delays boosts until the final four seconds', () => {
  const agc = new RealtimeAgc();

  const early = agc.update(agcInput({
    currentGain: 0.7,
    desiredGain: 2,
    controlLufs: -35,
    deltaSec: 1,
    integrationTime: 1,
    coldStartSeconds: 10,
    calibrationBoostStartSeconds: 6,
    momentaryLufs: -35,
    shortTermLufs: -35,
    sourcePeak: 0.2
  }));
  const finishing = agc.update(agcInput({
    currentGain: early.nextGain,
    desiredGain: 2,
    controlLufs: -35,
    deltaSec: 1,
    integrationTime: 6,
    coldStartSeconds: 10,
    calibrationBoostStartSeconds: 6,
    momentaryLufs: -35,
    shortTermLufs: -35,
    sourcePeak: 0.2
  }));

  assert.ok(early.nextGain > 0.7);
  assert.ok(early.nextGain <= 1);
  assert.ok(finishing.nextGain > early.nextGain);
});

test('steady-state gain never changes faster than 0.1x per minute', () => {
  const agc = new RealtimeAgc();
  let gain = 1;
  // 校准期（前 10 秒）以配置速率收敛到目标
  for (let time = 1; time <= 10; time += 1) {
    gain = agc.update(agcInput({
      currentGain: gain,
      desiredGain: 1.2,
      deltaSec: 1,
      integrationTime: time,
      coldStartSeconds: 10,
      programTimeSeconds: time,
      sourcePeak: 0.1
    })).nextGain;
  }
  assert.ok(Math.abs(gain - 1.2) < 1e-12);

  // 稳态：交替升高/降低目标，观察 60 秒
  const start = gain;
  let maxStep = 0;
  for (let time = 11; time <= 70; time += 1) {
    const desiredGain = time % 2 === 0 ? 3 : 0.2;
    const next = agc.update(agcInput({
      currentGain: gain,
      desiredGain,
      deltaSec: 1,
      integrationTime: time,
      coldStartSeconds: 10,
      programTimeSeconds: time,
      sourcePeak: 0.1
    })).nextGain;
    maxStep = Math.max(maxStep, Math.abs(next - gain));
    gain = next;
  }

  // 单步（1 秒）不超过 0.1x/60，60 秒累计不超过 0.1x
  assert.ok(maxStep <= 0.1 / 60 + 1e-9, `max step ${maxStep}`);
  assert.ok(Math.abs(gain - start) <= 0.1 + 1e-9, `60s drift ${Math.abs(gain - start)}`);
  assert.equal(agc.isLocked(), false);
});

test('a calibration anchor prevents re-entering fast calibration after a seek', () => {
  const agc = new RealtimeAgc();
  let gain = 1;
  for (let time = 1; time <= 10; time += 1) {
    gain = agc.update(agcInput({
      currentGain: gain,
      desiredGain: 1.2,
      deltaSec: 1,
      integrationTime: time,
      coldStartSeconds: 10,
      programTimeSeconds: time,
      sourcePeak: 0.1
    })).nextGain;
  }
  // seek 后：积分时间归零但锚点仍在 -> 不进入快速校准期，gain 只受稳态速率约束
  const afterSeek = agc.update(agcInput({
    currentGain: gain,
    desiredGain: 3,
    deltaSec: 1,
    integrationTime: 0.1,
    coldStartSeconds: 10,
    programTimeSeconds: 42,
    sourcePeak: 0.1
  }));
  assert.ok(Math.abs(afterSeek.nextGain - gain) <= 0.1 / 60 + 1e-9);
  assert.notEqual(afterSeek.state, 'cold-start');
});

test('transient peaks do not rewrite programme gain before the limiter', () => {
  const loudPeakAgc = new RealtimeAgc();
  const quietPeakAgc = new RealtimeAgc();
  const loudPeak = loudPeakAgc.update(agcInput({
    currentGain: 1.1,
    desiredGain: 2,
    deltaSec: 1,
    controlLufs: -24,
    momentaryLufs: -24,
    shortTermLufs: -24,
    sourcePeak: 0.95
  })).nextGain;
  const quietPeak = quietPeakAgc.update(agcInput({
    currentGain: 1.1,
    desiredGain: 2,
    deltaSec: 1,
    controlLufs: -24,
    momentaryLufs: -24,
    shortTermLufs: -24,
    sourcePeak: 0.1
  })).nextGain;

  assert.equal(loudPeak, quietPeak);
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

test('gain stays within the calibration anchor plus or minus 0.2x', () => {
  const agc = new RealtimeAgc();
  let gain = 1;
  let result;

  for (let time = 1; time <= 10; time += 1) {
    result = agc.update(agcInput({
      currentGain: gain,
      desiredGain: 1.5,
      deltaSec: 1,
      integrationTime: time,
      coldStartSeconds: 10,
      programTimeSeconds: time,
      sourcePeak: 0.1
    }));
    gain = result.nextGain;
  }

  assert.equal(result.state, 'hold');
  assert.ok(Math.abs(gain - 1.5) < 1e-12);
  const anchored = agc.update(agcInput({
    currentGain: gain,
    desiredGain: 0.8,
    deltaSec: 0.1,
    integrationTime: 15,
    sourcePeak: 0.1
  }));
  let lowerGain = anchored.nextGain;
  for (let index = 0; index < 20; index++) {
    lowerGain = agc.update(agcInput({
      currentGain: lowerGain,
      desiredGain: 0.2,
      deltaSec: 1,
      integrationTime: 16 + index,
      sourcePeak: 0.1
    })).nextGain;
  }
  let upperGain = lowerGain;
  for (let index = 0; index < 20; index++) {
    upperGain = agc.update(agcInput({
      currentGain: upperGain,
      desiredGain: 3,
      deltaSec: 1,
      integrationTime: 40 + index,
      sourcePeak: 0.1
    })).nextGain;
  }
  assert.ok(lowerGain >= 1.3 - 1e-12);
  assert.ok(upperGain <= 1.7 + 1e-12);
  assert.ok(20 * Math.log10(upperGain / lowerGain) <= 1.500001);
  assert.equal(agc.isLocked(), false);
});

test('reset starts a new calibration corridor', () => {
  const agc = new RealtimeAgc();
  agc.update(agcInput({
    currentGain: 1,
    desiredGain: 2,
    integrationTime: 20,
    programTimeSeconds: 20,
    sourcePeak: 0.1
  }));
  agc.reset();
  const recalibrating = agc.update(agcInput({
    currentGain: 0.5,
    desiredGain: 1.5,
    integrationTime: 1,
    programTimeSeconds: 1
  }));
  assert.equal(recalibrating.state, 'cold-start');
  assert.ok(recalibrating.nextGain > 0.5);
  assert.ok(recalibrating.nextGain <= 1);
});

test('low gain attenuation is also limited in the decibel domain', () => {
  const agc = new RealtimeAgc();
  const result = agc.update(agcInput({
    currentGain: 0.4,
    desiredGain: 0.25,
    minGain: 0.2,
    deltaSec: 0.1,
    integrationTime: 10,
    programTimeSeconds: 10,
    sourcePeak: 0.1
  }));
  const stepDb = Math.abs(20 * Math.log10(result.nextGain / 0.4));
  assert.ok(stepDb <= 0.500001);
});

test('external full-track result approaches fixed gain without an instant jump', () => {
  const agc = new RealtimeAgc();
  agc.lockGain(0.75);
  assert.equal(agc.isLocked(), true);
  const first = agc.update(agcInput({
    currentGain: 1.5,
    desiredGain: 2,
    sourcePeak: 0.99,
    deltaSec: 0.1
  }));
  assert.ok(first.nextGain < 1.5 && first.nextGain > 0.75);
});

test('leaving full-track mode resumes slew-limited realtime control', () => {
  const agc = new RealtimeAgc();
  agc.lockGain(0.75);
  agc.unlockGain();

  const resumed = agc.update(agcInput({
    currentGain: 0.75,
    desiredGain: 1.5,
    programTimeSeconds: 20,
    deltaSec: 1
  }));

  assert.equal(agc.isLocked(), false);
  assert.ok(resumed.nextGain > 0.75);
  assert.ok(resumed.nextGain < 1.5);
});

test('new gain bounds clamp the current gain before realtime adjustment', () => {
  const agc = new RealtimeAgc();
  agc.unlockGain();
  const result = agc.update(agcInput({
    currentGain: 2,
    desiredGain: 0.5,
    minGain: 0.25,
    maxGain: 1,
    programTimeSeconds: 20
  }));
  assert.ok(result.nextGain >= 0.5 && result.nextGain <= 1);
});

test('late attachment still receives a full observed calibration window', () => {
  const agc = new RealtimeAgc();
  const result = agc.update(agcInput({
    currentGain: 1,
    desiredGain: 1.5,
    integrationTime: 1,
    programTimeSeconds: 120,
    coldStartSeconds: 10
  }));
  assert.equal(result.state, 'cold-start');
});
