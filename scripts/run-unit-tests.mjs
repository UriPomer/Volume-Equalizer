import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const output = join(root, 'dist-test');

try {
  execFileSync(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--ignoreConfig',
    'src/gain-control.ts',
    'src/loudness-meter.ts',
    'src/full-audio-analysis.ts',
    'src/controller.ts',
    'src/settings.ts',
    '--outDir', output,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--lib', 'es2020,dom',
    '--types', 'chrome',
    '--skipLibCheck'
  ], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [
    '--test',
    'tests/controller-integration.test.cjs',
    'tests/full-audio-analysis.test.cjs',
    'tests/gain-control.test.cjs',
    'tests/limiter-worklet.test.cjs',
    'tests/loudness-meter.test.cjs',
    'tests/settings.test.cjs'
  ], { cwd: root, stdio: 'inherit' });
} finally {
  rmSync(output, { recursive: true, force: true });
}
