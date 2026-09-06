const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadProcessor() {
  let ProcessorClass = null;
  const code = require('./worklet-source.cjs')();
  const context = {
    sampleRate: 48000,
    console,
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage() {} }; }
    },
    registerProcessor(name, klass) {
      assert.equal(name, 'lookahead-peak-limiter');
      ProcessorClass = klass;
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return ProcessorClass;
}

function renderMono(inputSamples, options = {}) {
  const ProcessorClass = loadProcessor();
  const processor = new ProcessorClass({
    processorOptions: {
      lookaheadMs: 15,
      releaseMs: 50,
      ceiling: 0.95,
      ...options
    }
  });

  const outputSamples = [];
  for (let offset = 0; offset < inputSamples.length + 12000; offset += 128) {
    const inputBlock = new Float32Array(128);
    inputBlock.set(inputSamples.slice(offset, offset + 128));
    const outputBlock = new Float32Array(128);
    processor.process([[inputBlock]], [[outputBlock]]);
    outputSamples.push(...outputBlock);
  }
  assert.ok(outputSamples.some((sample) => sample !== 0), 'must render audio, not only buffered silence');
  return outputSamples;
}

function renderStereo(leftSamples, rightSamples, options = {}) {
  const ProcessorClass = loadProcessor();
  const processor = new ProcessorClass({ processorOptions: options });

  const outputSamples = [];
  for (let offset = 0; offset < leftSamples.length + 12000; offset += 128) {
    const leftInput = new Float32Array(128);
    const rightInput = new Float32Array(128);
    leftInput.set(leftSamples.slice(offset, offset + 128));
    rightInput.set(rightSamples.slice(offset, offset + 128));
    const leftOutput = new Float32Array(128);
    const rightOutput = new Float32Array(128);
    processor.process([[leftInput, rightInput]], [[leftOutput, rightOutput]]);
    outputSamples.push(...leftOutput, ...rightOutput);
  }
  return outputSamples;
}

function maxAbs(samples) {
  return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
}

function cubic(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function maxCubicInterpolatedPeak(samples, steps = 4) {
  let peak = 0;
  for (let i = 1; i < samples.length - 2; i++) {
    const p0 = samples[i - 1];
    const p1 = samples[i];
    const p2 = samples[i + 1];
    const p3 = samples[i + 2];
    for (let step = 0; step < steps; step++) {
      const value = cubic(p0, p1, p2, p3, step / steps);
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return Math.max(peak, maxAbs(samples));
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('lookahead limiter catches an isolated over-ceiling impulse', () => {
  const input = new Float32Array(2048);
  input[0] = 2;

  const output = renderMono(input);

  assert.ok(maxAbs(output) <= 0.950001);
});

test('lookahead limiter catches a later over-ceiling impulse', () => {
  const input = new Float32Array(4096);
  input[700] = -1.8;

  const output = renderMono(input);

  assert.ok(maxAbs(output) <= 0.950001);
});

test('default limiter leaves true-peak safety headroom below -1 dBFS', () => {
  const left = new Float32Array(4096).fill(1.5);
  const right = new Float32Array(4096).fill(0.2);

  const output = renderStereo(left, right);

  assert.ok(maxAbs(output) <= 0.8653);
});

test('default limiter constrains 4x cubic interpolated true-peak estimate', () => {
  const input = new Float32Array(4096);
  for (let i = 0; i < input.length; i += 4) {
    input[i] = -0.89;
    input[i + 1] = -0.89;
    input[i + 2] = -0.89;
    input[i + 3] = -0.4;
  }

  const output = renderMono(input, {
    ceiling: 0.8912509381337456,
    interSampleMargin: 1
  });

  assert.ok(maxCubicInterpolatedPeak(output, 4) <= 0.891251);
});

test('processor reports continuous original and output audio', () => {
  const ProcessorClass = loadProcessor();
  const processor = new ProcessorClass({ processorOptions: {} });
  const messages = [];
  processor.port = { postMessage: (message) => messages.push(message) };

  for (let block = 0; block < 40; block++) {
    const processed = new Float32Array(128).fill(0.25);
    const original = new Float32Array(128).fill(0.5);
    processor.process([[processed], [original]], [[new Float32Array(128)]]);
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'meter');
  assert.equal(messages[0].epoch, 0);
  assert.equal(messages[0].original.length, 1);
  assert.equal(messages[0].original[0].length, 4800);
  assert.ok(Math.abs(messages[0].original[0][0] - 0.5) < 1e-6);
  assert.equal(messages[0].frames, 4800);
  assert.equal(messages[0].limitedFrames, 0);
  assert.equal(messages[0].safetyGain, 1);
});

test('meter reports the actual peak-limited frame ratio and minimum gain', () => {
  const ProcessorClass = loadProcessor();
  const processor = new ProcessorClass({ processorOptions: { ceiling: .5, lookaheadMs: 15 } });
  const messages = [];
  processor.port = { postMessage: message => messages.push(message) };

  for (let block = 0; block < 38; block++) {
    const input = new Float32Array(128).fill(1);
    processor.process([[input]], [[new Float32Array(128)]]);
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0].frames, 4800);
  assert.ok(messages[0].limitedFrames >= 4000, `limited ${messages[0].limitedFrames} frames`);
  assert.ok(messages[0].safetyGain <= .500001);
});

test('non-finite PCM is rendered as silence without poisoning later audio', () => {
  const input = new Float32Array(4096).fill(.25);
  input[10] = Infinity;
  input[11] = NaN;
  const output = renderMono(input);

  assert.ok(output.every(Number.isFinite));
  assert.ok(output.slice(1000, 3000).some(sample => Math.abs(sample) > .2));
});
