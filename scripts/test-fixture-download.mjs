import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Failure contracts first: transient HTTP failure, truncated transport, stale
// cache, changed source bytes, persistent HTTP failure, and escaped file paths.
// Use an actual HTTP server and the downloader CLI, never mocked fetch/curl.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-download-'));
const output = join(artifacts, 'videos'), manifest = join(artifacts, 'fixtures.json');
const bytes = Buffer.from('Repeatable download transport fixture\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const report = { command: 'node scripts/test-fixture-download.mjs', sha256: digest, requests: [], cases: [], pass: false };
const counts = new Map();
const server = createServer((req, res) => {
  const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
  report.requests.push({ url: req.url, attempt: count });
  if (req.url === '/retry' && count === 1) { res.writeHead(503); res.end('transient'); return; }
  if (req.url === '/truncated' && count === 1) {
    res.writeHead(200, { 'Content-Length': bytes.length + 100 }); res.write(bytes);
    setTimeout(() => res.destroy(), 20); return;
  }
  if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return; }
  res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
function fixture(file, path, sha256 = digest) { return { file, url: base + path, sha256, title: file }; }
async function run(name, fixtures, pass, expectedError) {
  writeFileSync(manifest, JSON.stringify(fixtures));
  const child = spawn(process.execPath, ['scripts/download-audio-fixtures.mjs', manifest, output], { windowsHide: true });
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const timer = setTimeout(() => child.kill(), 20000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
  finally { clearTimeout(timer); }
  writeFileSync(join(artifacts, name + '.log'), log);
  report.cases.push({ name, code, expectedPass: pass });
  assert.equal(code, pass ? 0 : 1, name + '\n' + log);
  if (expectedError) assert.match(log, expectedError);
}
try {
  const fixtures = [fixture('retry.mp4', '/retry'), fixture('truncated.mp4', '/truncated')];
  await run('transient-and-truncated-downloads', fixtures, true);
  for (const { file } of fixtures) assert.deepEqual(readFileSync(join(output, file)), bytes);
  const requests = report.requests.length;
  await run('verified-cache-has-no-network', fixtures, true);
  assert.equal(report.requests.length, requests);
  writeFileSync(join(output, 'retry.mp4'), 'corrupt cache');
  await run('corrupt-cache-is-repaired', fixtures, true);
  assert.deepEqual(readFileSync(join(output, 'retry.mp4')), bytes);
  assert.equal(report.requests.length, requests + 1);
  await run('changed-source-must-fail', [fixture('changed.mp4', '/changed', '0'.repeat(64))], false, /SHA256 mismatch/);
  await run('persistent-http-error-must-fail', [fixture('missing.mp4', '/missing')], false, /HTTP 404/);
  await run('escaped-path-must-fail', [fixture('../escaped.mp4', '/escape')], false, /stay in the output directory/);
  for (const file of ['changed.mp4', 'missing.mp4', 'changed.mp4.partial', 'missing.mp4.partial']) {
    assert.equal(existsSync(join(output, file)), false, 'Never publish incomplete/unverified bytes');
  }
  assert.equal(existsSync(join(artifacts, 'escaped.mp4')), false);
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  server.close();
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
