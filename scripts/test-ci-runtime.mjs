import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openBrowser } from './browser-session.mjs';

// Failure contracts first: browser/version drift, missing native events,
// unbounded CDP commands, shutdown during a request, leaked state on relaunch,
// and an unavailable executable. Exercise real Chromium, without protocol mocks.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-ci-runtime-'));
const report = { command: 'node scripts/test-ci-runtime.mjs', cases: [], pass: false };
const server = createServer((_req, res) => res.end('<!doctype html><title>CI native browser</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
let browser;
async function test(name, run) {
  const row = { name, pass: false }; report.cases.push(row);
  const start = Date.now();
  await run(row); row.seconds = (Date.now() - start) / 1000; row.pass = true;
}
try {
  browser = await openBrowser(artifacts);
  await test('pinned-browser-and-native-events', async row => {
    const reference = await chromium.launch({ channel: 'chromium', chromiumSandbox: true });
    try { row.expectedVersion = reference.version(); } finally { await reference.close(); }
    row.actualVersion = (await browser.send('Browser.getVersion')).product.split('/')[1];
    assert.equal(row.actualVersion, row.expectedVersion);
    const events = [];
    browser.on('WebAudio.contextCreated', params => events.push(params));
    await browser.send('WebAudio.enable');
    await browser.send('Page.navigate', { url });
    await browser.evaluate('document.readyState === "complete" || new Promise(resolve => window.addEventListener("load", resolve, {once:true}))');
    await browser.evaluate('localStorage.setItem("previous-run", "secret"); window.audio = new AudioContext(); audio.resume()');
    assert.ok(events.length > 0, 'Keep independent native graph evidence');
    row.audioEvents = events;
    await assert.rejects(browser.evaluate('throw new Error("native page failure")'), /native page failure/);
  });
  await test('bounded-command-and-continued-use', async row => {
    await assert.rejects(browser.evaluate('new Promise(() => {})'), /CDP timeout/);
    row.afterTimeout = await browser.evaluate('6 * 7');
    assert.equal(row.afterTimeout, 42);
  });
  assert.ok(report.cases.at(-1).seconds < 15, 'A CDP stall must fail within its deadline');
  await test('close-rejects-pending-and-can-repeat', async () => {
    const pending = browser.evaluate('new Promise(() => {})');
    const rejected = assert.rejects(pending, /closed|disconnected/i);
    await browser.close(); await rejected; await browser.close(); browser = null;
    renameSync(join(artifacts, 'trace.zip'), join(artifacts, 'initial-trace.zip'));
  });
  await test('fresh-browser-does-not-reuse-state', async () => {
    browser = await openBrowser(artifacts);
    await browser.send('Page.navigate', { url });
    assert.equal(await browser.evaluate('localStorage.getItem("previous-run")'), null);
    await browser.close(); browser = null;
  });
  await test('missing-executable-is-a-loud-failure', async row => {
    const previous = process.env.CHROME_PATH;
    process.env.CHROME_PATH = join(artifacts, 'missing-chromium.exe');
    try {
      await assert.rejects(openBrowser(artifacts), error => {
        row.error = String(error); return /executable|exist|ENOENT/i.test(row.error);
      });
    } finally {
      if (previous === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = previous;
    }
  });
  await test('each-native-runner-retains-startup-failure-evidence', async row => {
    row.runners = [];
    for (const script of ['test-browser-audio.mjs', 'test-realtime-browser.mjs', 'test-browser-failures.mjs', 'test-reported-video.mjs']) {
      const result = spawnSync(process.execPath, ['scripts/' + script, '--lifecycle'], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: { ...process.env, CHROME_PATH: join(artifacts, 'missing-chromium.exe'), VOLUME_EQ_ARTIFACT_ROOT: artifacts }
      });
      writeFileSync(join(artifacts, script + '.log'), result.stdout + result.stderr);
      assert.notEqual(result.status, 0, 'Startup failure cannot pass');
      const summary = result.stdout.trim().split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(value => value?.artifacts);
      assert.ok(summary, script + ' must report its evidence directory');
      const evidence = JSON.parse(readFileSync(join(summary.artifacts, 'report.json')));
      assert.equal(evidence.pass, false);
      assert.match(evidence.error, /executable|exist|ENOENT/i, 'Preserve the original startup reason');
      row.runners.push({ script, status: result.status, error: evidence.error });
    }
  });
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) { report.cleanupError = String(error); report.pass = false; process.exitCode = 1; }
  server.close();
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
