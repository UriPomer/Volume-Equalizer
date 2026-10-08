import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Use the same pinned browser as native extension E2E. Playwright owns the
// process, isolated profile and transport; commands still have a deadline.
export async function openBrowser(artifacts) {
  let browser, context, session;
  async function close() {
    const active = browser;
    if (!active) return;
    browser = null;
    try {
      await context?.tracing.stop({ path: join(artifacts, 'trace.zip') });
    } finally {
      await active.close();
    }
  }
  async function send(method, params = {}) {
    let timer;
    try {
      return await Promise.race([
        session.send(method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 10000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }
  try {
    browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true,
      executablePath: process.env.CHROME_PATH, headless: true, timeout: 30000,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    session = await context.newCDPSession(page);
    return { send, evaluate, close, on: (method, listener) => session.on(method, listener) };
  } catch (error) {
    writeFileSync(join(artifacts, 'browser-error.log'), String(error.stack || error));
    try { await close(); }
    catch (cleanupError) { writeFileSync(join(artifacts, 'browser-cleanup-error.log'), String(cleanupError)); }
    throw error;
  }
}
