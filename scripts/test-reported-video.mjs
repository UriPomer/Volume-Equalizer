import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { sha256 } from './audio-test-artifacts.mjs';
import { continuityBootstrap, continuityProcessor } from './browser-continuity-capture.mjs';
import { ContinuityRecording, saveContinuityPcm } from './continuity-artifacts.mjs';
import { measureWithFfmpeg } from './offline-loudness-reference.mjs';

// Follow a page link into the real Bilibili player, with the actual MV3
// bundle/storage/worklet installed, at 1x. Fail on stopped playback, processor
// errors, recording gaps, or audible input with missing destination output.
// The observer adds zero-output taps. It never replaces media responses, DSP,
// settings, gain, or Chrome APIs. CI uses --lifecycle with local native media.
const lifecycle = process.argv.includes('--lifecycle');
const fixture = process.env.VOLUME_EQ_REFERENCE_AUDIO;
const localMedia = lifecycle && !!fixture;
const videoUrl = process.env.VOLUME_EQ_VIDEO_URL || 'https://www.bilibili.com/video/BV1cK411W7QZ/';
const loops = Number(process.env.VOLUME_EQ_PLAYBACK_LOOPS || 1);
assert.ok(Number.isInteger(loops) && loops >= 1 && loops <= 3, 'One to three complete native playbacks');
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-continuity-'));
const extensionDirectory = process.env.VOLUME_EQ_EXTENSION_DIR || resolve('dist');
const content = readFileSync(join(extensionDirectory, 'content.js'));
const worklet = readFileSync(join(extensionDirectory, 'limiter-worklet.js'));
const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8'));
const [major, ...rest] = manifest.version.split('.').map(Number);
assert.ok(major === 0 || (major === 1 && rest.every(part => part === 0)), 'Version must not exceed 1.0');
const nativeDirectory = join(artifacts, 'installed-extension');
mkdirSync(nativeDirectory);
writeFileSync(join(nativeDirectory, 'content.js'), content);
writeFileSync(join(nativeDirectory, 'limiter-worklet.js'), worklet);
writeFileSync(join(nativeDirectory, 'observe-audio.js'), continuityBootstrap("chrome.runtime.getURL('observe-audio-worklet.js')"));
writeFileSync(join(nativeDirectory, 'observe-audio-worklet.js'), continuityProcessor);
manifest.content_scripts[0].js.unshift('observe-audio.js');
manifest.web_accessible_resources[0].resources.push('observe-audio-worklet.js');
writeFileSync(join(nativeDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const report = { command: 'node scripts/test-reported-video.mjs' + (lifecycle ? ' --lifecycle' : ''),
  mode: lifecycle ? localMedia ? 'native-media-lifecycle' : 'bilibili-page-lifecycle' : 'bilibili-page', source: localMedia ? fixture : videoUrl,
  generatedAt: new Date().toISOString(), contentSha256: sha256(content), workletSha256: sha256(worklet),
  testSourceSha256: sha256(readFileSync(new URL(import.meta.url))),
  config: { loops, extensionDirectory, browserExecutable: process.env.CHROME_PATH || chromium.executablePath() },
  console: [], network: [], trace: [], lifecycle: [], mediaEvents: [], playbacks: [], sitePauses: [], pass: false };
const server = createServer((req, res) => {
  if (req.url === '/fixture' && localMedia) { res.setHeader('Content-Type', 'audio/mp4'); res.end(readFileSync(fixture)); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(localMedia ? '<!doctype html><div id="player"><audio controls src="/fixture"></audio></div>'
    : '<!doctype html><meta charset="utf-8"><a href="' + videoUrl + '">打开用户报告的视频</a>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const recordings = new Map(), extensionContexts = new Set();
let context, page, cdp, contextId, rate, evaluate;
async function state() {
  return evaluate(`(()=>{const recorder=window.continuity,media=recorder.media,root=document.getElementById('universal-volume-eq-panel')?.shadowRoot;
    const text=key=>root?.querySelector('[data-meter="'+key+'"]')?.textContent;
    return {url:location.href,time:media.currentTime,duration:media.duration,paused:media.paused,ended:media.ended,
      playbackRate:media.playbackRate,muted:media.muted,volume:media.volume,connected:media.isConnected,readyState:media.readyState,
      mediaError:media.error?.message,contextTime:recorder.context.currentTime,contextState:recorder.context.state,
      input:parseFloat(text('original')),output:parseFloat(text('output')),gain:parseFloat(text('gain')),
      inputIntegrated:parseFloat(text('originalIntegrated')),
      integrationSeconds:parseInt(text('originalIntegrated')?.split('·')[1]),
      status:text('status'),recordingError:recorder.error};})()`);
}
async function observe(seconds) {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) { report.trace.push(await state()); await delay(200); }
}
async function findExtensionContext() {
  for (const id of extensionContexts) {
    try {
      const result = await cdp.send('Runtime.evaluate', { expression: '!!window.continuity?.mediaSources&&[...window.continuity.mediaSources.keys()].some(media=>media.hasAttribute("data-volume-eq-primary"))', contextId: id, returnByValue: true });
      if (result.result?.value) return id;
    } catch { /* navigation invalidates old execution contexts */ }
  }
  return null;
}
try {
  context = await chromium.launchPersistentContext(join(artifacts, 'browser-profile'), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROME_PATH,
    chromiumSandbox: true, viewport: { width: 1440, height: 1000 },
    args: ['--disable-extensions-except=' + nativeDirectory, '--load-extension=' + nativeDirectory]
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = context.pages()[0];
  page.on('pageerror', error => report.console.push({ type: 'pageerror', message: String(error) }));
  page.on('console', message => { if (message.type() === 'error') report.console.push({ type: 'console', message: message.text() }); });
  page.on('requestfailed', request => report.network.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => {
    if (/bilivideo|\/playurl/.test(response.url())) report.network.push({ url: response.url(), status: response.status() });
  });
  cdp = await context.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (!context.auxData?.isDefault) extensionContexts.add(context.id);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => extensionContexts.delete(executionContextId));
  cdp.on('Runtime.bindingCalled', event => {
    if (event.name !== '__volumeEqRecording') return;
    const packet = JSON.parse(event.payload);
    if (!recordings.has(event.executionContextId)) recordings.set(event.executionContextId, new ContinuityRecording(artifacts, event.executionContextId));
    const recording = recordings.get(event.executionContextId); recording.append(packet);
    if (recording.error) report.recordingError = recording.error;
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__volumeEqRecording' });
  await page.goto(baseUrl);
  if (!localMedia) {
    await page.getByRole('link', { name: '打开用户报告的视频' }).click();
    await page.waitForURL(videoUrl + '*');
    report.navigation = { from: baseUrl, clickedLink: videoUrl, landedUrl: page.url(), title: await page.title() };
  }
  const mediaLocator = page.locator(localMedia ? 'audio' : 'video').first();
  await mediaLocator.waitFor({ timeout: 30000 });
  const media = await mediaLocator.elementHandle();
  assert.ok(media, 'Keep the same native media through detach and reattach');
  await media.evaluate(element => element.setAttribute('data-volume-eq-primary', ''));
  for (let i = 0; i < 150 && !contextId; i++) { contextId = await findExtensionContext(); if (!contextId) await delay(200); }
  assert.ok(contextId, 'The actual installed extension must attach to the page media');
  evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await evaluate('window.continuity.media=document.querySelector("[data-volume-eq-primary]")');
  await evaluate('window.continuity.ready');
  rate = await evaluate('window.continuity.context.sampleRate');
  report.browser = context.browser().version();
  report.extension = await evaluate('({id:chrome.runtime.id,version:chrome.runtime.getManifest().version})');
  assert.equal(report.extension.version, manifest.version, 'Native manifest version');
  report.defaultTarget = await page.locator('#universal-volume-eq-panel [data-value="targetLufs"]').textContent();
  if (!process.env.VOLUME_EQ_EXTENSION_DIR) assert.equal(report.defaultTarget, '-17.5 LUFS', 'Native default target');
  await media.evaluate(element => { element.volume = 1; element.muted = false; element.playbackRate = 1; });
  await media.evaluate(element => { if (element.paused) return element.play(); });
  await page.screenshot({ path: join(artifacts, 'started.png') });
  if (lifecycle) {
    await observe(10);
    if (localMedia) await page.evaluate(async () => {
      const preview = document.createElement('video'); preview.id = 'muted-preview'; preview.muted = true; preview.src = '/fixture';
      document.body.append(preview); await preview.play();
    });
    if (localMedia) {
      await observe(2);
      const previewState = await state(); report.lifecycle.push({ action: 'muted-preview', ...previewState });
      assert.ok(Number.isFinite(previewState.inputIntegrated), 'A muted preview must not replace the audible main programme in the panel');
      await page.locator('#muted-preview').evaluate(element => element.pause());
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = await state(); report.lifecycle.push({ action: 'detach', ...before });
      await media.evaluate(async element => { window.testMedia = element; window.testMediaParent = element.parentNode; element.remove(); await new Promise(resolve => setTimeout(resolve, 250)); await element.play(); });
      await observe(1.5);
      const detached = await state();
      assert.equal(detached.paused, false, 'Detached source must really play');
      assert.ok(detached.time > before.time + 1, 'A stalled reference cannot pass');
      await page.evaluate(async () => { window.testMediaParent.append(window.testMedia); await window.testMedia.play(); });
      await observe(4);
      const attached = await state(); report.lifecycle.push({ action: 'reattach', ...attached });
      assert.ok(attached.integrationSeconds >= before.integrationSeconds + 4, 'Moving the same playing media must preserve its cumulative reference');
    }
    if (localMedia) {
      await media.evaluate(element => { element.pause(); element.remove(); });
      await observe(1.5);
      const idle = await state(); report.lifecycle.push({ action: 'stopped-primary-with-idle-preview', ...idle });
      assert.equal(idle.integrationSeconds, 0, 'Removing the active programme must clear its displayed history even while an idle preview remains');
      assert.equal(idle.gain, 1, 'An idle panel cannot present the previous programme gain as current');
      await media.evaluate(element => element.play());
      await observe(1.5);
      const released = await state(); report.lifecycle.push({ action: 'late-detached-original-playback', ...released });
      assert.ok(!released.paused && released.time > idle.time + 1, 'An already released detached media must still play original audio');
    }
  } else {
    for (let playback = 0; playback < loops; playback++) {
      const started = Date.now(); let lastTime = -1, lastProgress = Date.now();
      const after = report.playbacks.at(-1)?.contextTime || 0;
      for (;;) {
        const current = await state(); report.trace.push(current);
        const events = await evaluate('window.continuity.events.filter(event=>event.primary)');
        assert.ok(!current.mediaError && !current.recordingError && !report.recordingError, 'Media and recorder cannot silently fail');
        assert.equal(current.contextState, 'running', 'AudioContext must stay running');
        assert.equal(current.playbackRate, 1, 'Normal playback speed');
        assert.equal(current.muted, false, 'The player must remain unmuted');
        assert.equal(current.status, '实时', 'Fallback is not a normalization success');
        if (current.time > lastTime) { lastTime = current.time; lastProgress = Date.now(); }
        assert.ok(Date.now() - lastProgress < 15000, 'Player stalled for 15 seconds');
        assert.ok(Date.now() - started < 20 * 60 * 1000, 'Bounded programme playback');
        if (current.ended || events.some(event => event.type === 'ended' && event.contextTime > after)) {
          report.playbacks.push(current); break;
        }
        if (current.paused) {
          const closeLogin = page.locator('.bili-mini-mask .bili-mini-close-icon');
          await closeLogin.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
          assert.ok(await closeLogin.isVisible(), 'Unexpected pause without the site login dialog');
          assert.ok(report.sitePauses.length < loops + 1, 'Bounded site login prompts');
          await page.screenshot({ path: join(artifacts, 'site-login-pause-' + report.sitePauses.length + '.png') });
          report.sitePauses.push({ reason: 'visible-login-dialog', ...current });
          await closeLogin.click(); await closeLogin.waitFor({ state: 'hidden' });
          if ((await state()).paused) await page.getByRole('button', { name: '播放/暂停', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[data-volume-eq-primary]').paused, null, { timeout: 5000 });
          lastProgress = Date.now();
          continue;
        }
        assert.equal(current.paused, false, 'Unexpected pause');
        assert.ok(current.url.startsWith(videoUrl), 'Remain on the reported video');
        if (report.trace.length % 150 === 0) console.log(JSON.stringify({ playback: playback + 1, time: current.time, duration: current.duration, gain: current.gain }));
        await delay(200);
      }
      assert.ok(report.playbacks.at(-1).time >= report.playbacks.at(-1).duration - .5, 'Complete the entire native programme');
      if (playback + 1 < loops) {
        await media.evaluate(element => { element.currentTime = 0; });
        await page.getByRole('button', { name: '播放/暂停', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('video').paused);
      }
    }
  }
  await media.evaluate(element => element.pause()); await delay(250);
  await evaluate('window.continuity.recorder.port.onmessage=null');
  report.mediaEvents = await evaluate('window.continuity.events.filter(event=>event.primary)');
  report.graph = await evaluate('window.continuity.graphs'); report.gains = await evaluate('window.continuity.gains');
  saveContinuityPcm(artifacts, recordings.get(contextId), rate, report);
  if (!lifecycle) {
    report.independentLoudness = {
      input: measureWithFfmpeg(join(artifacts, 'original.wav')),
      output: measureWithFfmpeg(join(artifacts, 'output.wav'))
    };
    const target = Number.parseFloat(report.defaultTarget);
    const minimum = await page.locator('#universal-volume-eq-panel [data-role="minGain"]').inputValue();
    const maximum = await page.locator('#universal-volume-eq-panel [data-role="maxGain"]').inputValue();
    const input = report.independentLoudness.input.integratedLufs;
    const expected = Math.min(input + 20 * Math.log10(Number(maximum)), Math.max(input + 20 * Math.log10(Number(minimum)), target));
    report.independentLoudness.expectedOutputLufs = expected;
    assert.ok(Math.abs(report.independentLoudness.output.integratedLufs - expected) <= 1,
      'The full programme average must remain within 1 LU of the target reachable with the configured gain bounds');
  }
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  if (rate && !report.pcm) {
    try { await evaluate('window.continuity.recorder.port.onmessage=null'); report.mediaEvents = await evaluate('window.continuity.events.filter(event=>event.primary)'); saveContinuityPcm(artifacts, recordings.get(contextId), rate, report); }
    catch (error) { report.pcmError = String(error); }
  }
  try {
    if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'final.png') });
    await context?.tracing.stop({ path: join(artifacts, 'trace.zip') });
  } finally {
    await context?.close(); server.close();
    for (const recording of recordings.values()) recording.close();
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
  }
}
