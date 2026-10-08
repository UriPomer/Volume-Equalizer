import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './browser-session.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { denseMaxima, ffmpegMaxima, sha256, writeFloatWav } from './audio-test-artifacts.mjs';

// Failure model: LUFS extrema must not attenuate unclipped PCM; meter resets
// must not alter audio; quiet/loud contrast and deliberate programme changes
// must survive. Actual sample/inter-sample clipping remains protected.
const cases = [
  { id: 'first-loud-mono', rate: 48000, channels: 1, target: -21, mode: 'loud' },
  { id: 'burst-stereo', rate: 48000, channels: 2, target: -17.5, mode: 'burst' },
  { id: 'surround', rate: 48000, channels: 6, target: -23, mode: 'loud' },
  { id: '44100-bass-eq', rate: 44100, channels: 2, target: -21, mode: 'bass', bass: 6 },
  { id: 'high-programme-gain', rate: 48000, channels: 2, target: -23, mode: 'loud', gain: 8 },
  { id: 'meter-reset', rate: 48000, channels: 2, target: -21, mode: 'loud', resetAt: 2 },
  { id: 'meter-reset-baseline', rate: 48000, channels: 2, target: -21, mode: 'loud' },
  ...[1, 2, 6].map(channels => ({ id: `mix-${channels}-to-stereo`, rate: 48000, channels,
    outputChannels: 2, seconds: 8, target: -21, mode: 'mixed', gain: 1.8, bass: 6, bassFrequency: 120 })),
  { id: 'broadband-noise', rate: 48000, channels: 2, target: -21, mode: 'noise' },
  { id: 'sub-bass', rate: 48000, channels: 2, target: -21, mode: 'sub-bass', bass: 6, gain: 3 },
  { id: 'frequency-jump', rate: 48000, channels: 2, target: -21, mode: 'frequency-jump' },
  { id: 'off-grid-pulses', rate: 44100, channels: 2, target: -23, mode: 'pulses' },
  { id: 'intersample-peaks', rate: 48000, channels: 1, target: -21, mode: 'intersample' },
  { id: 'surround-eight', rate: 48000, channels: 8, target: -21, mode: 'loud' },
  { id: 'source-end-tail', rate: 48000, channels: 1, target: -21, mode: 'tail-impulse' },
  { id: 'preserve-loud-quiet-dynamics', rate: 48000, channels: 2, target: -21, mode: 'dynamics', seconds: 18 },
  { id: 'preserve-amplified-dynamics', rate: 48000, channels: 2, target: -21, mode: 'dynamics', seconds: 18, gain: 2 },
  { id: 'programme-decrease-keeps-dynamics', rate: 48000, channels: 2, target: -21, mode: 'dynamics', seconds: 18, gain: 2, gainChangeAt: 6.001, nextGain: 1 },
  { id: 'quiet', rate: 48000, channels: 2, target: -21, mode: 'quiet' },
  { id: 'quiet-times-ten', rate: 48000, channels: 2, target: -21, mode: 'quiet', gain: 10 }
].map(spec => ({ seconds: 7, gain: 1, outputChannels: spec.channels, ...spec }));
const artifacts = mkdtempSync(join(process.env.VOLUME_EQ_ARTIFACT_ROOT || tmpdir(), 'volume-eq-dynamics-'));
const worklet = readFileSync(process.env.VOLUME_EQ_WORKLET_PATH || 'dist/limiter-worklet.js');
const processor = buildSync({ entryPoints: ['src/audio-context.ts'], bundle: true,
  write: false, format: 'esm' }).outputFiles[0].text;
const report = { command: 'npm run test:browser', workletSha256: sha256(worklet),
  testSourceSha256: sha256(readFileSync(new URL(import.meta.url))),
  createdAt: new Date().toISOString(), cases: [], pass: false };
const page = `<!doctype html><script type="module">
import {createAudioProcessor} from '/processor.js';
window.result=null;
try {
  const resetEpochs={};
  for(const spec of ${JSON.stringify(cases)}) {
    const context=new OfflineAudioContext(spec.outputChannels,Math.round((spec.seconds+.1)*spec.rate),spec.rate);
    await context.audioWorklet.addModule('/worklet.js');
    const source=context.createBufferSource();
    source.buffer=context.createBuffer(spec.channels,spec.seconds*spec.rate,spec.rate);
    for(let c=0;c<spec.channels;c++) {
      const data=source.buffer.getChannelData(c);
      let noiseSeed=0x12345678+c;
      for(let i=0;i<data.length;i++) {
        const t=i/spec.rate;
        const amplitude=spec.mode==='dynamics'?.35*(t%3<.8?1:Math.pow(10,-12/20)):spec.mode==='mixed'?(t<1?.04:t<4?0:t<4.2?.8:t<5?.03:.4):spec.mode==='quiet'?.006:spec.mode==='burst'?(t<1?.006:t<1.08?.9:t<2?.006:.6):.65;
        const frequency=spec.mode==='mixed'?(t<5?(c?1200:1000):80):spec.mode==='bass'?80:spec.mode==='sub-bass'?30:spec.mode==='frequency-jump'?(t%1<.5?50:7000):997+c*127;
        if(spec.mode==='tail-impulse')data[i]=i===data.length-1?.1:0;
        else if(spec.mode==='noise'){noiseSeed=(Math.imul(noiseSeed,1664525)+1013904223)>>>0;data[i]=(noiseSeed/4294967296*2-1)*.8;}
        else if(spec.mode==='pulses')data[i]=((i+53)%827<23)?.9:0;
        else if(spec.mode==='intersample')data[i]=i%4===3?-.4:-.89;
        else data[i]=amplitude*Math.sin(2*Math.PI*frequency*t);
      }
    }
    const bass=context.createBiquadFilter();bass.type='lowshelf';bass.frequency.value=spec.bassFrequency||200;bass.gain.value=spec.bass||0;
    const gain=context.createGain();gain.gain.value=spec.gain;
    const guard=createAudioProcessor(context);
    if(spec.gainChangeAt)gain.gain.setValueAtTime(spec.nextGain,spec.gainChangeAt);
    let resetAcknowledged;
    const resetObserved=new Promise(resolve=>{resetAcknowledged=resolve;});
    guard.port.onmessage=event=>{if(event.data.epoch===1){resetEpochs[spec.id]=1;resetAcknowledged();}};
    if(spec.resetAt)context.suspend(spec.resetAt).then(()=>{guard.port.postMessage({type:'reset-meter',epoch:1});context.resume();});
    source.connect(bass).connect(gain).connect(guard,0,0).connect(context.destination);
    bass.connect(guard,0,1);
    source.start();
    const output=await context.startRendering();
    if(spec.resetAt)await Promise.race([resetObserved,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Meter reset not observed')),1000))]);
    const pcm=new Float32Array(output.length*spec.outputChannels);
    for(let c=0;c<spec.outputChannels;c++){const data=output.getChannelData(c);for(let i=0;i<data.length;i++)pcm[i*spec.outputChannels+c]=data[i];}
    await fetch('/output/'+spec.id,{method:'POST',body:pcm.buffer});
  }
  window.result={pass:true,resetEpochs};
}catch(error){window.result={error:String(error.stack||error)};}
</script>`;
writeFileSync(join(artifacts, 'fixture.html'), page);
const rendered = new Map();
const server = createServer(async (req, res) => {
  const spec = cases.find(item => req.url === '/output/' + item.id);
  if (req.method === 'POST' && spec) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    rendered.set(spec.id, pcm);
    writeFloatWav(join(artifacts, spec.id + '.wav'), pcm, spec.rate, spec.outputChannels);
    res.end('ok'); return;
  }
  res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(req.url === '/worklet.js' ? worklet : req.url === '/processor.js' ? processor : page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await openBrowser(artifacts);
  report.browser = await browser.send('Browser.getVersion');
  await browser.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  let result;
  for (let i = 0; i < 300; i++) {
    await delay(100);
    result = await browser.evaluate('window.result');
    if (result) break;
  }
  assert.equal(result?.pass, true, JSON.stringify(result));
  report.resetEpochs = result.resetEpochs;
  for (const spec of cases) {
    const pcm = rendered.get(spec.id);
    assert.ok(pcm, 'Missing rendered audio: ' + spec.id);
    const epochs = [[0, pcm.length / spec.outputChannels / spec.rate, spec.target]];
    const results = epochs.map(([start, end, target], index) => {
      const audio = pcm.slice(Math.round(start * spec.rate) * spec.outputChannels, Math.round(end * spec.rate) * spec.outputChannels);
      const file = join(artifacts, spec.id + '-epoch-' + index + '.wav');
      writeFloatWav(file, audio, spec.rate, spec.outputChannels);
      const independent = ffmpegMaxima(file), dense = denseMaxima(audio, spec.rate, spec.outputChannels);
      return { start, end, target, independent, dense,
        pass: Number.isFinite(dense.momentary)
          && (end - start < 3 || Number.isFinite(dense.shortTerm))
          // Sample ceiling is -1 dBFS; independent reconstructed peaks must
          // remain below full scale. This does not claim a -1 dBTP limiter.
          && dense.peak <= .891251 && independent.truePeak <= 1 && dense.rms > 1e-4 };
    });
    // A 0.65 sine has ample digital headroom. It must pass at the supplied
    // gain regardless of the target; its LUFS maximum intentionally exceeds it.
    const transparent = spec.mode !== 'loud' || spec.gain !== 1
      || Math.abs(Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length)
        / (.65 / Math.sqrt(2) * Math.sqrt(spec.seconds / (spec.seconds + .1))) - 1) < .001;
    const first = pcm.findIndex(sample => sample !== 0);
    const latencyMs = (first / spec.outputChannels / spec.rate - (spec.mode === 'tail-impulse' ? spec.seconds - 1 / spec.rate : 0)) * 1000;
    let stereoDifference = 0;
    if (spec.mode === 'mixed') for (let i = 0; i < pcm.length; i += 2) stereoDifference += Math.abs(pcm[i] - pcm[i + 1]);
    const timingPass = !['mixed', 'tail-impulse'].includes(spec.mode) || Math.abs(latencyMs - 15) <= 1;
    const tailPass = spec.mode !== 'tail-impulse' || Math.abs(results[0].dense.peak - .1) < 1e-6;
    const mixPass = spec.mode !== 'mixed' || (spec.channels === 1 ? stereoDifference < 1e-6 : stereoDifference > 1);
    // Independent RMS ratios across complete loud and quiet phrases: a guard
    // that lifts quiet phrases passes a ceiling-only test but fails this one.
    const rms = (start,end) => {
      const block=pcm.slice(Math.round(start*spec.rate)*spec.outputChannels,Math.round(end*spec.rate)*spec.outputChannels);
      return Math.sqrt(block.reduce((sum,value)=>sum+value*value,0)/block.length);
    };
    const contrasts=spec.mode==='dynamics'?[3,6,9,12,15].map(start=>20*Math.log10(rms(start+.25,start+.55)/rms(start+2,start+2.3))):[];
    const dynamicsPass=contrasts.every(value=>Math.abs(value-12)<=.2);
    const programmeChangeDb=spec.gainChangeAt?20*Math.log10(rms(9.25,9.55)/rms(3.25,3.55)):0;
    const expectedChangeDb=spec.gainChangeAt?20*Math.log10(spec.nextGain/spec.gain):0;
    report.cases.push({ ...spec, results, latencyMs, stereoDifference,
      contrasts, dynamicsPass,programmeChangeDb,
      transparent, expectedChangeDb,
      pass: transparent && timingPass && tailPass && mixPass && dynamicsPass
        && Math.abs(programmeChangeDb-expectedChangeDb)<=.2 && results.every(row => row.pass) });
  }
  const quiet = report.cases.find(row => row.id === 'quiet').results[0].dense.rms;
  const louder = report.cases.find(row => row.id === 'quiet-times-ten').results[0].dense.rms;
  report.belowCeilingDifferenceDb = 20 * Math.log10(louder / quiet);
  const reset = rendered.get('meter-reset'), baseline = rendered.get('meter-reset-baseline');
  report.meterResetAudioUnchanged = reset.length === baseline.length && reset.every((sample, i) => sample === baseline[i]);
  report.pass = report.cases.every(row => row.pass) && Math.abs(report.belowCeilingDifferenceDb - 20) <= .1
    && report.resetEpochs['meter-reset'] === 1 && report.meterResetAudioUnchanged;
  for (const row of report.cases) console.log(JSON.stringify({ id: row.id, pass: row.pass, results: row.results }));
  assert.equal(report.pass, true, 'Rendered dynamics and digital clipping contract failed');
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) { report.pass = false; report.cleanupError = String(error); process.exitCode = 1; }
  finally { server.close(); }
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, artifacts, error: report.error }));
}
