import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Failure contracts: a source switch measures the previous Blob; a ready
// fixture starts paused; a real pause is silently resumed; startup diagnostics
// lose the source identity, initiating call stack or native player events.
// Run native Chromium and the built extension, including an actual pause fault.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-playback-startup-'));
const report = { command: 'node scripts/test-playback-startup.mjs', cases: [], pass: false };
async function run(name, injectPause) {
  const child = spawn(process.execPath, ['scripts/test-realtime-browser.mjs', '--source-switches', ...(injectPause ? ['--inject-pause'] : [])], {
    windowsHide: true, env: { ...process.env, VOLUME_EQ_ARTIFACT_ROOT: artifacts }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill(), 90000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
  finally { clearTimeout(timer); }
  writeFileSync(join(artifacts, name + '.log'), stdout + stderr);
  const summary = stdout.trim().split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.artifacts);
  assert.ok(summary, 'Every native attempt must retain an evidence directory');
  const evidence = JSON.parse(readFileSync(join(summary.artifacts, 'report.json')));
  const row = { name, exitCode, artifacts: summary.artifacts, pass: false };
  report.cases.push(row);
  if (injectPause) {
    assert.equal(exitCode, 1, 'A real post-start pause must fail rather than retry');
    assert.equal(evidence.pass, false);
    assert.match(evidence.error, /Media paused unexpectedly/);
    assert.equal(evidence.trace.at(-1).paused, true);
    assert.equal(evidence.trace.at(-1).currentSource, evidence.inputLoads.at(-1).source);
    assert.ok(evidence.mediaCommands.some(call => call.method === 'pause' && call.stack?.includes('injectSourceSwitchPause')),
      'Retain the pause caller instead of blaming an unspecified CI environment');
    assert.ok(evidence.nativeMediaEvents.length > 0, 'Retain independent native player evidence');
    row.failure = evidence.error;
  } else {
    assert.equal(exitCode, 0, evidence.error || stderr);
    assert.equal(evidence.pass, true);
    assert.equal(evidence.sourceSwitches.length, 30);
    assert.ok(evidence.nativeTrace, 'Retain native IPC evidence for every source-switch attempt');
    assert.deepEqual(evidence.nativeTrace.browserPauseRequests, [], 'The controlled DSP browser must receive no system pause requests');
    assert.ok(evidence.sourceSwitches.every(state => !state.paused && state.currentSource === state.requestedSource && state.time >= .15));
    row.switches = evidence.sourceSwitches.length;
  }
  row.pass = true;
  console.log(JSON.stringify(row));
}
try {
  for (let index = 1; index <= 3; index++) await run('native-source-switches-' + index, false);
  await run('injected-post-start-pause', true);
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
