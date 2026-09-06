const assert = require('node:assert/strict');
const test = require('node:test');
const { RealtimeAgc } = require('../dist-test/gain-control.js');

const input = overrides => ({
  currentGain: 1, minGain: .25, maxGain: 2, deltaSec: .1,
  targetLufs: -21, momentaryLufs: -21, shortTermLufs: -21,
  gainChangePerSec: .2, ...overrides
});
function run(seconds, levels, options = {}) {
  const agc = new RealtimeAgc(), trace = [];
  let gain = .5;
  for (let i=0;i<seconds*10;i++) {
    const level=levels(i/10);
    const result=agc.update(input({ ...options, currentGain: gain, momentaryLufs: level, shortTermLufs: level }));
    gain=result.nextGain;
    trace.push({time:i/10,...result});
  }
  return {agc,trace,gain};
}
test('quiet and loud videos converge using the loudest 40 percent, not arithmetic LUFS', () => {
  for (const offset of [-5,0,6]) {
    const {trace,gain}=run(60,t=> t%10<6 ? -31+offset : -21+offset);
    const last=trace.at(-1);
    assert.ok(Math.abs(last.referenceLufs-(-21+offset))<.01);
    assert.ok(Math.abs(last.referenceLufs+20*Math.log10(gain)+21)<.5);
    assert.equal(last.phase,'stable');
  }
});
test('silence, invalid measurements and near-silent introductions never boost or stabilize', () => {
  for(const level of [-Infinity,NaN,Infinity,-65]) {
    const {gain,trace}=run(30,()=>level);
    assert.equal(gain,.5);
    assert.equal(trace.at(-1).phase,'collecting');
  }
});
test('a current loud start attenuates promptly even after a quiet introduction', () => {
  const {trace}=run(20,t=>t<12?-50:-12);
  assert.ok(trace[139].nextGain < .6);
});
test('normal dynamics leave stable gain fixed and silence does not reset it', () => {
  const {trace}=run(90,t=>t>50&&t<60?-Infinity:t%5<2?-18:-35);
  const first=trace.findIndex(x=>x.phase==='stable');
  assert.ok(first>=0&&trace[first].time<=20);
  const gains=trace.slice(first).map(x=>x.nextGain);
  assert.ok(Math.max(...gains)-Math.min(...gains)<=.5);
  assert.equal(trace.at(-1).recalibrations,0);
});
test('slow reference drift cannot move the fixed stability corridor repeatedly', () => {
  const {trace}=run(600,t=>-21+2*Math.sin(t/50));
  const first=trace.findIndex(x=>x.phase==='stable');
  const gains=trace.slice(first).map(x=>x.nextGain);
  assert.ok(Math.max(...gains)-Math.min(...gains)<=.500001);
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
test('only sustained substantially louder content permits one downward recalibration', () => {
  const {trace}=run(100,t=>t<25?-27:-12);
  assert.equal(trace.at(-1).recalibrations,1);
  assert.equal(trace.at(-1).phase,'stable');
  assert.ok(trace.at(-1).nextGain < trace[200].nextGain);
});
test('a brief transient cannot reopen calibration', () => {
  const {trace}=run(60,t=>t>30&&t<30.2?-5:-21);
  assert.equal(trace.at(-1).recalibrations,0);
  assert.ok(Math.abs(trace.at(-1).nextGain-1)<=.5);
});
test('bounds are honored and inability to reach target is explicit', () => {
  const {trace,gain}=run(60,()=>-40);
  assert.equal(gain,2);
  assert.equal(trace.at(-1).limited,true);
});
test('new video resets history instead of inheriting previous boost', () => {
  const {agc}=run(30,()=>-26);
  agc.reset();
  const result=agc.update(input({momentaryLufs:-Infinity}));
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
