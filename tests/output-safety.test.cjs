const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { KWeighting, channelWeight } = require('../dist-test/k-weighting.js');
const code = require('./worklet-source.cjs')();

function renderScenario({ rate = 48000, channels = 2, seconds = 3, target = -21, sample, commands = () => {}, inspect = () => {} }) {
  let Processor;
  vm.runInNewContext(code, {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor(name, value) { Processor = value; }
  });
  const processor = new Processor({ processorOptions: { targetLufs: target } });
  const filters = Array.from({ length: channels }, () => new KWeighting(rate));
  const window = new Float64Array(Math.round(rate * .4));
  let sum = 0, index = 0, peakLufs = -Infinity, nonzero = 0;
  for (let start = 0; start < (seconds + .6) * rate; start += 128) {
    commands(processor, start / rate);
    const input = Array.from({ length: channels }, (_,channel) =>
      Float32Array.from({ length: 128 }, (_,i) => start + i < seconds * rate
        ? sample((start + i) / rate, channel) : 0));
    const output = Array.from({ length: channels }, () => new Float32Array(128));
    // No main-thread meter callbacks or requestAnimationFrame: protection must
    // remain effective when a hidden page freezes its programme gain.
    processor.process([input], [output]);
    inspect(processor, start / rate);
    for (let frame = 0; frame < 128; frame++) {
      let energy = 0;
      for (let channel = 0; channel < channels; channel++) {
        const x = output[channel][frame];
        assert.ok(Number.isFinite(x));
        if (x !== 0) nonzero++;
        const k = filters[channel].process(x);
        energy += channelWeight(channel, channels) * k * k;
      }
      sum += energy - window[index];
      window[index] = energy;
      index = (index + 1) % window.length;
      if (sum > 0) peakLufs = Math.max(peakLufs, -0.691 + 10 * Math.log10(sum / window.length));
    }
  }
  assert.ok(nonzero > 0, 'guard must actually play the buffered audio');
  assert.ok(peakLufs <= target + 2 + 0.001, `output ${peakLufs.toFixed(4)} LUFS > ${target + 2}`);
  return peakLufs;
}

test('actual output stays below target +2 after a silent intro and 200ms loud burst', () => {
  const maximum = renderScenario({ seconds: 12, sample: (t) => {
    const amplitude = t < 1 ? .05 : (t >= 10 && t < 10.2 ? .3 * 1.8 : 0);
    return amplitude * Math.sin(2 * Math.PI * 1000 * t);
  }});
  console.log(`silent-intro burst: maximum output ${maximum.toFixed(3)} LUFS`);
});

test('post-EQ bass, loud transients and background playback share the same final ceiling', () => {
  renderScenario({ sample: (t) => .35 * Math.pow(10, 6 / 20) * Math.sin(2 * Math.PI * 80 * t) });
  renderScenario({ channels: 1, sample: (t) => t % .21 < .001 ? .85 : 0 });
});

test('sliding windows remain protected at chunk boundaries and different sample rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    renderScenario({ rate, channels: 2, target: -23, sample: (t,c) => {
      const amplitude = t % .2 > .097 ? .8 : .01;
      return amplitude * Math.sin(2 * Math.PI * (c ? 4300 : 37) * t);
    }});
  }
});

test('surround programme remains protected without attributing LFE to loudness', () => {
  renderScenario({ channels: 6, sample: (t,c) => .4 * Math.sin(2 * Math.PI * (c === 3 ? 40 : 800) * t) });
});

test('meter resets do not reset the audio safety budget', () => {
  let reset = false;
  renderScenario({ sample: t => .5 * Math.sin(2 * Math.PI * 1000 * t), commands: (p,t) => {
    if (t > .17 && !reset) { p.port.onmessage({ data: { type: 'reset-meter', epoch: 2 } }); reset = true; }
  }});
});

test('bounded programme does not exhaust the next block budget or remain muted after silence', () => {
  let minGain = 1, endGain = 0;
  renderScenario({ seconds: 7, sample: t => {
    const amp = t < 2 ? .6 : t < 3 ? .1 : t < 4 ? .8 : t < 5 ? .2 : 0;
    return amp * Math.sin(2 * Math.PI * (t < 3 ? 1000 : 71) * t);
  }, inspect: (p,t) => {
    if(t < 5) minGain = Math.min(minGain, p.safety.gain);
    endGain = p.safety.gain;
  }});
  assert.ok(minGain > .01, `unexpected dropout: gain ${minGain}`);
  assert.ok(endGain > .99, `release stuck: gain ${endGain}`);
});
