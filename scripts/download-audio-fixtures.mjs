import assert from 'node:assert/strict';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(process.argv[2] || join(root, 'tests', 'fixtures', 'audio-videos.json'));
const outputDir = resolve(process.argv[3] || join(root, 'tests', 'fixtures', 'videos'));
const fixtures = JSON.parse(readFileSync(manifestPath, 'utf8'));
const files = new Set();
for (const fixture of fixtures) {
  assert.ok(fixture.file && basename(fixture.file) === fixture.file && !/[\\/]/.test(fixture.file), 'Fixture file must stay in the output directory');
  assert.ok(/^[a-f0-9]{64}$/.test(fixture.sha256), 'Fixture needs its recorded SHA256');
  assert.ok(!files.has(fixture.file), 'Fixture files must be unique'); files.add(fixture.file);
}
async function verified(path, expected) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex') === expected;
}
mkdirSync(outputDir, { recursive: true });

for (const fixture of fixtures) {
  const outputPath = join(outputDir, fixture.file);
  if (existsSync(outputPath)) {
    if (await verified(outputPath, fixture.sha256)) {
      console.log(`verified - ${fixture.file}`); continue;
    }
    console.log(`repair corrupt cache - ${fixture.file}`);
    rmSync(outputPath);
  }

  const partialPath = `${outputPath}.partial`;
  rmSync(partialPath, { force: true });
  console.log(`download - ${fixture.title}`);
  try {
    try {
      const response = await fetch(fixture.url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath));
    } catch (error) {
      rmSync(partialPath, { force: true });
      const curl = spawnSync('curl', [
        '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '10',
        '--max-time', '60', '--retry', '2', '--retry-delay', '1', '--retry-max-time', '120',
        '--output', partialPath, fixture.url
      ], { encoding: 'utf8', timeout: 180000, windowsHide: true });
      if (curl.status !== 0) throw new Error(`Failed to download ${fixture.url}: ${error}\n${curl.error || curl.stderr}`);
    }
    assert.ok(await verified(partialPath, fixture.sha256), `SHA256 mismatch: ${fixture.file}`);
    renameSync(partialPath, outputPath);
    console.log(`saved verified - ${outputPath}`);
  } finally {
    rmSync(partialPath, { force: true });
  }
}
