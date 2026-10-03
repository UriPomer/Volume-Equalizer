const assert = require('node:assert/strict');
const test = require('node:test');
const { RealtimeAgc } = require('../dist-test/gain-control.js');
const { INITIAL_GAIN } = require('../dist-test/config.js');

const input = overrides => ({
  currentGain: 1, minGain: .25, maxGain: 2, deltaSec: .1,
  targetLufs: -21, integratedLufs: -21, momentaryLufs: -21,
  gainChangePerSec: .2, ...overrides
});
function run(seconds, levels, options = {}) {
  const agc = new RealtimeAgc(), trace = [], energies = [];
  let gain = INITIAL_GAIN;
  for (let i=0;i<seconds*10;i++) {
    const level=levels(i/10);
    if (Number.isFinite(level) && level >= -70) energies.push(Math.pow(10, level / 10));
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const threshold = mean(energies) / 10;
    const gated = energies.filter(energy => energy >= threshold);
    const integratedLufs = 10 * Math.log10(mean(gated));
    const result=agc.update(input({ ...options, currentGain: gain, integratedLufs, momentaryLufs: level }));
    gain=result.nextGain;
    trace.push({time:i/10,...result});
  }
  return {agc,trace,gain};
}
// Failure contracts: slow drift must not walk the anchor; sustained loud
// content must not reopen calibration; silence and user bounds must not move
// the corridor. Include EVERY decision after first stable, even other phases.
function assertStableCorridor(trace) {
  const first = trace.findIndex(row => row.phase === 'stable');
  assert.ok(first >= 0, 'Calibration must finish');
  const anchor = trace[first].nextGain, tail = trace.slice(first);
  assert.ok(tail.every(row => row.phase === 'stable'), 'Content cannot reopen calibration');
  const gains = tail.map(row => row.nextGain);
  assert.ok(Math.max(...gains) - Math.min(...gains) <= .2 + 1e-6, 'Whole stable span must be <=0.2x');
  assert.ok(gains.every(gain => Math.abs(gain - anchor) <= .1 + 1e-6), 'Each gain must remain within anchor +/-0.1x');
}
test('quiet and loud videos converge to the supplied gated integrated loudness', () => {
  for (const offset of [-2,0,6]) {
    const {trace,gain}=run(60,t=> t%10<6 ? -31+offset : -21+offset);
    const last=trace.at(-1);
    const expected = -21 + offset + 10 * Math.log10(.6 * .1 + .4);
    assert.ok(Math.abs(last.referenceLufs-expected)<.01);
    assert.ok(Math.abs(last.referenceLufs+20*Math.log10(gain)+21)<.5);
    assert.equal(last.phase,'stable');
  }
});
test('silence, invalid measurements and near-silent introductions never boost or stabilize', () => {
  for(const level of [-Infinity,NaN,Infinity,-65]) {
    const {gain,trace}=run(30,()=>level);
    assert.equal(gain,INITIAL_GAIN);
    assert.equal(trace.at(-1).phase,'collecting');
  }
});
test('a current loud start attenuates promptly even after a quiet introduction', () => {
  const immediate = run(2, () => -12);
  assert.ok(immediate.trace[9].nextGain <= .36);
  const {trace}=run(20,t=>t<12?-50:-12);
  assert.ok(trace[139].nextGain < .6);
});
test('normal dynamics leave stable gain fixed and silence does not reset it', () => {
  const {trace}=run(90,t=>t>50&&t<60?-Infinity:t%5<2?-18:-35);
  const first=trace.findIndex(x=>x.phase==='stable');
  assert.ok(first>=0&&trace[first].time<=20);
  assertStableCorridor(trace);
  const silent = trace.filter(row => row.time > 51 && row.time < 60);
  assert.equal(new Set(silent.map(row => row.nextGain)).size, 1);
});
test('slow reference drift cannot move the fixed stability corridor repeatedly', () => {
  const {trace}=run(600,t=>-21+2*Math.sin(t/50));
  assertStableCorridor(trace);
});

test('stable programme control preserves quiet/loud contrast rather than lifting every quiet phrase', () => {
  const level = t => t % 5 < 2 ? -21 : -41;
  const { trace } = run(90, level);
  const tail = trace.filter(row => row.time >= 60);
  const averageOutput = loud => {
    const rows = tail.filter(row => (level(row.time) === -21) === loud);
    return 10 * Math.log10(rows.reduce((sum, row) =>
      sum + Math.pow(10, level(row.time) / 10) * row.nextGain ** 2, 0) / rows.length);
  };
  assert.ok(Math.abs(averageOutput(true) + 21) <= .25);
  assert.ok(Math.abs(averageOutput(true) - averageOutput(false) - 20) <= .25);
});
test('sustained substantially louder content cannot replace the stable anchor', () => {
  const {trace}=run(100,t=>t<25?-27:-12);
  assertStableCorridor(trace);
});
test('a brief transient cannot reopen calibration', () => {
  const {trace}=run(60,t=>t>30&&t<30.2?-5:-21);
  assertStableCorridor(trace);
});
test('user bounds clip the corridor without shifting the calibration anchor', () => {
  for (const level of [-30, -10]) {
    const {trace} = run(100, t => t < 25 ? level : -21);
    assertStableCorridor(trace);
    assert.ok(trace.every(row => row.nextGain >= .25 && row.nextGain <= 2));
  }
});
test('explicit settings recalibration establishes a new fixed anchor', () => {
  const {agc, gain} = run(30, () => -21);
  agc.unlockGain();
  let currentGain = gain;
  const trace = [];
  for (let i = 0; i < 300; i++) {
    const result = agc.update(input({currentGain, targetLufs: -27}));
    currentGain = result.nextGain;
    trace.push(result);
  }
  assert.ok(currentGain < gain - .2, 'A user target change must escape the previous corridor');
  assertStableCorridor(trace);
});
test('bounds are honored and inability to reach target is explicit', () => {
  const {trace,gain}=run(60,()=>-40);
  assert.equal(gain,2);
  assert.equal(trace.at(-1).limited,true);
});
test('new video resets history instead of inheriting previous boost', () => {
  const {agc}=run(30,()=>-26);
  agc.reset();
  const result=agc.update(input({momentaryLufs:-Infinity, integratedLufs:NaN}));
  assert.equal(result.nextGain,1);
  assert.ok(Number.isNaN(result.referenceLufs));
});
test('explicit full-track mode is separate and can be exited without discarding observations', () => {
  const agc=new RealtimeAgc();
  agc.lockGain(.5);
  assert.equal(agc.isLocked(),true);
  assert.equal(agc.update(input()).phase,'full-track');
  agc.unlockGain();
  assert.equal(agc.isLocked(),false);
});
