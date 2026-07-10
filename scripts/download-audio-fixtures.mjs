import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'tests', 'fixtures', 'audio-videos.json');
const outputDir = join(root, 'tests', 'fixtures', 'videos');
const fixtures = JSON.parse(readFileSync(manifestPath, 'utf8'));

mkdirSync(outputDir, { recursive: true });

for (const fixture of fixtures) {
  const outputPath = join(outputDir, fixture.file);
  if (existsSync(outputPath)) {
    console.log(`exists - ${fixture.file}`);
    continue;
  }

  const partialPath = `${outputPath}.partial`;
  rmSync(partialPath, { force: true });
  console.log(`download - ${fixture.title}`);
  try {
    const response = await fetch(fixture.url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath));
  } catch (error) {
    rmSync(partialPath, { force: true });
    const curl = spawnSync('curl', [
      '--fail', '--location', '--silent', '--show-error',
      '--output', partialPath,
      fixture.url
    ], { encoding: 'utf8' });
    if (curl.status !== 0) {
      throw new Error(`Failed to download ${fixture.url}: ${error}\n${curl.stderr}`);
    }
  }
  renameSync(partialPath, outputPath);
  console.log(`saved - ${outputPath}`);
}
