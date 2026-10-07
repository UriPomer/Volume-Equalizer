import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openBrowser } from './browser-session.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { measureWithFfmpeg } from './offline-loudness-reference.mjs';
import { captureBootstrap, captureProcessor } from './browser-audio-capture.mjs';
import { denseMaxima, ffmpegMaxima, writeFloatWav } from './audio-test-artifacts.mjs';

// Real media -> built content script -> AudioWorklet -> controller -> panel.
// Only chrome.storage and extension URL resolution are adapted to localhost.
// Observe every native GainNode scheduling call without replacing audio DSP.
// Failure cases: extrema cause ducking, average misses the target, short
// phrases pump the gain, target/seek/source changes leave stale measurements,
// silence boosts, or legacy settings trigger a complete audio download.
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-realtime-'));
const content = readFileSync(resolve('dist/content.js'));
const worklet = readFileSync(resolve('dist/limiter-worklet.js'));
const installedVersion = JSON.parse(readFileSync(resolve('dist/manifest.json'),'utf8')).version;
const rate = 48000;
const fixture = join(artifacts, 'mixed.wav');
function writeTone(file, seconds, amplitude, frequency = 1000) {
  const pcm = Buffer.alloc(seconds * rate * 4);
  for (let i = 0; i < seconds * rate; i++) {
    const value = Math.round(32767 * amplitude(i / rate) * Math.sin(2 * Math.PI * frequency * i / rate));
    pcm.writeInt16LE(value, i * 4);
    pcm.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
}
const amplitude = time => time % 2.5 < 1 ? .14 : .064;
writeTone(fixture, 90, amplitude);
const correction = Math.pow(10, (-19.8 - measureWithFfmpeg(fixture).integratedLufs) / 20);
writeTone(fixture, 90, time => amplitude(time) * correction);
writeTone(join(artifacts, 'silence.wav'), 15, () => 0);
writeTone(join(artifacts, 'quiet.wav'), 30, () => .016);
writeTone(join(artifacts, 'loud.wav'), 15, () => .35);
writeTone(join(artifacts, 'stability.wav'), 75, t => t < 18 ? .12 : t < 38 ? .075 : .35);
writeTone(join(artifacts, 'periodic.wav'), 70, t => t % 3 < .6 ? .16 : .16 * Math.pow(10, -12 / 20));
writeTone(join(artifacts, 'multiple.wav'), 20, () => .65);
writeTone(join(artifacts, 'second.wav'), 20, () => .65, 1301);
writeTone(join(artifacts, 'startup.wav'), 15, () => .135);
const reference = measureWithFfmpeg(fixture);
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const report = { command: 'npm run test:realtime', commit, generatedAt: new Date().toISOString(),
  contentSha256: createHash('sha256').update(content).digest('hex'),
  workletSha256: createHash('sha256').update(worklet).digest('hex'),
  input: { file: fixture, sha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    reference, targetLufs: -17.5, expectedGain: Math.pow(10, (-17.5 - reference.integratedLufs) / 20) },
  requests: [], checkpoints: [], trace: [], inputLoads: [], audioGraphEvents: [], consoleEntries: [], pass: false };
const page = `<!doctype html><meta charset="utf-8"><style>body{background:#17202b;color:white;font:18px system-ui}</style>
<h1>Realtime integrated loudness regression</h1><audio controls></audio>
<script>
${captureBootstrap}
const stored={fullAudioAnalysis:true,targetRms:Math.pow(10,(-17.5+.691)/20)};
window.analysisCalls=[];
const decode=BaseAudioContext.prototype.decodeAudioData;
BaseAudioContext.prototype.decodeAudioData=function(...args){window.analysisCalls.push('decode');return Reflect.apply(decode,this,args);};
window.mediaEvents=[];
window.programmeGains=[];
const createGain=BaseAudioContext.prototype.createGain;
BaseAudioContext.prototype.createGain=function(...args){
  const node=Reflect.apply(createGain,this,args),setValue=node.gain.setValueAtTime;
  window.programmeGainParam=node.gain;
  node.gain.setValueAtTime=function(...args){
    const result=Reflect.apply(setValue,this,args);
    window.programmeGains.push({value:args[0],immediateValue:node.gain.value,contextTime:args[1],mediaTime:document.querySelector('audio')?.currentTime,fixture:window.activeFixture});
    return result;
  };
  return node;
};
for(const type of ['pause','play','waiting','stalled','error','ended','seeking','seeked'])document.querySelector('audio').addEventListener(type,event=>window.mediaEvents.push({type,time:event.target.currentTime}));
window.chrome={runtime:{getURL:path=>'/'+path,getManifest:()=>({version:'${installedVersion}'})},storage:{local:{
  get:(defaults,callback)=>callback({...defaults,...stored}),
  set:(settings,callback)=>{Object.assign(stored,settings);callback();}
},onChanged:{addListener(){},removeListener(){}}}};
const bootstrap=document.createElement('script');bootstrap.dataset.playinfo='';
bootstrap.textContent='window.__playinfo__='+JSON.stringify({data:{dash:{audio:[{baseUrl:location.origin+'/startup.wav',bandwidth:128000}]}}});
document.body.append(bootstrap);
</script>`;
const recorded = [];
const server = createServer(async (req, res) => {
  const name = req.url?.slice(1);
  if(req.method==='GET')report.requests.push(req.url);
  if (req.method === 'POST' && name === 'recording') {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    recorded.push({sequence:Number(req.headers['x-audio-sequence']),bytes:Buffer.concat(chunks)});
    res.end('ok');
  } else if (name === 'capture.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(captureProcessor);
  } else if (name === 'content.js' || name === 'limiter-worklet.js') {
    // Loading the extension module is asynchronous on an already running page.
    // Let the temporary muted GainNode render before protection becomes ready.
    if(name==='limiter-worklet.js')await delay(250);
    res.setHeader('Content-Type', 'text/javascript');
    res.end(name === 'content.js' ? content : worklet);
  } else if (['mixed.wav', 'silence.wav', 'quiet.wav', 'loud.wav', 'stability.wav', 'periodic.wav', 'multiple.wav', 'second.wav', 'startup.wav'].includes(name)) {
    const data = readFileSync(join(artifacts, name));
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', data.length);
    res.end(data);
  } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, send, evaluate;
async function playFixture(name) {
  // Exercise native media playback with verified bytes, without a custom HTTP
  // range server adding an unrelated streaming failure to the audio test.
  const loaded = await evaluate(`(async()=>{
    const response=await fetch('/${name}');
    if(!response.ok)throw new Error('Fixture fetch failed: '+response.status);
    const bytes=await response.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    const media=document.querySelector('audio'),previous=media.src;
    window.activeFixture='${name}';
    media.pause();media.src=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);
    await media.play();
    return {file:'${name}',bytes:bytes.byteLength,sha256:hash};
  })()`);
  report.inputLoads.push(loaded);
  assert.equal(loaded.sha256, createHash('sha256').update(readFileSync(join(artifacts, name))).digest('hex'), 'Browser must receive the complete fixture');
}
async function snapshot() {
  return evaluate(`(()=>{
    const host=document.getElementById('universal-volume-eq-panel');
    if(!host)return null;
    host.setAttribute('data-open','');
    const root=host.shadowRoot;
    const text=key=>root.querySelector('[data-meter="'+key+'"]')?.textContent;
    return {time:document.querySelector('audio').currentTime,input:parseFloat(text('originalIntegrated')),
      output:parseFloat(text('outputIntegrated')),outputMomentary:parseFloat(text('output')),momentary:parseFloat(text('original')),
      paused:document.querySelector('audio').paused,readyState:document.querySelector('audio').readyState,
      mediaError:document.querySelector('audio').error?.message,
      gain:parseFloat(text('gain')),programmeGain:window.programmeGainParam?.value,
      version:root.querySelector('[data-role="version"]')?.textContent,
      gainTraceIndex:window.programmeGains.length-1,safety:parseFloat(text('safety')),phase:text('phase'),status:text('status'),
      maximumMomentary:parseFloat(text('maximumMomentary')),
      maximumShortTerm:parseFloat(text('maximumShortTerm')),
      inputText:text('originalIntegrated'),targetLabel:root.querySelector('[data-role="targetLufs"]').parentElement.textContent};
  })()`);
}
async function observe(seconds, playing = true) {
  const started = Date.now(), initial = await snapshot();
  let lastTime = initial.time, progressedAt = started;
  while (Date.now() - started < (seconds + 15) * 1000) {
    const state = await snapshot();
    report.trace.push(state);
    assert.ok(!state.mediaError, 'Media playback failed: ' + state.mediaError);
    if (!playing && Date.now() - started >= seconds * 1000) return state;
    if (playing) {
      assert.equal(state.paused, false, 'Media paused unexpectedly');
      if (state.time > lastTime) { lastTime = state.time; progressedAt = Date.now(); }
      assert.ok(Date.now() - progressedAt < 5000, 'Media playback stalled at ' + state.time + 's');
      if (state.time - initial.time >= seconds) return state;
    }
    await delay(200);
  }
  throw new Error('Media did not advance ' + seconds + 's within its deadline');
}
async function checkpoint(name) {
  const state = await snapshot();
  report.checkpoints.push({ name, ...state });
  console.log(JSON.stringify({ name, ...state }));
  return state;
}
async function setSlider(role, value) {
  await evaluate(`(()=>{const input=document.getElementById('universal-volume-eq-panel').shadowRoot.querySelector('[data-role="${role}"]');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function screenshot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(artifacts, name + '.png'), Buffer.from(image.data, 'base64'));
}
try {
  browser = await openBrowser(artifacts, event => {
    if (event.method.startsWith('WebAudio.')) report.audioGraphEvents.push(event);
    if (event.method === 'Log.entryAdded') report.consoleEntries.push(event.params.entry);
  });
  ({ send, evaluate } = browser);
  report.browser = await send('Browser.getVersion');
  await send('WebAudio.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  // A playing video must remain audible when the extension attaches. Earlier
  // fixtures waited until all gain parameters settled before starting playback.
  await playFixture('startup.wav');
  await evaluate(`(()=>{const script=document.createElement('script');script.src='/content.js';document.body.append(script);})()`);
  for (let i = 0; i < 100 && !(await snapshot()); i++) await delay(100);
  assert.equal((await snapshot()).version,'v'+installedVersion,'Panel must show the installed manifest version');
  await setSlider('targetLufs', -21);
  const startupRate=await evaluate('window.startAudioCapture()');
  const startupTime = (await snapshot()).time;
  await observe(8);
  assert.equal((await snapshot()).status,'实时','Only realtime normalization is permitted');
  assert.deepEqual(await evaluate('window.analysisCalls'),[],'No complete audio decoding is allowed');
  assert.equal(await evaluate(`document.getElementById('universal-volume-eq-panel').shadowRoot.querySelectorAll('[data-action="fullAudioAnalysis"]').length`),0,'Remove the complete-track analysis control');
  await evaluate('window.stopAudioCapture()');
  const startupBytes=Buffer.concat(recorded.sort((a,b)=>a.sequence-b.sequence).map(row=>row.bytes));
  const startupPcm=new Float32Array(startupBytes.buffer.slice(startupBytes.byteOffset,startupBytes.byteOffset+startupBytes.length));
  const startupFile=join(artifacts,'late-attachment-output.wav');
  writeFloatWav(startupFile,startupPcm,startupRate,2);
  const startupBlocks=[];
  for(let start=startupRate;start+startupRate/5<=startupPcm.length/2;start+=startupRate/5){
    const block=startupPcm.slice(start*2,(start+startupRate/5)*2);
    startupBlocks.push({time:startupTime+start/startupRate,rms:Math.sqrt(block.reduce((sum,value)=>sum+value*value,0)/block.length)});
  }
  report.startup={file:startupFile,blocks:startupBlocks,independent:ffmpegMaxima(startupFile)};
  report.startup.schedules=await evaluate(`window.programmeGains`);
  assert.ok(startupBlocks.length>=30&&startupBlocks.every(row=>row.rms>.02),'Every steady input interval must remain audible after attachment');
  assert.equal(await evaluate(`document.getElementById('universal-volume-eq-panel').shadowRoot.querySelectorAll('[data-meter="programmeGain"]').length`),0,'Panel must show only one effective gain');
  assert.equal(await evaluate(`document.getElementById('universal-volume-eq-panel').shadowRoot.querySelectorAll('[data-meter="loudnessSafety"]').length`),0,'LUFS extrema must be displayed without an additional loudness protector');
  recorded.length=0;
  await setSlider('bassBoost',0);
  await setSlider('targetLufs', -17.5);
  await playFixture('stability.wav');
  let stable;
  for (let i = 0; i < 16; i++) {
    stable = await observe(1);
    if (stable.phase.includes('已稳定')) break;
  }
  assert.ok(stable.phase.includes('已稳定'), 'Initial constant passage must establish a stable anchor');
  const anchor = stable.programmeGain, firstStableIndex = stable.gainTraceIndex;
  await observe(48 - stable.time);
  const earlyChange=await checkpoint('sustained-content-early-error');
  await observe(24);
  const sustained = await checkpoint('stable-gain-with-sustained-loud-content');
  assert.ok(sustained.maximumMomentary > -15.5 && sustained.maximumShortTerm > -15.5, 'Unclipped loud passages may exceed target +2 LU');
  // A large unannounced change cannot retroactively normalize earlier PCM.
  // Observe the real cumulative error rather than claiming input * latest gain
  // is the already-rendered average. Require transparency of the current PCM.
  assert.ok(Math.abs(sustained.outputMomentary-sustained.momentary-20*Math.log10(sustained.programmeGain))<=.3,'Unclipped output must follow the single programme gain without hidden loudness attenuation');
  assert.ok(Math.abs(sustained.input+20*Math.log10(sustained.programmeGain)+17.5)<.4,'The programme gain must approach the cumulative input reference');
  await evaluate(`document.querySelector('audio').pause();document.querySelector('audio').currentTime=20`);
  await observe(1, false);
  await evaluate(`document.querySelector('audio').play()`);
  await observe(4);
  const decisions = await evaluate(`window.programmeGains.slice(${firstStableIndex})`);
  const values = decisions.map(row => row.value), min = Math.min(...values), max = Math.max(...values);
  report.stability = {earlyOutputErrorLu:earlyChange.output+17.5,lateOutputErrorLu:sustained.output+17.5,anchor, min, max, span: max - min, maximumDeviation: Math.max(Math.abs(min-anchor),Math.abs(max-anchor)), decisions};
  assert.ok(values.length > 400, 'Verify every scheduled gain, not occasional rounded UI samples');
  assert.ok(report.stability.span>.2,'A changed programme average must escape the old fixed corridor');
  assert.ok(values.every((value,i)=>!i||Math.abs(value-values[i-1])<=.021),'Recalibration must remain smooth instead of jumping gain');
  await screenshot('stable-gain');
  await setSlider('targetLufs', -21);
  const periodicTraceStart = report.trace.length;
  await playFixture('periodic.wav');
  recorded.length=0;
  const periodicRate=await evaluate('window.startAudioCapture()');
  const periodicStartTime=await evaluate("document.querySelector('audio').currentTime");
  await observe(60);
  await evaluate('window.stopAudioCapture()');
  // A source change can occur between UI animation frames. Exclude the old
  // video's last rendered status; this profile needs >=10 s for calibration.
  const periodic = report.trace.slice(periodicTraceStart), firstPeriodicStable = periodic.find(row => row.time >= 10 && row.phase.includes('已稳定'));
  assert.ok(firstPeriodicStable && firstPeriodicStable.time <= 25, 'Periodic high dynamics must finish calibration');
  const periodicDecisions = await evaluate(`window.programmeGains.filter(row=>row.fixture==='periodic.wav'&&row.mediaTime>=${firstPeriodicStable?.time ?? 0})`);
  const periodicValues = periodicDecisions.map(row => row.value);
  report.periodic = {firstStableSeconds:firstPeriodicStable.time, min:Math.min(...periodicValues),max:Math.max(...periodicValues),decisions:periodicDecisions};
  assert.ok(report.periodic.max-report.periodic.min<=.2+1e-6, 'Periodic input must obey the complete stable gain span');
  const periodicActual=periodic.filter(row=>row.time>30).map(row=>row.gain);
  report.periodic.actualGainSpan=Math.max(...periodicActual)-Math.min(...periodicActual);
  assert.ok(report.periodic.actualGainSpan<=.2,'Final effective gain must not pump between loud and quiet phrases');
  const periodicBytes=Buffer.concat(recorded.sort((a,b)=>a.sequence-b.sequence).map(row=>row.bytes));
  const periodicPcm=new Float32Array(periodicBytes.buffer.slice(periodicBytes.byteOffset,periodicBytes.byteOffset+periodicBytes.length));
  const periodicFile=join(artifacts,'periodic-dynamics-output.wav');
  writeFloatWav(periodicFile,periodicPcm,periodicRate,2);
  report.periodic.file=periodicFile;
  const periodicRms=(start,end)=>{
    const block=periodicPcm.slice(Math.round((start-periodicStartTime)*periodicRate)*2,Math.round((end-periodicStartTime)*periodicRate)*2);
    return Math.sqrt(block.reduce((sum,value)=>sum+value*value,0)/block.length);
  };
  report.periodic.contrasts=[30,33,36,39,42,45,48,51,54,57].map(start=>20*Math.log10(periodicRms(start+.25,start+.45)/periodicRms(start+2,start+2.2)));
  assert.ok(report.periodic.contrasts.every(value=>Math.abs(value-12)<=.5),'Recorded destination PCM must retain the 12 dB phrase contrast');
  await checkpoint('periodic-high-dynamics-stable');
  await setSlider('targetLufs', -17.5);
  const mixedTraceStart = report.trace.length;
  await playFixture('mixed.wav');
  await observe(45);
  const mixed = await checkpoint('mixed-input-below-target');
  await screenshot('mixed');
  assert.ok(Math.abs(mixed.input - reference.integratedLufs) <= .4, 'Input differs from independent FFmpeg measurement');
  assert.ok(report.trace.slice(mixedTraceStart).some(row => row.programmeGain > 1.2), 'Below-target integrated input must allow programme amplification');
  assert.ok(Math.abs(mixed.output+17.5)<=.5,'Average output must reach the target despite loud phrases');
  assert.ok(mixed.maximumMomentary > -15.5 && Number.isFinite(mixed.maximumShortTerm), 'Display genuine extrema without capping them');
  assert.equal(mixed.safety, 1, 'Regression fixture must not hit peak protection');
  assert.ok(mixed.targetLabel.includes('积分'), 'UI must identify the integrated target');
  await setSlider('targetLufs', -21);
  await observe(10);
  const lower = await checkpoint('target-lowered');
  assert.ok(lower.gain < 1 && lower.output < mixed.output - 2, 'Lower target must attenuate and clear obsolete output history');
  assert.ok(Math.abs(lower.output+21)<=.5, 'Lower target must normalize average output');
  assert.ok(Math.abs(lower.input - mixed.input) <= .4, 'Target change must retain input history');
  await setSlider('targetLufs', -17.5);
  await observe(20);
  const raised = await checkpoint('target-raised');
  assert.ok(raised.output > lower.output + 2, 'Raised target must recover amplification');
  assert.ok(Math.abs(raised.output+17.5)<=.5, 'Raised target must normalize average output');
  await evaluate(`document.querySelector('audio').pause();document.querySelector('audio').currentTime=5`);
  await observe(1, false);
  const sought = await checkpoint('seek-retains-integrated-history');
  assert.ok(Math.abs(sought.input - raised.input) <= .2, 'Seek must retain the integrated control reference');
  assert.ok(Math.abs(sought.gain - raised.gain) <= .01, 'Seek while paused must preserve gain');
  assert.equal(sought.programmeGain, raised.programmeGain, 'Paused seek must preserve the exact ordinary gain');
  await playFixture('silence.wav');
  await observe(5);
  const silent = await checkpoint('new-silent-source');
  assert.equal(silent.gain, .8, 'New silent video must reset gain and never boost');
  assert.equal(silent.input, null, 'New silent source must discard previous integrated loudness');
  await setSlider('maxGain', 1);
  await playFixture('quiet.wav');
  await observe(10);
  const bound = await checkpoint('gain-limit');
  assert.equal(bound.gain, 1, 'Configured gain upper bound must be honored');
  assert.ok(bound.phase.includes('达到倍率限制'), 'Unreachable target must be explicit');
  await screenshot('gain-limit');
  await setSlider('minGain', 1);
  await playFixture('loud.wav');
  await observe(7);
  const floor = await checkpoint('user-gain-floor');
  assert.equal(floor.gain,1,'A LUFS extreme must not override the user gain floor');
  assert.ok(floor.maximumMomentary>-15.5&&floor.maximumShortTerm>-15.5,'Display extrema beyond target +2 LU');
  assert.ok(floor.phase.includes('达到倍率限制'),'An unreachable average must show the gain bound');
  const captureRate = await evaluate('window.startAudioCapture()');
  recorded.length=0;
  await playFixture('multiple.wav');
  const secondLoad = await evaluate(`(async()=>{const media=document.createElement('audio');media.id='second-media';document.body.append(media);const bytes=await(await fetch('/second.wav')).arrayBuffer();const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');media.src=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));await media.play();return {file:'second.wav',bytes:bytes.byteLength,sha256};})()`);
  report.inputLoads.push(secondLoad);
  assert.equal(secondLoad.sha256,createHash('sha256').update(readFileSync(join(artifacts,'second.wav'))).digest('hex'));
  await observe(8);
  assert.ok(await evaluate(`document.getElementById('second-media').currentTime>7&&!document.getElementById('second-media').paused`), 'Both native media elements must actually play');
  await evaluate('window.stopAudioCapture()');
  assert.equal(await evaluate('window.captureState.sources.size'),1,'All protected media must share one destination guard');
  const bytes = Buffer.concat(recorded.sort((a,b)=>a.sequence-b.sequence).map(row=>row.bytes)), pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length));
  const recordingFile = join(artifacts,'two-media-output.wav');
  writeFloatWav(recordingFile,pcm,captureRate,2);
  const independent = ffmpegMaxima(recordingFile), dense = denseMaxima(pcm,captureRate,2);
  report.multipleMedia = {file:recordingFile,independent,dense};
  assert.ok(pcm.length>captureRate*2*7, 'Record more than seven seconds of real destination PCM');
  assert.ok(dense.peak<=.891251&&independent.truePeak<=1, 'Mixed destination must not bypass peak protection');
  assert.ok(dense.rms>1e-3, 'Mixed destination must retain useful audio');
  await screenshot('two-media');
  await setSlider('targetLufs',-21);
  await observe(1);
  recorded.length=0;
  await evaluate('window.startAudioCapture()');
  await observe(4);
  await evaluate(`(()=>{const media=document.getElementById('second-media');media.pause();URL.revokeObjectURL(media.src);media.remove();})()`);
  await observe(4);
  await evaluate('window.stopAudioCapture()');
  const lifecycleBytes=Buffer.concat(recorded.sort((a,b)=>a.sequence-b.sequence).map(row=>row.bytes));
  const lifecyclePcm=new Float32Array(lifecycleBytes.buffer.slice(lifecycleBytes.byteOffset,lifecycleBytes.byteOffset+lifecycleBytes.length));
  const lifecycleFile=join(artifacts,'mixed-target-change-and-removal.wav');
  writeFloatWav(lifecycleFile,lifecyclePcm,captureRate,2);
  const lifecycleReference=ffmpegMaxima(lifecycleFile);
  // Independently measure the final three seconds after the second media is gone.
  const remainingFile=join(artifacts,'remaining-media-output.wav');
  writeFloatWav(remainingFile,lifecyclePcm.slice(-captureRate*2*3),captureRate,2);
  const remainingReference=ffmpegMaxima(remainingFile);
  report.mixedLifecycle={file:lifecycleFile,independent:lifecycleReference,remainingFile,remainingReference};
  assert.ok(lifecycleReference.truePeak<=1,'Target changes must retain digital clipping protection');
  assert.ok(remainingReference.momentary>-20&&remainingReference.truePeak<=1,'Removing one media must leave the other audible and protected');
  assert.equal(await evaluate('window.captureState.sources.size'),1,'Removing one media must retain the shared output');
  await evaluate(`document.querySelectorAll('audio').forEach(media=>media.remove())`);
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`document.getElementById('universal-volume-eq-panel').style.display==='none'`)) break;
    await delay(100);
  }
  const nodes = new Map(), connections = new Set();
  for (const { method, params } of report.audioGraphEvents) {
    if (method === 'WebAudio.audioNodeCreated') nodes.set(params.node.nodeId, params.node.nodeType);
    if (method === 'WebAudio.nodesConnected') connections.add(params.sourceId + ':' + params.destinationId);
    if (method === 'WebAudio.nodesDisconnected') {
      for (const edge of connections) if (edge.startsWith(params.sourceId + ':')
        && (!params.destinationId || edge === params.sourceId + ':' + params.destinationId)) connections.delete(edge);
    }
  }
  report.remainingAudioConnections = [...connections];
  assert.ok([...nodes.values()].some(type => type.includes('Worklet')), 'Native WebAudio graph must include the processor');
  assert.equal(connections.size, 0, 'Removing media must disconnect the entire native audio graph');
  assert.deepEqual(await evaluate('window.analysisCalls'),[],'Realtime operation must never decode a complete track');
  for(const name of new Set(report.inputLoads.map(row=>row.file))){
    assert.equal(report.requests.filter(url=>url==='/'+name).length,report.inputLoads.filter(row=>row.file===name).length,'Only the test player may load audio; the extension cannot fetch a complete track');
  }
  report.pass = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if(browser)report.mediaEvents=await evaluate('window.mediaEvents').catch(()=>null);
  try { await browser?.close(); }
  catch (error) { report.pass = false; report.error = String(error); process.exitCode = 1; }
  finally { server.close(); }
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, artifacts }));
}
