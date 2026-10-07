const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeMedia, MediaVolumeController, INITIAL_GAIN, settings, setVisibility } = require('./controller-harness.cjs');

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

  controller.gain.gain.value = 1.2;
  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  media.currentSrc = 'blob:replacement';
  media.dispatchEvent(new Event('play'));

  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);

  controller.gain.gain.value = 1.2;
  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  media.currentSrc = 'blob:replacement-again';
  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(4800).fill(0.2)],
    output: [new Float32Array(4800).fill(0.2)]
  });

  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
  assert.equal(controller.originalMeter.getIntegrationTime(), 0);
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

  controller.gain.gain.value = 1.2;
  global.location.search = '?p=2';
  media.dispatchEvent(new Event('play'));
  assert.equal(controller.gain.gain.value, INITIAL_GAIN);

  controller.gain.gain.value = 1.2;
  global.location.pathname = '/video/BV2';
  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(4800).fill(0.2)],
    output: [new Float32Array(4800).fill(0.2)]
  });
  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
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

  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
});

test('visibility changes preserve measurements, epoch and programme gain', async (t) => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  t.after(() => {
    setVisibility('visible');
    controller.destroy();
  });
  await new Promise((resolve) => setImmediate(resolve));

  const processor = (global.lastMeter ?? global.lastWorklet).processor;
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
  controller.updateSettings({ ...settings, targetRms: Math.pow(10, (-23 + 0.691) / 20) });
  assert.equal(global.lastWorklet.processor, processor);
  controller.destroy();
});

test('target changes clear output integration but preserve the input reference', async () => {
  const controller = new MediaVolumeController(new FakeMedia(), settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.consumeAudio({
    type: 'meter',
    epoch: controller.meterEpoch,
    original: [new Float32Array(19200).fill(0.2)],
    output: [new Float32Array(19200).fill(0.2)]
  });
  const inputSeconds = controller.originalMeter.getIntegrationTime();
  const inputReference = controller.originalMeter.getIntegratedLoudness();
  const processor = global.lastWorklet.processor;
  for (let start = 0; start < 19200; start += 128) {
    const tone = Float32Array.from({length:128}, (_, i) => .2 * Math.sin(2 * Math.PI * 1000 * (start+i)/48000));
    processor.process([[tone,tone]], [[new Float32Array(128),new Float32Array(128)]]);
  }
  assert.ok(Number.isFinite(controller.output.getState().outputIntegratedLufs));
  assert.ok(Number.isFinite(inputReference));

  controller.updateSettings({ ...settings, targetRms: Math.pow(10, (-23 + 0.691) / 20) });

  assert.equal(controller.output.getState().outputIntegratedLufs, Number.NaN);
  assert.equal(controller.originalMeter.getIntegrationTime(), inputSeconds);
  assert.equal(controller.gainState.referenceLufs, inputReference);
  assert.equal(controller.originalMeter.getIntegratedLoudness(), inputReference);
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

  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
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

test('seeking resets live windows but keeps integration and the calibration anchor', async () => {
  const media = new FakeMedia();
  const controller = new MediaVolumeController(media, settings, () => {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  controller.originalMeter.processBlock(new Float32Array(48000).fill(0.1));
  assert.ok(controller.originalMeter.getIntegrationTime() > 0);
  const integrationTime = controller.originalMeter.getIntegrationTime();
  const integratedLufs = controller.originalMeter.getIntegratedLoudness();

  media.dispatchEvent(new Event('seeked'));

  assert.equal(controller.originalMeter.getIntegrationTime(), integrationTime);
  assert.equal(controller.originalMeter.getIntegratedLoudness(), integratedLufs);
  assert.ok(Number.isNaN(controller.originalMeter.getMomentaryLoudness()));
  assert.equal(controller.gain.gain.value, INITIAL_GAIN);
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

  controller.updateSettings({ ...settings, enabled: false });
  controller.emitMeter();

  assert.ok(Number.isNaN(state.outputIntegratedLufs));
  assert.ok(Number.isNaN(state.originalIntegratedLufs));
  assert.equal(state.gain, 1);
  controller.destroy();
});
