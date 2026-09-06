const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

function loadProcessor() {
  let Processor = null;
  const context = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage() {} }; }
    },
    registerProcessor(name, klass) {
      assert.equal(name, 'lookahead-peak-limiter');
      Processor = klass;
    }
  };
  vm.createContext(context);
  vm.runInContext(
    require('./worklet-source.cjs')(),
    context
  );
  return Processor;
}

const ProcessorClass = loadProcessor();

class FakeParam {
  constructor(value = 0) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
}

class FakeNode {
  constructor() { this.connections = []; }
  connect(destination, output = 0, input = 0) {
    this.connections.push({ destination, output, input });
    return destination;
  }
  disconnect() { this.connections = []; }
}

class FakeAnalyser extends FakeNode {
  constructor() { super(); this.fftSize = 2048; }
  getFloatTimeDomainData(buffer) { buffer.fill(0.1); }
}

class FakeContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeNode();
    this.destination.channelCount = 2;
    this.source = new FakeNode();
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaElementSource() { return this.source; }
  createGain() { const node = new FakeNode(); node.gain = new FakeParam(1); return node; }
  createBiquadFilter() {
    const node = new FakeNode();
    node.frequency = new FakeParam();
    node.gain = new FakeParam();
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode();
    for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[key] = new FakeParam();
    return node;
  }
  createAnalyser() { return new FakeAnalyser(); }
  resume() { return Promise.resolve(); }
}

class FakeWorkletNode extends FakeNode {
  constructor(context, name, options) {
    super();
    this.context = context;
    this.name = name;
    this.options = options;
    this.processor = new ProcessorClass(options);
    this.port = {
      onmessage: null,
      postMessage: (data) => this.processor.port.onmessage?.({ data })
    };
    this.processor.port.postMessage = (data) => this.port.onmessage?.({ data });
    global.lastWorklet = this;
  }
}

class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.duration = 60;
    this.currentTime = 0;
    this.paused = false;
    this.ended = false;
    this.muted = false;
  }
}

const rafCallbacks = [];
const documentListeners = new Map();
global.window = { AudioContext: FakeContext };
global.document = {
  hidden: false,
  visibilityState: 'visible',
  scripts: [],
  addEventListener(type, listener) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(listener);
  },
  removeEventListener(type, listener) {
    documentListeners.get(type)?.delete(listener);
  }
};
global.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
global.AudioWorkletNode = FakeWorkletNode;
global.requestAnimationFrame = (callback) => { rafCallbacks.push(callback); return rafCallbacks.length; };
global.cancelAnimationFrame = () => {};

const { MediaVolumeController } = require('../dist-test/controller.js');
const settings = {
  enabled: true,
  fullAudioAnalysis: false,
  targetRms: 0.09650504109445904,
  minGain: 0.25,
  maxGain: 2,
  bassBoost: 0,
  gainChangePerSec: 0.2
};

function setVisibility(state) {
  global.document.visibilityState = state;
  global.document.hidden = state === 'hidden';
  for (const listener of documentListeners.get('visibilitychange') || []) listener();
}

test('controller connects continuous stereo meter and drives gain state', async () => {
  const media = new FakeMedia();
  let state = null;
  const controller = new MediaVolumeController(media, settings, (next) => { state = next; }, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  const worklet = global.lastWorklet;
  assert.equal(worklet.options.numberOfInputs, 2);
  assert.equal(worklet.options.channelCountMode, 'explicit');
  assert.deepEqual(worklet.options.outputChannelCount, [2]);
  assert.ok(controller.bass.connections.some((item) => item.destination === worklet && item.input === 1));

  for (let index = 0; index < 200; index++) {
    const original = new Float32Array(128).fill(0.1);
    const processed = new Float32Array(128).fill(0.1);
    worklet.processor.process(
      [[processed, processed], [original, original]],
      [[new Float32Array(128), new Float32Array(128)]]
    );
  }
  media.currentTime = 1;
  rafCallbacks[0]();

  assert.ok(state.originalRms > 0);
  assert.ok(Number.isFinite(state.gain));
  controller.destroy();
});

test('background ticks do not run realtime gain control', async (t) => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    setVisibility('visible');
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  controller.gain.gain.value = 0.6;
  controller.updateGain = () => controller.setGain(1.5);
  setVisibility('hidden');
  controller.tick();

  assert.equal(controller.gain.gain.value, 0.6);
});

test('source changes without emptied reset gain and histories on play or meter', async () => {
  const media = new FakeMedia();
  media.currentSrc = 'blob:original';
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.gain.gain.value = 0.8;
  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  controller.agc.lockGain(1.3);
  media.currentSrc = 'blob:replacement';
  media.dispatchEvent(new Event('play'));

  assert.equal(controller.gain.gain.value, .5);
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
  assert.equal(controller.agc.isLocked(), false);

  controller.gain.gain.value = 0.8;
  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  controller.agc.lockGain(1.3);
  media.currentSrc = 'blob:replacement-again';
  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(4800).fill(0.2)],
    output: [new Float32Array(4800).fill(0.2)]
  });

  assert.equal(controller.gain.gain.value, .5);
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
  assert.equal(controller.agc.isLocked(), false);
  controller.destroy();
});

test('Bilibili SPA route changes reset same-blob media identity', async (t) => {
  const previousLocation = global.location;
  global.location = { hostname: 'www.bilibili.com', pathname: '/video/BV1', search: '?p=1' };
  const media = new FakeMedia();
  media.currentSrc = 'blob:shared';
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  controller.gain.gain.value = 0.8;
  global.location.search = '?p=2';
  media.dispatchEvent(new Event('play'));
  assert.equal(controller.gain.gain.value, .5);

  controller.gain.gain.value = 0.8;
  global.location.pathname = '/video/BV2';
  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(4800).fill(0.2)],
    output: [new Float32Array(4800).fill(0.2)]
  });
  assert.equal(controller.gain.gain.value, .5);
});

test('background real meter messages advance AGC while animation frames do not', async (t) => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    setVisibility('visible');
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  const updates = [];
  controller.updateGain = (duration) => updates.push(duration);
  setVisibility('hidden');
  controller.tick();
  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(19200).fill(0.2)],
    output: [new Float32Array(19200).fill(0.2)]
  });

  assert.deepEqual(updates, [0.4]);
});

test('a new video resets programme gain even when the page is hidden', async (t) => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    setVisibility('visible');
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  controller.gain.gain.value = 0.6;
  setVisibility('hidden');
  media.dispatchEvent(new Event('emptied'));

  assert.equal(controller.gain.gain.value, .5);
});

test('visibility changes preserve measurements, epoch and programme gain', async (t) => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    setVisibility('visible');
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  const processor = global.lastWorklet.processor;
  for (let start = 0; start < 48000; start += 128) {
    const tone = Float32Array.from({ length: 128 }, (_, i) =>
      .8 * Math.sin(2 * Math.PI * 1000 * (start + i) / 48000));
    processor.process([[tone, tone]], [[new Float32Array(128), new Float32Array(128)]]);
  }
  const epoch = controller.meterEpoch;
  const measuredSeconds = controller.originalMeter.getIntegrationTime();
  const gain = controller.gain.gain.value;
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(controller.meterEpoch, epoch);
  assert.equal(controller.originalMeter.getIntegrationTime(), measuredSeconds);
  assert.equal(controller.gain.gain.value, gain);
});

test('reducing the configured maximum cannot raise a safety-attenuated gain', async () => {
  const controller = new MediaVolumeController(new FakeMedia(), settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  controller.gain.gain.value = 0.158;
  controller.allowBelowMinGain = true;
  controller.updateSettings({ ...settings, maxGain: 1 });
  assert.equal(controller.gain.gain.value, 0.158);
  controller.destroy();
});

test('processor failure mutes protected output rather than retaining a boost', async () => {
  const controller = new MediaVolumeController(new FakeMedia(), settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  controller.gain.gain.value = 1.8;
  global.lastWorklet.onprocessorerror({ message: 'test failure' });
  assert.equal(controller.gain.gain.value, 0);
  controller.updateSettings({ ...settings, maxGain: 3 });
  assert.equal(controller.gain.gain.value, 0);
  controller.destroy();
});

test('target changes reopen programme calibration without replacing the processor', async () => {
  const controller = new MediaVolumeController(new FakeMedia(), settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const processor = global.lastWorklet.processor;
  controller.agc.lockGain(.8);
  controller.updateSettings({ ...settings, targetRms: Math.pow(10, (-23 + 0.691) / 20) });
  assert.equal(global.lastWorklet.processor, processor);
  assert.equal(controller.agc.isLocked(), false);
  controller.destroy();
});

test('target changes clear output programme history but preserve input AGC history', async () => {
  const controller = new MediaVolumeController(new FakeMedia(), settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(19200).fill(0.2)],
    output: [new Float32Array(19200).fill(0.2)]
  });
  const inputSeconds = controller.originalMeter.getIntegrationTime();
  const inputReference = controller.gainState.referenceLufs;
  const activeSeconds = controller.agc.history.getActiveSeconds();
  assert.ok(Number.isFinite(controller.outputProgramme.getLoudness()));
  assert.ok(Number.isFinite(inputReference));

  controller.updateSettings({ ...settings, targetRms: Math.pow(10, (-23 + 0.691) / 20) });

  assert.equal(controller.outputProgramme.getLoudness(), Number.NaN);
  assert.equal(controller.originalMeter.getIntegrationTime(), inputSeconds);
  assert.equal(controller.gainState.referenceLufs, inputReference);
  assert.equal(controller.agc.history.getActiveSeconds(), activeSeconds);
  assert.equal(controller.agc.history.getLoudness(), inputReference);
  controller.destroy();
});

test('reenabling starts conservatively with empty realtime measurements', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.gain.gain.value = 1.8;
  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  controller.updateSettings({ ...settings, enabled: false });
  controller.updateSettings({ ...settings, enabled: true });

  assert.equal(controller.gain.gain.value, .5);
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
  controller.destroy();
});

test('stale worklet meter epochs are ignored after a lifecycle transition', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  const staleEpoch = controller.meterEpoch - 1;
  controller.consumeAudio({
    type: 'meter',
    epoch: staleEpoch,
    original: [new Float32Array(4800).fill(0.2)],
    output: [new Float32Array(4800).fill(0.2)]
  });

  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
  controller.destroy();
});

test('seeking resets measurements but keeps the calibration anchor', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  assert.ok(controller.originalMeter.getIntegrationTime() > 0);
  controller.agc.lockGain(1.3);

  media.dispatchEvent(new Event('seeked'));

  // 测量窗口重置，但 AGC 状态（锚点/锁定）保留，gain 不会重新快速校准
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
  assert.equal(controller.agc.isLocked(), true);
  controller.destroy();
});

test('full-track analysis waits for playback before fetching', async () => {
  const media = new FakeMedia();
  media.paused = true;
  const controller = new MediaVolumeController(
    media,
    { ...settings, fullAudioAnalysis: true },
    () => {},
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.analysisStatus, 'waiting-play');
  assert.equal(controller.analysisAbort, null);
  assert.equal(controller.analysisAttemptKey, null);

  media.paused = false;
  media.dispatchEvent(new Event('play'));
  assert.equal(controller.analysisAttemptKey, controller.analysisKey());
  controller.destroy();
});

test('destroyed controller detaches processor handlers and never reconnects', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  const worklet = global.lastWorklet;
  controller.destroy();

  assert.equal(worklet.port.onmessage, null);
  assert.equal(worklet.onprocessorerror, null);
  assert.equal(worklet.context.source.connections.length, 0);

  // 迟到的处理器错误不应复活音频图
  worklet.onprocessorerror?.({});
  assert.equal(worklet.context.source.connections.length, 0);
  controller.destroy();
});

test('disabled controller emits an empty meter state', async () => {
  const media = new FakeMedia();
  let state = null;
  const controller = new MediaVolumeController(
    media,
    settings,
    (next) => { state = next; },
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));

  controller.originalRms = 0.4;
  controller.updateSettings({ ...settings, enabled: false });
  controller.emitMeter();

  assert.equal(state.rms, 0);
  assert.equal(state.originalRms, 0);
  assert.equal(state.gain, 1);
  controller.destroy();
});

test('a failed full-track source is not retried on every play', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.settings = { ...controller.settings, fullAudioAnalysis: true };
  controller.analysisAttemptKey = controller.analysisKey();
  controller.startAnalysis();

  assert.equal(controller.analysisAbort, null);
  controller.destroy();
});

test('returning to a tab preserves a completed full-track gain lock', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.settings = { ...controller.settings, fullAudioAnalysis: true };
  controller.analysisResult = {
    integratedLufs: -24,
    samplePeak: 0.2,
    estimatedTruePeak: 0.2,
    duration: 60,
    sourceUrl: 'https://example.test/audio'
  };
  controller.applyFullTrackGain();
  assert.equal(controller.agc.isLocked(), true);

  setVisibility('hidden');
  setVisibility('visible');

  assert.equal(controller.agc.isLocked(), true);
  controller.destroy();
});
