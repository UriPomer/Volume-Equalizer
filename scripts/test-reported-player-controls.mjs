import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFloatWav } from './audio-test-artifacts.mjs';

// A localized page has no Chinese play button. Closing its login prompt must
// resume the same native media without accepting unrelated pauses or navigation.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-player-controls-'));
const fixture = join(artifacts, 'input.wav');
writeFloatWav(fixture, Float32Array.from({ length: 48000 * 18 }, (_, i) => .23 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 48000, 1);
const report = { command: 'node scripts/test-reported-player-controls.mjs', pass: false };
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/input.wav' ? 'audio/wav' : 'text/html');
  res.end(req.url === '/input.wav' ? readFileSync(fixture) : `<!doctype html><html lang="en"><title>Localized player</title>
    <video controls src="/input.wav"></video><button aria-label="Play/Pause">Play/Pause</button>
    <div class="bili-mini-mask" hidden><button class="bili-mini-close-icon">Close login prompt</button></div>
    <script>
      const media=document.querySelector('video'),mask=document.querySelector('.bili-mini-mask');
      document.querySelector('[aria-label="Play/Pause"]').onclick=()=>media.play();
      media.addEventListener('playing',()=>setTimeout(()=>{media.pause();mask.hidden=false;},2000),{once:true});
      document.querySelector('.bili-mini-close-icon').onclick=()=>{mask.hidden=true;};
    </script></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn(process.execPath, ['scripts/test-reported-video.mjs'], {
    windowsHide: true, env: { ...process.env, VOLUME_EQ_ARTIFACT_ROOT: artifacts,
      VOLUME_EQ_VIDEO_URL: `http://127.0.0.1:${server.address().port}/watch` }
  });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    report.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { clearTimeout(timer); }
  writeFileSync(join(artifacts, 'runner.log'), output);
  const summary = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(value => value?.artifacts);
  assert.ok(summary, 'Native runner must retain its evidence');
  report.runner = JSON.parse(readFileSync(join(summary.artifacts, 'report.json')));
  assert.equal(report.exitCode, 0, report.runner.error);
  assert.equal(report.runner.pass, true);
  assert.equal(report.runner.sitePauses.length, 1, 'Recover exactly one visible login prompt');
  assert.ok(report.runner.playbacks[0]?.time >= 17.5, 'Play the same programme to completion');
  for (const name of ['original.wav', 'output.wav', 'trace.zip']) copyFileSync(join(summary.artifacts, name), join(artifacts, name));
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  server.close();
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
