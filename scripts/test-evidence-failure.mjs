import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A real page navigation destroys the native extension's execution context.
// The runner must fail, retain that reason, and export already captured sound
// and its trace even when it can no longer ask the page to stop recording.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-evidence-'));
const fixture = process.env.VOLUME_EQ_REFERENCE_AUDIO || resolve('tests/fixtures/videos/clear-layout-design.mp4');
const report = { command: 'node scripts/test-evidence-failure.mjs', scenario: 'native-navigation-interruption', pass: false };
const server = createServer((req, res) => {
  if (req.url === '/fixture') {
    res.setHeader('Content-Type', 'video/mp4'); createReadStream(fixture).pipe(res); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/native' ? '<!doctype html><video controls src="/fixture"></video><script>document.querySelector("video").addEventListener("playing",()=>setTimeout(()=>location.replace("/replacement"),5000),{once:true});</script>' : '<!doctype html><title>Replacement page</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn(process.execPath, ['scripts/test-reported-video.mjs'], {
    windowsHide: true, env: { ...process.env, VOLUME_EQ_ARTIFACT_ROOT: artifacts,
      VOLUME_EQ_VIDEO_URL: 'http://127.0.0.1:' + server.address().port + '/native' }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    report.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { clearTimeout(timer); }
  writeFileSync(join(artifacts, 'runner.log'), stdout + stderr);
  assert.equal(report.exitCode, 1, 'A destroyed native page cannot pass');
  const summary = stdout.trim().split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.artifacts);
  assert.ok(summary, 'Interrupted playback must still announce its artifacts');
  report.runner = JSON.parse(readFileSync(join(summary.artifacts, 'report.json')));
  assert.equal(report.runner.pass, false);
  assert.match(report.runner.error, /context|navigation|reported video/i, 'Preserve the native interruption reason');
  assert.ok(report.runner.pcm?.seconds >= 3, 'Export partial PCM despite a destroyed execution context');
  for (const file of ['original.wav', 'output.wav', 'trace.zip']) copyFileSync(join(summary.artifacts, file), join(artifacts, file));
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  server.close();
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
