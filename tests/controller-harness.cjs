const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadProcessor() {
  const processors = new Map();
  const context = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage() {} }; }
    },
    registerProcessor(name, klass) {
      processors.set(name, klass);
    }
  };
  vm.createContext(context);
  vm.runInContext(
    require('./worklet-source.cjs')(),
    context
  );
  return processors;
}

const processorClasses = loadProcessor();

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
  resume() { return Promise.resolve(); }
}

class FakeWorkletNode extends FakeNode {
  constructor(context, name, options) {
    super();
    this.context = context;
    this.name = name;
    this.options = options;
    this.parameters = new Map();
    this.processor = new (processorClasses.get(name))(options);
    this.port = {
      onmessage: null,
      postMessage: (data) => this.processor.port.onmessage?.({ data })
    };
    this.processor.port.postMessage = (data) => this.port.onmessage?.({ data });
    if (name === 'lookahead-peak-limiter') global.lastWorklet = this;
    else global.lastMeter = this;
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

let nextFrameId = 0;
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
global.requestAnimationFrame = () => ++nextFrameId;
global.cancelAnimationFrame = () => {};

const { MediaVolumeController } = require('../dist-test/controller.js');
const { INITIAL_GAIN } = require('../dist-test/config.js');
const settings = {
  enabled: true,
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


module.exports = { FakeMedia, MediaVolumeController, INITIAL_GAIN, settings, setVisibility };
