const assert = require('node:assert/strict');
const { ProgramLoudness } = require('../dist-test/program-loudness.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function linearEnergy(lufs) {
  return Math.pow(10, (lufs + 0.691) / 10);
}

test('uses duration-weighted linear energy instead of averaging LUFS', () => {
  const loudness = new ProgramLoudness();
  loudness.observe(-30, 1);
  loudness.observe(-20, 1);
  loudness.observe(-10, 1);
  loudness.observe(-5, 1);

  const expected = -0.691 + 10 * Math.log10((linearEnergy(-5) + .6 * linearEnergy(-10)) / 1.6);
  assert.ok(Math.abs(loudness.getLoudness() - expected) < 1e-10);
  assert.equal(loudness.getActiveSeconds(), 4);
});

test('truncates the gate bin proportionally when selecting the loudest 40 percent', () => {
  const loudness = new ProgramLoudness();
  loudness.observe(-30, 2);
  loudness.observe(-20.05, 2);
  loudness.observe(-10.05, 1);

  // The top bucket contributes one second, then half of the next bucket fills 40% of five seconds.
  const expected = -0.691 + 10 * Math.log10((linearEnergy(-10.05) + linearEnergy(-20.05)) / 2);
  assert.ok(Math.abs(loudness.getLoudness() - expected) < 1e-10);
});

test('rejects invalid and silent observations while retaining finite audible data', () => {
  const loudness = new ProgramLoudness();
  for (const [lufs, seconds] of [[NaN, 1], [Infinity, 1], [-Infinity, 1], [-70, 1], [-80, 1], [-20, 0], [-20, -1], [-20, Infinity]]) {
    loudness.observe(lufs, seconds);
  }
  assert.ok(Number.isNaN(loudness.getLoudness()));
  assert.equal(loudness.getActiveSeconds(), 0);

  loudness.observe(-15, .25);
  assert.equal(loudness.getActiveSeconds(), .25);
  assert.ok(Math.abs(loudness.getLoudness() + 15) < 1e-10);
});

test('uses the final histogram bucket for values above +20 LUFS and can reset', () => {
  const loudness = new ProgramLoudness();
  loudness.observe(25, 1);
  assert.ok(Math.abs(loudness.getLoudness() - 25) < 1e-10);
  loudness.reset();
  assert.equal(loudness.getActiveSeconds(), 0);
  assert.ok(Number.isNaN(loudness.getLoudness()));
});
