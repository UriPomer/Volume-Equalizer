import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { writeFloatWav } from './audio-test-artifacts.mjs';

// Failure contracts: a setting affects another platform; existing tabs ignore it;
// reload loses it; disabled pages capture media; page controls overwrite platform
// choices or DSP settings; live opt-in bypasses a disabled platform.
// Uses the unpacked extension, native storage, content scripts and audio worklets.
// Local HTTP fixtures replace only platform servers and media content.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-platform-settings-'));
const extension = resolve('dist');
const extensionId = createHash('sha256').update(extension).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
const fixture = join(artifacts, 'input.wav');
writeFloatWav(fixture, Float32Array.from({ length: 48000 * 3 }, (_, i) => .1 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 48000, 1);
const report = { command: 'npm run test:settings', pass: false, cases: [], hashes: {} };
for (const file of ['content.js', 'options.js', 'options.html', 'manifest.json']) {
  report.hashes[file] = createHash('sha256').update(readFileSync(join(extension, file))).digest('hex');
}
report.hashes.test = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const server = createServer((req, res) => {
  if (req.url === '/input.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(readFileSync(fixture));
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Platform media fixture</title><video controls loop src="/input.wav"></video>');
  }
});
let context;
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const hosts = ['www.bilibili.com', 'www.youtube.com', 'example.org', 'www.youtube-nocookie.com', 'www.youtube.com.example.org'];
const panel = page => page.locator('#universal-volume-eq-panel');
const enabledButton = page => panel(page).locator('[data-action="enabled"]');
async function state(page, enabled) {
  await page.waitForFunction(expected => document.getElementById('universal-volume-eq-panel')?.shadowRoot
    .querySelector('[data-action="enabled"]').textContent === expected, enabled ? '已开启' : '已关闭');
  if (enabled) await page.waitForFunction(() => document.getElementById('universal-volume-eq-panel')?.shadowRoot
    .querySelector('[data-meter="originalIntegrated"]').textContent.includes('LUFS'));
  assert.equal(await page.locator('video').evaluate(video => video.paused), false);
}
async function check(name, run) {
  await run();
  report.cases.push({ name, pass: true });
}
try {
  context = await chromium.launchPersistentContext(join(artifacts, 'profile'), {
    channel: 'chromium', executablePath: process.env.CHROME_PATH, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--autoplay-policy=no-user-gesture-required', '--no-proxy-server',
      '--host-resolver-rules=MAP * 127.0.0.1',
      '--unsafely-treat-insecure-origin-as-secure=' + hosts.map(host => `http://${host}:${port}`).join(',')]
  });
  context.setDefaultTimeout(10000);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const options = await context.newPage();
  const errors = [];
  options.on('pageerror', error => errors.push(String(error)));
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#enabled').waitFor();
  await options.waitForFunction(() => !document.querySelector('#enabled').disabled);
  const storage = () => options.evaluate(() => chrome.storage.local.get(null));
  const toggle = async (key, value) => {
    await options.locator(`#${key}`).setChecked(value);
    await options.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert.equal((await storage())[key], value);
  };
  const pages = [];
  for (const host of hosts) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://${host}:${port}/watch?v=fixture`);
    await panel(page).waitFor();
    await page.locator('video').evaluate(video => video.play());
    pages.push(page);
  }
  await check('defaults-enable-all-platforms', async () => {
    for (const key of ['enabled', 'bilibiliEnabled', 'youtubeEnabled', 'otherEnabled']) {
      assert.equal(await options.locator(`#${key}`).isChecked(), true);
    }
    for (const page of pages) await state(page, true);
  });
  const [bili, youtube, other, embedded, lookalike] = pages;
  await check('independent-switches-and-live-tab-updates', async () => {
    await toggle('bilibiliEnabled', false);
    await state(bili, false); await state(youtube, true); await state(other, true);
    await toggle('youtubeEnabled', false);
    await state(youtube, false); await state(embedded, false); await state(lookalike, true);
    await toggle('otherEnabled', false);
    await state(other, false); await state(lookalike, false);
    await toggle('bilibiliEnabled', true);
    await state(bili, true); await state(youtube, false); await state(other, false);
  });
  await check('persistence-and-disabled-cold-start', async () => {
    await options.reload();
    await options.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert.equal(await options.locator('#youtubeEnabled').isChecked(), false);
    assert.equal(await options.locator('#otherEnabled').isChecked(), false);
    await youtube.reload();
    await panel(youtube).waitFor();
    await youtube.locator('video').evaluate(video => video.play());
    await state(youtube, false);
    const cdp = await context.newCDPSession(youtube);
    await cdp.send('WebAudio.enable');
    const contexts = [];
    cdp.on('WebAudio.contextCreated', event => contexts.push(event));
    await youtube.reload();
    await panel(youtube).waitFor();
    await youtube.locator('video').evaluate(video => video.play());
    await state(youtube, false);
    assert.equal(contexts.length, 0, 'Cold disabled platform must not create an AudioContext');
    await cdp.detach();
  });
  await check('page-controls-preserve-unrelated-preferences', async () => {
    await panel(bili).locator('.dock').hover();
    await enabledButton(bili).click();
    await state(bili, false);
    await options.waitForFunction(() => !document.querySelector('#bilibiliEnabled').checked);
    assert.equal((await storage()).enabled, undefined, 'Platform off must not disable the global preference');
    await enabledButton(bili).click();
    await state(bili, true);
    await panel(bili).locator('[data-role="bassBoost"]').evaluate(input => {
      input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await options.waitForFunction(async () => (await chrome.storage.local.get('bassBoost')).bassBoost === 2);
    await toggle('youtubeEnabled', true);
    await state(youtube, true); await state(embedded, true); await state(other, false);
    assert.equal((await storage()).bassBoost, 2);
    assert.equal((await storage()).otherEnabled, false);
  });
  await check('master-switch-retains-platform-choices', async () => {
    await toggle('enabled', false);
    for (const page of pages) await state(page, false);
    await toggle('enabled', true);
    await state(bili, true); await state(youtube, true); await state(other, false);
    assert.equal(await options.locator('#otherEnabled').isChecked(), false);
  });
  await check('platform-disabled-overrides-live-opt-in', async () => {
    await youtube.evaluate(() => {
      const player = document.createElement('div');
      player.className = 'html5-video-player ytp-live';
      document.body.append(player);
    });
    await state(youtube, false);
    await panel(youtube).locator('.dock').hover();
    await enabledButton(youtube).click();
    await state(youtube, true);
    await toggle('youtubeEnabled', false);
    await state(youtube, false);
    assert.equal(await enabledButton(youtube).isDisabled(), true);
    await toggle('youtubeEnabled', true);
    await state(youtube, true);
    await youtube.evaluate(() => document.querySelector('.html5-video-player').remove());
    await state(youtube, true);
  });
  await check('failed-save-can-be-retried', async () => {
    await options.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = (...args) => {
        chrome.storage.local.set = original;
        throw new Error('Injected storage write failure');
      };
    });
    await options.locator('#youtubeEnabled').uncheck();
    await options.locator('#retry').waitFor({ state: 'visible' });
    assert.equal((await storage()).youtubeEnabled, true);
    await state(youtube, true);
    await options.locator('#retry').click();
    await options.waitForFunction(() => document.querySelector('#retry').hidden);
    assert.equal((await storage()).youtubeEnabled, false);
    await state(youtube, false);
    await toggle('youtubeEnabled', true);
  });
  await check('failed-load-keeps-controls-disabled-until-retry', async () => {
    const failed = await context.newPage();
    await failed.addInitScript(() => {
      if (!globalThis.chrome?.storage?.local) return;
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (...args) => {
        chrome.storage.local.get = original;
        throw new Error('Injected storage read failure');
      };
    });
    await failed.goto(`chrome-extension://${extensionId}/options.html`);
    await failed.locator('#retry').waitFor({ state: 'visible' });
    assert.equal(await failed.locator('#enabled').isDisabled(), true);
    await failed.locator('#retry').click();
    await failed.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert.equal(await failed.locator('#bilibiliEnabled').isChecked(), true);
    await failed.close();
  });
  await options.screenshot({ path: join(artifacts, 'settings-light.png'), fullPage: true });
  await options.emulateMedia({ colorScheme: 'dark' });
  await options.screenshot({ path: join(artifacts, 'settings-dark.png'), fullPage: true });
  await options.setViewportSize({ width: 360, height: 640 });
  await check('popup-layout-and-keyboard-access', async () => {
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await options.locator('#otherEnabled').focus();
    await options.keyboard.press('Space');
    await options.waitForFunction(() => !document.querySelector('#otherEnabled').disabled);
    assert.equal((await storage()).otherEnabled, true);
    await state(other, true);
    await options.screenshot({ path: join(artifacts, 'settings-popup.png'), fullPage: true });
  });
  report.storage = await storage();
  report.errors = errors;
  assert.deepEqual(errors, []);
  report.pass = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  try { await context?.tracing.stop({ path: join(artifacts, 'trace.zip') }); }
  finally { await context?.close(); server.close(); }
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifacts }, null, 2));
}
