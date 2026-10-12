import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { writeFloatWav } from './audio-test-artifacts.mjs';

// Failure contracts: live audio is intercepted before opt-in; recorded videos
// are mistaken for live; a live override changes the global preference; late
// live metadata, SPA navigation, or storage events silently enable a stream.
// Production content/DSP and native media run unchanged. Only site markup,
// chrome.storage and extension URL resolution are fixture adapters.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-live-pages-'));
const content = readFileSync('dist/content.js');
const worklet = readFileSync('dist/limiter-worklet.js');
let servedHtml = '';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wav') ? 'audio/wav' : 'text/html');
  res.end(path === '/content.js' ? content : path === '/limiter-worklet.js' ? worklet : path === '/input.wav' ? readFileSync(fixture) : servedHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const version = JSON.parse(readFileSync('dist/manifest.json', 'utf8')).version;
const fixture = join(artifacts, 'input.wav');
writeFloatWav(fixture, Float32Array.from({ length: 48000 * 3 }, (_, i) => .1 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 48000, 1);
const report = { command: 'npm run test:live-pages', contentSha256: hash(content),
  testSha256: hash(readFileSync(new URL(import.meta.url))), inputSha256: hash(readFileSync(fixture)),
  cases: [], pass: false };
let browser, context;
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function html(live, stored, url) {
  const badge = live === 'badge' || live === 'hidden-badge'
    ? `<button class="ytp-live-badge" ${live === 'hidden-badge' ? 'style="display:none"' : ''}>LIVE</button>` : '';
  const metadata = ['metadata-live', 'metadata-archive', 'stale-metadata'].includes(live)
    ? `<div itemscope itemtype="http://schema.org/VideoObject" itemid="${live === 'stale-metadata' ? 'https://www.youtube.com/watch?v=previous-stream' : url}"><span itemprop="publication"><meta itemprop="isLiveBroadcast" content="True">${live === 'metadata-archive' ? '<meta itemprop="endDate" content="2026-10-11T00:00:00Z">' : ''}</span></div>` : '';
  return `<!doctype html><meta charset="utf-8">${metadata}<div id="movie_player" class="html5-video-player ${live === true ? 'ytp-live' : ''}"><video controls loop src="/input.wav"></video>${badge}</div><script>
  window.stored=${JSON.stringify(stored)};window.storageWrites=[];window.storageListeners=[];window.mediaSources=0;
  const nativeSource=AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource=function(...args){const source=Reflect.apply(nativeSource,this,args);mediaSources++;return source;};
  window.chrome={runtime:{getURL:path=>'/'+path,getManifest:()=>({version:'${version}'})},storage:{local:{
    get:(defaults,callback)=>callback({...defaults,...stored}),set:(next,callback)=>{const changes={};for(const key of Object.keys(next))changes[key]={newValue:next[key],oldValue:stored[key]};Object.assign(stored,next);storageWrites.push({...next});callback();queueMicrotask(()=>storageListeners.forEach(fn=>fn(changes,'local')));}
  },onChanged:{addListener:fn=>storageListeners.push(fn),removeListener:fn=>storageListeners.splice(storageListeners.indexOf(fn),1)}}};
  window.externalSettings=next=>{const changes={};for(const key of Object.keys(next))changes[key]={newValue:next[key],oldValue:stored[key]};Object.assign(stored,next);storageListeners.forEach(fn=>fn(changes,'local'));};
  </script><script src="/content.js"></script>`;
}
async function test(name, run) {
  if (process.env.VOLUME_EQ_LIVE_CASE && name !== process.env.VOLUME_EQ_LIVE_CASE) return;
  const row = { name, pass: false }; report.cases.push(row);
  try { await run(row); row.pass = true; }
  catch (error) { row.error = String(error.stack || error); }
}
async function open(url, live = false, stored = {}) {
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') (report.consoleEntries ??= []).push({ url, message: message.text() }); });
  page.on('pageerror', error => (report.consoleEntries ??= []).push({ url, message: String(error) }));
  servedHtml = html(live, stored, url);
  const local = new URL(url); local.protocol = 'http:'; local.port = String(port);
  await page.goto(local.href);
  await page.locator('#universal-volume-eq-panel').waitFor({ state: 'visible' });
  await page.locator('video').evaluate(media => media.play());
  return page;
}
const button = page => page.locator('#universal-volume-eq-panel').locator('[data-action="enabled"]');
async function check(page, enabled, row) {
  await page.waitForFunction(expected => document.getElementById('universal-volume-eq-panel')?.shadowRoot.querySelector('[data-action="enabled"]').textContent === expected, enabled ? '已开启' : '已关闭');
  if (enabled) await page.waitForFunction(() => document.getElementById('universal-volume-eq-panel')?.shadowRoot.querySelector('[data-meter="originalIntegrated"]').textContent.includes('LUFS'));
  else await page.waitForTimeout(250);
  row.state = await page.evaluate(() => ({ url: location.href, button: document.getElementById('universal-volume-eq-panel').shadowRoot.querySelector('[data-action="enabled"]').textContent,
    mediaSources, currentTime: document.querySelector('video').currentTime, paused: document.querySelector('video').paused, stored: { ...stored }, storageWrites: [...storageWrites] }));
  assert.equal(row.state.paused, false, 'Original playback must continue');
}
async function toggle(page) {
  await page.locator('#universal-volume-eq-panel').locator('.dock').hover();
  await button(page).click();
}
async function navigate(page, path, live) {
  await page.evaluate(({ path, live }) => {
    history.pushState({}, '', path);
    document.getElementById('movie_player').classList.toggle('ytp-live', live);
    document.dispatchEvent(new Event('yt-navigate-finish'));
    document.body.append(document.createElement('span'));
  }, { path, live });
}
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, executablePath: process.env.CHROME_PATH,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-proxy-server', '--host-resolver-rules=MAP * 127.0.0.1',
      '--unsafely-treat-insecure-origin-as-secure=' + ['www.twitch.tv', 'player.twitch.tv', 'clips.twitch.tv', 'live.bilibili.com', 'www.bilibili.com', 'www.youtube.com', 'www.youtube.com.example.org'].map(host => `http://${host}:${port}`).join(',')] });
  report.browser = browser.version();
  context = await browser.newContext();
  context.setDefaultTimeout(3500);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const cases = [
    ['twitch-channel', 'https://www.twitch.tv/example', false, false],
    ['twitch-popout', 'https://www.twitch.tv/popout/example', false, false],
    ['twitch-embedded-live', 'https://player.twitch.tv/?channel=example&parent=example.com', false, false],
    ['bilibili-live', 'https://live.bilibili.com/123456', false, false],
    ['youtube-live-watch', 'https://www.youtube.com/watch?v=stream', true, false],
    ['youtube-dvr-live-badge', 'https://www.youtube.com/watch?v=dvr-stream', 'badge', false],
    ['youtube-live-metadata', 'https://www.youtube.com/watch?v=metadata-stream', 'metadata-live', false],
    ['youtube-live-url', 'https://www.youtube.com/live/stream', true, false],
    ['youtube-channel-live', 'https://www.youtube.com/@example/live', false, false],
    ['youtube-embedded-live', 'https://www.youtube.com/embed/live_stream?channel=example', false, false],
    ['twitch-recording', 'https://www.twitch.tv/videos/123456', false, true],
    ['twitch-channel-videos', 'https://www.twitch.tv/example/videos', false, true],
    ['twitch-clip', 'https://clips.twitch.tv/ExampleClip', false, true],
    ['twitch-embedded-recording', 'https://player.twitch.tv/?video=v123456&parent=example.com', false, true],
    ['youtube-recording', 'https://www.youtube.com/watch?v=recording', false, true],
    ['youtube-live-recording', 'https://www.youtube.com/live/recording', false, true],
    ['youtube-hidden-live-badge', 'https://www.youtube.com/watch?v=recording', 'hidden-badge', true],
    ['youtube-ended-live-metadata', 'https://www.youtube.com/watch?v=recording', 'metadata-archive', true],
    ['youtube-stale-live-metadata', 'https://www.youtube.com/watch?v=recording', 'stale-metadata', true],
    ['bilibili-recording', 'https://www.bilibili.com/video/BVexample', false, true],
    ['unrelated-host', 'https://www.youtube.com.example.org/live/example', false, true]
  ];
  for (const [name, url, live, enabled] of cases) await test(name, async row => {
    const page = await open(url, live);
    try {
      await check(page, enabled, row);
      assert.equal(row.state.mediaSources, enabled ? 1 : 0, 'Default-off live pages must not take ownership of native audio');
      assert.equal(row.state.storageWrites.length, 0, 'Page defaults must not overwrite saved settings');
    } finally { await page.close(); }
  });
  await test('live-opt-in-sliders-and-navigation', async row => {
    const page = await open('https://www.youtube.com/watch?v=first', true, { enabled: true, bassBoost: 2 });
    try {
      await check(page, false, row);
      await toggle(page); await check(page, true, row);
      const slider = page.locator('#universal-volume-eq-panel').locator('[data-role="bassBoost"]');
      await slider.evaluate(input => { input.value = 4; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForFunction(() => stored.bassBoost === 4);
      assert.equal(await page.evaluate(() => stored.enabled), true);
      await navigate(page, '/watch?v=second', true); await check(page, false, row);
      await page.evaluate(() => externalSettings({ enabled: true, maxGain: 2.5 }));
      await check(page, false, row);
      await navigate(page, '/watch?v=recording', false); await check(page, true, row);
      await navigate(page, '/watch?v=third', true); await check(page, false, row);
      await toggle(page); await check(page, true, row);
      await page.evaluate(() => history.pushState({}, '', '/watch?v=fourth'));
      await page.locator('#universal-volume-eq-panel').locator('[data-role="bassBoost"]').evaluate(input => { input.value = 3; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await check(page, false, row);
      await page.screenshot({ path: join(artifacts, 'live-disabled.png') });
    } finally { await page.close(); }
  });
  await test('late-live-marker-and-marker-removal', async row => {
    const page = await open('https://www.youtube.com/watch?v=late');
    try {
      await check(page, true, row);
      await page.evaluate(() => document.getElementById('movie_player').classList.add('ytp-live'));
      await check(page, false, row);
      await page.evaluate(() => document.getElementById('movie_player').classList.remove('ytp-live'));
      await check(page, true, row);
    } finally { await page.close(); }
  });
  await test('live-badge-visibility-changes', async row => {
    const page = await open('https://www.youtube.com/watch?v=late-badge', 'hidden-badge');
    try {
      await check(page, true, row);
      await page.locator('.ytp-live-badge').evaluate(badge => { badge.style.display = ''; });
      await check(page, false, row);
      await page.locator('.ytp-live-badge').evaluate(badge => { badge.style.display = 'none'; });
      await check(page, true, row);
    } finally { await page.close(); }
  });
  await test('youtube-live-navigation-with-preroll-and-stale-events', async row => {
    const page = await open('https://www.youtube.com/watch?v=first', 'badge');
    const event = async (name, id, isLive) => page.evaluate(({ name, id, isLive }) => {
      const detail = name === 'yt-navigate-start'
        ? { endpoint: { watchEndpoint: { videoId: id } } }
        : { response: { playerResponse: { videoDetails: { videoId: id, isLive, isLiveContent: true } } } };
      document.dispatchEvent(new CustomEvent(name, { detail }));
    }, { name, id, isLive });
    try {
      await check(page, false, row); await toggle(page); await check(page, true, row);
      await page.evaluate(() => { history.pushState({}, '', '/watch?v=advertised-stream'); document.querySelector('.ytp-live-badge').style.display = 'none'; });
      await event('yt-navigate-start', 'advertised-stream'); await check(page, false, row);
      await event('yt-navigate-finish', 'advertised-stream', true); await check(page, false, row);
      await event('yt-navigate-finish', 'previous-stream', false); await check(page, false, row);
      await toggle(page); await check(page, true, row);
      await page.evaluate(() => history.pushState({}, '', '/watch?v=recording'));
      await event('yt-navigate-start', 'recording'); await check(page, false, row);
      await event('yt-navigate-finish', 'recording', false); await check(page, true, row);
    } finally { await page.close(); }
  });
  await test('global-disabled-live-opt-in-stays-local', async row => {
    const page = await open('https://www.youtube.com/watch?v=stream', true, { enabled: false });
    try {
      await check(page, false, row); await toggle(page); await check(page, true, row);
      assert.equal(await page.evaluate(() => stored.enabled), false, 'Live opt-in must not change global disabled preference');
      await page.reload();
      await page.locator('video').evaluate(media => media.play());
      await check(page, false, row);
      assert.equal(row.state.mediaSources, 0, 'Reload resets live opt-in');
      await navigate(page, '/watch?v=recording', false); await check(page, false, row);
      await toggle(page); await check(page, true, row);
      assert.equal(await page.evaluate(() => stored.enabled), true, 'Normal-video toggle still saves global preference');
    } finally { await page.close(); }
  });
  report.pass = report.cases.every(row => row.pass);
  if (!report.pass) process.exitCode = 1;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  try { await context?.tracing.stop({ path: join(artifacts, 'trace.zip') }); await browser?.close(); }
  catch (error) { report.cleanupError = String(error); report.pass = false; process.exitCode = 1; }
  server.close();
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, cases: report.cases.map(({ name, pass, error }) => ({ name, pass, error })), artifacts }));
}
