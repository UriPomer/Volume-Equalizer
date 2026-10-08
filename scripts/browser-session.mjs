import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// One isolated browser per integration run. Never attach to the user's profile.
// Startup failures: a slow first launch, a locked port file, a missing executable
// or an exited process. Use the endpoint advertised by our child process rather
// than the Windows port-file handoff; startup remains bounded and failures loud.
export async function openBrowser(artifacts, onEvent = () => {}) {
  const executable = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ].find(existsSync);
  assert.ok(executable, 'Set CHROME_PATH to a Chromium executable');
  const profile = join(resolve(artifacts), 'browser-profile');
  const pending = new Map();
  let browser, socket, port, sequence = 0, stderr = '';

  function send(method, params = {}) {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser disconnected'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function disconnect() {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Browser disconnected'));
    }
    pending.clear();
  }

  async function close() {
    if (socket?.readyState === WebSocket.OPEN) {
      await send('Browser.close').catch(() => {});
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    if (browser && browser.exitCode === null) {
      await delay(500);
      if (browser.exitCode === null) browser.kill();
    }
    writeFileSync(join(artifacts, 'browser-stderr.log'), stderr);
    assert.equal(resolve(profile), join(resolve(artifacts), 'browser-profile'));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }

  try {
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    browser.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-16384);
      const advertised = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//);
      if (advertised) port = Number(advertised[1]);
    });
    let startError;
    browser.on('error', error => { startError = error; });
    const deadline = Date.now() + 30000;
    while (!port && Date.now() < deadline) {
      if (startError) throw startError;
      if (browser.exitCode !== null) throw new Error('Browser exited during startup');
      await delay(100);
    }
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Browser debugging endpoint timed out after 30s');
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(10000) })).json();
    socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser connection timed out')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Browser connection failed')); };
    });
    socket.onclose = disconnect;
    socket.onmessage = event => {
      const message = JSON.parse(event.data), request = pending.get(message.id);
      if (!request) { if (message.method) onEvent(message); return; }
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    };
    return { send, evaluate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
