import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Native IPC evidence distinguishes browser pause requests from page code.
// Keep collection bounded to the source-switch scenario and close the stream.
export async function startNativeTrace(browser, artifacts) {
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  browser.on('Tracing.tracingComplete', complete);
  await browser.send('Tracing.start', {
    categories: 'media,media_session,mojom,ipc,disabled-by-default-ipc.flow',
    transferMode: 'ReturnAsStream'
  });
  return async () => {
    await browser.send('Tracing.end');
    let timer;
    try {
      const { stream } = await Promise.race([finished, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native trace flush timed out')), 10000);
      })]);
      const chunks = [];
      try {
        for (;;) {
          const part = await browser.send('IO.read', { handle: stream, size: 1024 * 1024 });
          chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
          if (part.eof) break;
        }
      } finally { await browser.send('IO.close', { handle: stream }); }
      const path = join(artifacts, 'native-trace.json');
      writeFileSync(path, Buffer.concat(chunks));
      return path;
    } finally { clearTimeout(timer); }
  };
}
