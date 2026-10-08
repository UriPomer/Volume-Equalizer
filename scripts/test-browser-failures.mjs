import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-session.mjs';
import { captureBootstrap, captureProcessor } from './browser-audio-capture.mjs';
import { writeFloatWav } from './audio-test-artifacts.mjs';

// Failures: late module loading interrupts playing audio; a module rejection
// or a real process() exception permanently mutes the media; a stale boost or
// bass setting survives fallback; UI presents old measurements as live output;
// toggles/settings revive the dead graph; removing media leaks connections.
// Production DSP runs unchanged until the test wrapper throws in process().
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-failures-'));
const content = readFileSync(resolve('dist/content.js'));
const worklet = readFileSync(resolve('dist/limiter-worklet.js'), 'utf8');
const version = JSON.parse(readFileSync(resolve('dist/manifest.json'), 'utf8')).version;
const report = { command: 'node scripts/test-browser-failures.mjs',
  contentSha256: createHash('sha256').update(content).digest('hex'),
  workletSha256: createHash('sha256').update(worklet).digest('hex'),
  cases: [], pass: false };
const sampleRate = 48000, amplitude = .1;
const tone = Float32Array.from({ length: sampleRate * 35 * 2 }, (_, i) =>
  amplitude * Math.sin(2 * Math.PI * 1000 * Math.floor(i / 2) / sampleRate));
const fixture = join(artifacts, 'input.wav');
writeFloatWav(fixture, tone, sampleRate, 2);
report.inputSha256 = createHash('sha256').update(readFileSync(fixture)).digest('hex');
const injectedFault = `
const nativeRegister=registerProcessor;
registerProcessor=(name,Processor)=>nativeRegister(name,class extends Processor {
  constructor(...args){
    super(...args);const receive=this.port.onmessage;
    this.port.onmessage=event=>{
      if(event.data?.type==='test-fault')this.testFault=true;
      else receive?.(event);
    };
  }
  process(...args){if(this.testFault)throw new Error('Injected '+name);return super.process(...args);}
});
`;
let activeCase, recorded = [], browser;
const page = `<!doctype html><meta charset="utf-8"><audio controls></audio><script>
${captureBootstrap}
const NativeWorklet=window.AudioWorkletNode;
window.worklets=new Map();window.processorErrors=[];
window.AudioWorkletNode=class extends NativeWorklet {
  constructor(context,name,...args){super(context,name,...args);window.worklets.set(name,this);
    const descriptor=Object.getOwnPropertyDescriptor(NativeWorklet.prototype,'onprocessorerror');
    Object.defineProperty(this,'onprocessorerror',{
      get:()=>descriptor.get.call(this),
      set:handler=>descriptor.set.call(this,handler?event=>{window.processorErrors.push(name);handler(event);}:null)
    });}
};
const createGain=BaseAudioContext.prototype.createGain;
BaseAudioContext.prototype.createGain=function(){const node=Reflect.apply(createGain,this,[]);window.programmeParam=node.gain;return node;};
const stored={};
window.chrome={runtime:{getURL:path=>'/'+path,getManifest:()=>({version:'${version}'})},storage:{local:{
  get:(defaults,callback)=>callback({...defaults,...stored}),set:(settings,callback)=>{Object.assign(stored,settings);callback();}
},onChanged:{addListener(){},removeListener(){}}}};
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/recording') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    recorded.push({ sequence: Number(req.headers['x-audio-sequence']), bytes: Buffer.concat(chunks) });
    res.end('ok');
  } else if (req.url === '/input.wav') {
    res.setHeader('Content-Type', 'audio/wav'); res.end(readFileSync(fixture));
  } else if (req.url === '/content.js' || req.url === '/capture.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(req.url === '/content.js' ? content : captureProcessor);
  } else if (req.url === '/limiter-worklet.js') {
    if (activeCase === 'module-loading') await delay(2200);
    res.setHeader('Content-Type', 'text/javascript');
    res.end(activeCase === 'module-rejection' ? 'throw new Error("Injected module rejection")' : injectedFault + worklet);
  } else { res.setHeader('Content-Type', 'text/html'); res.end(page); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
function pcmReport(file, rate) {
  const bytes = Buffer.concat(recorded.sort((a, b) => a.sequence - b.sequence).map(row => row.bytes));
  const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  writeFloatWav(file, pcm, rate, 2);
  let silentFrames = 0, longestSilence = 0;
  // Discard only the recorder's partially filled first telemetry packet.
  for (let frame = Math.round(rate / 10); frame < pcm.length / 2; frame++) {
    silentFrames = Math.max(Math.abs(pcm[frame * 2]), Math.abs(pcm[frame * 2 + 1])) < 1e-5 ? silentFrames + 1 : 0;
    longestSilence = Math.max(longestSilence, silentFrames);
  }
  const blocks = [];
  for (let start = rate; start + rate / 10 <= pcm.length / 2; start += rate / 10) {
    const block = pcm.subarray(start * 2, (start + rate / 10) * 2);
    blocks.push({ time: start / rate, rms: Math.sqrt(block.reduce((sum, v) => sum + v * v, 0) / block.length) });
  }
  return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), longestSilenceMs: longestSilence * 1000 / rate, blocks };
}
try {
  browser = await openBrowser(artifacts);
  const { send, evaluate } = browser;
  report.browser = await send('Browser.getVersion');
  await send('Runtime.enable');
  for (const name of ['module-loading', 'module-rejection', 'media-input-meter', 'lookahead-peak-limiter']) {
    const row = { name, pass: false }; report.cases.push(row); activeCase = name; recorded = [];
    try {
      await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' + name });
      for (let i = 0; i < 50 && !await evaluate('!!window.startAudioCapture'); i++) await delay(100);
      await evaluate(`(async()=>{const media=document.querySelector('audio');media.src='/input.wav';await media.play();})()`);
      await evaluate(`(()=>{const script=document.createElement('script');script.src='/content.js';document.body.append(script);})()`);
      for (let i = 0; i < 50 && !await evaluate('!!document.getElementById("universal-volume-eq-panel")?.shadowRoot'); i++) await delay(100);
      if (name === 'media-input-meter' || name === 'lookahead-peak-limiter') {
        await delay(12000);
        row.beforeGain = await evaluate('window.programmeParam.value');
        assert.ok(row.beforeGain > 1.05, 'Fault must occur during boosted playback');
        // A low-shelf boost must also be discarded by the original-audio path.
        await evaluate(`(()=>{const input=document.getElementById('universal-volume-eq-panel').shadowRoot.querySelector('[data-role="bassBoost"]');input.value=6;input.dispatchEvent(new Event('input',{bubbles:true}));window.worklets.get('${name}').port.postMessage({type:'test-fault'});})()`);
      }
      const rate = await evaluate('window.startAudioCapture()');
      await delay(name === 'module-loading' ? 1800 : 4200);
      await evaluate('window.stopAudioCapture()');
      row.recording = pcmReport(join(artifacts, name + '.wav'), rate);
      assert.ok(row.recording.longestSilenceMs < 100, 'Failure must not leave an audible dropout of 100 ms or longer');
      const expected = amplitude / Math.sqrt(2);
      assert.ok(row.recording.blocks.length >= 6, 'Record enough real output');
      assert.ok(row.recording.blocks.every(block => Math.abs(block.rms / expected - 1) < .02),
        'Every fallback block must play the unboosted original instead of silence or stale gain');
      row.state = await evaluate(`(()=>{const root=document.getElementById('universal-volume-eq-panel').shadowRoot;return {
        gain:root.querySelector('[data-meter="gain"]').textContent,status:root.querySelector('[data-meter="status"]').textContent,
        output:root.querySelector('[data-meter="outputIntegrated"]').textContent,errors:window.processorErrors};})()`);
      if (name !== 'module-loading') {
        assert.equal(row.state.gain, '1.00x');
        assert.match(row.state.status, /原声/);
        assert.equal(row.state.output, '不可用', 'Unavailable meter cannot present stale output or claim ongoing measurement');
      }
      if (name === 'media-input-meter' || name === 'lookahead-peak-limiter') assert.ok(row.state.errors.includes(name), 'A native processorerror must trigger recovery');
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, name + '.png'), Buffer.from(screenshot.data, 'base64'));
      if (name === 'media-input-meter' || name === 'lookahead-peak-limiter') {
        recorded = [];
        await evaluate(`(()=>{const root=document.getElementById('universal-volume-eq-panel').shadowRoot;
          const button=root.querySelector('[data-action="enabled"]');button.click();button.click();
          const slider=root.querySelector('[data-role="maxGain"]');slider.value=3;slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await evaluate('window.startAudioCapture()');
        await delay(2500);
        await evaluate('window.stopAudioCapture()');
        row.afterSettings = pcmReport(join(artifacts, name + '-after-settings.wav'), rate);
        assert.ok(row.afterSettings.blocks.length >= 10 && row.afterSettings.blocks.every(block => Math.abs(block.rms / expected - 1) < .02),
          'Toggles and settings must retain audible original audio after failure');
      }
      await evaluate(`(()=>{const media=document.querySelector('audio');media.pause();media.remove();})()`);
      for (let i = 0; i < 50 && await evaluate('window.captureState.sources.size'); i++) await delay(100);
      assert.equal(await evaluate('window.captureState.sources.size'), 0, 'Removing stopped media must release all destination connections');
      row.pass = true;
    } catch (error) { row.error = String(error.stack || error); }
    console.log(JSON.stringify({ name, pass: row.pass, error: row.error, state: row.state }));
  }
  report.pass = report.cases.every(row => row.pass);
  if (!report.pass) process.exitCode = 1;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) { report.cleanupError = String(error); report.pass = false; process.exitCode = 1; }
  finally { server.close(); }
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, artifacts }));
}
