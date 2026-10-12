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
      const bytes = Buffer.concat(chunks);
      writeFileSync(path, bytes);
      // Chromium's IPCStableHash is SHA256 of the qualified method name:
      // media::mojom::MediaPlayer::RequestPause -> 2393964309.
      const browserPauseRequests = JSON.parse(bytes).traceEvents.filter(event =>
        event.args?.chrome_mojo_event_info?.mojo_interface_tag === 'media.mojom.MediaPlayer'
        && event.args.chrome_mojo_event_info.ipc_hash === 2393964309);
      return { path, browserPauseRequests };
    } finally { clearTimeout(timer); }
  };
}
