import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REFERENCE_SETTINGS, measureWithFfmpeg } from './offline-loudness-reference.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'test-results');
const fixtures = JSON.parse(readFileSync(join(root, 'tests/fixtures/audio-videos.json'), 'utf8'));
// Level-shift holdouts share content, not an offline gain decision. They exercise
// cross-video normalization at amplitudes not used to tune the original fixture.
const levelSource = fixtures.find(f => f.id === 'clear-layout');
for (const offset of [-6, 6]) fixtures.push({ ...levelSource,
  id: `clear-layout-${offset < 0 ? 'quiet' : 'loud'}-holdout`, inputGainDb: offset });
const fixtureIndex = process.argv.indexOf('--fixture');
const selectedFixtures = fixtureIndex < 0 ? fixtures : fixtures.filter(f => f.id === process.argv[fixtureIndex + 1]);
if (!selectedFixtures.length) throw new Error('Unknown fixture');
const enforce = process.argv.includes('--enforce'), traceEnabled = process.argv.includes('--trace');
const bundled = buildSync({stdin:{contents: `
export { RealtimeAgc } from './src/gain-control';
export { INITIAL_GAIN } from './src/config';
export { LoudnessMeter } from './src/loudness-meter';`,resolveDir:root},
  bundle:true,write:false,format:'cjs',target:'es2020'}).outputFiles[0].text;
const module = {exports:{}};
new Function('module','exports',bundled)(module,module.exports);
const { RealtimeAgc, LoudnessMeter, INITIAL_GAIN } = module.exports;
let Processor;
new Function('AudioWorkletProcessor','registerProcessor','sampleRate',
  buildSync({entryPoints:[join(root,'public/limiter-worklet.js')],bundle:true,write:false,format:'iife'}).outputFiles[0].text
)(class {constructor(){this.port={postMessage(){}};}},
  (_name,value)=>{Processor=value;},48000);

mkdirSync(resultsDir,{recursive:true});
const reports=[];
for(const fixture of selectedFixtures) {
  const file=join(root,'tests/fixtures/videos',fixture.file);
  if(!existsSync(file)) throw new Error('Run npm run test:audio:download first');
  const ffmpeg=measureWithFfmpeg(file,fixture.inputGainDb);
  const decoded=spawnSync('ffmpeg',['-v','error','-i',file,'-map','0:a:0',
    '-af',`volume=${fixture.inputGainDb}dB`,'-ar','48000','-ac','2','-f','f32le','-'],
    {maxBuffer:512*1024*1024});
  if(decoded.status!==0)throw new Error(decoded.stderr.toString());
  const pcm=new Float32Array(decoded.stdout.buffer,decoded.stdout.byteOffset,decoded.stdout.length/4);
  const result=simulate(pcm);
  const included=fixture.includeInEvaluation!==false;
  const report={id:fixture.id,included,...result,ffmpegInputIntegratedLufs:ffmpeg.integratedLufs,
    inputMeasurementDiffLu:result.inputIntegratedLufs-ffmpeg.integratedLufs};
  report.measurementPass=Math.abs(report.inputMeasurementDiffLu)<=.5;
  report.loudnessPass=Math.abs(report.outputUpper40Lufs-DEFAULT_REFERENCE_SETTINGS.targetLufs)<=1.5;
  report.stabilityPass=report.firstStableSeconds!==null
    &&report.gain99Span<=.5+1e-6&&report.limitedFractionAfterStable<=.01;
  report.pass=report.measurementPass&&report.loudnessPass&&report.stabilityPass;
  reports.push(report);
  console.log(JSON.stringify({...report,trace:undefined}));
  if(traceEnabled)writeFileSync(join(resultsDir,fixture.id+'-gain-trace.jsonl'),
    result.trace.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
const summary={targetLufs:DEFAULT_REFERENCE_SETTINGS.targetLufs,allFixtures:fixtureIndex<0,generatedAt:new Date().toISOString(),
  reports:reports.map(({trace,...report})=>report)};
const evaluated=summary.reports.filter(r=>r.included);
summary.crossVideoUpper40SpreadLu=Math.max(...evaluated.map(r=>r.outputUpper40Lufs))
  -Math.min(...evaluated.map(r=>r.outputUpper40Lufs));
summary.pass=evaluated.every(r=>r.pass)&&summary.crossVideoUpper40SpreadLu<=3;
writeFileSync(join(resultsDir,'audio-benchmark.json'),JSON.stringify(summary,null,2)+'\n');
writeFileSync(join(resultsDir,'audio-benchmark.md'),renderReport(summary));
console.log('cross-video upper40 spread:',summary.crossVideoUpper40SpreadLu.toFixed(3),'LU; pass:',summary.pass);
if(enforce&&!summary.pass)process.exitCode=1;

function simulate(pcm) {
  const rate=48000,frames=pcm.length/2,chunk=4800;
  const inputMeter=new LoudnessMeter(rate,Infinity), outputMeter=new LoudnessMeter(rate,Infinity);
  const agc=new RealtimeAgc(),processor=new Processor({processorOptions:{}});
  const inputWindows=[],outputWindows=[],trace=[],messages=[];
  processor.port.postMessage=m=>messages.push(m);
  let gain=INITIAL_GAIN,firstStable=null,recalibrations=0,limited=false,limitedAfter=0,framesAfter=0;
  for(let start=0;start<frames+rate*.5;start+=chunk) {
    const count=Math.min(chunk,Math.ceil(frames+rate*.5-start));
    const raw=[new Float32Array(count),new Float32Array(count)];
    const gained=[new Float32Array(count),new Float32Array(count)];
    for(let i=0;i<count;i++)for(let c=0;c<2;c++){
      raw[c][i]=start+i<frames?pcm[(start+i)*2+c]:0;
      gained[c][i]=raw[c][i]*gain;
    }
    const previousGain=gain;
    // Causal rendering: the current block uses the previous decision.
    processor.process([gained,raw],[[new Float32Array(count),new Float32Array(count)]]);
    for(const message of messages.splice(0)){
      outputMeter.processChannels(message.output);
      outputWindows.push(outputMeter.getMomentaryLoudness());
      if(start<frames) {
        inputMeter.processChannels(message.original);
        const momentary=inputMeter.getMomentaryLoudness();
        inputWindows.push(momentary);
        const decision=agc.update({
          currentGain:gain,minGain:.25,maxGain:2,deltaSec:.1,targetLufs:-21,
          momentaryLufs:momentary,shortTermLufs:inputMeter.getShortTermLoudness(),gainChangePerSec:.2
        });
        gain=decision.nextGain;
        recalibrations=decision.recalibrations;
        limited=decision.limited;
        const time=Math.min((start+count)/rate,frames/rate);
        if(firstStable===null&&decision.phase==='stable')firstStable=time;
        if(firstStable!==null) {
          limitedAfter+=message.limitedFrames??0;
          framesAfter+=message.frames??message.output[0].length;
        }
        trace.push({time,inputMomentaryLufs:momentary,outputMomentaryLufs:outputMeter.getMomentaryLoudness(),gain:previousGain,effectiveGain:previousGain*(message.safetyGain??1),
          referenceLufs:decision.referenceLufs,phase:decision.phase,recalibrations});
      }
    }
  }
  const gains=trace.filter(r=>firstStable!==null&&r.time>=firstStable).map(r=>r.effectiveGain).sort((a,b)=>a-b);
  const outputUpper40Lufs=upper40(outputWindows);
  return {
    durationSeconds:frames/rate,inputIntegratedLufs:inputMeter.getIntegratedLoudness(),
    outputIntegratedLufs:outputMeter.getIntegratedLoudness(),
    inputUpper40Lufs:upper40(inputWindows),outputUpper40Lufs,outputTargetDiffLu:outputUpper40Lufs+21,
    firstStableSeconds:firstStable,gain99Span:gains.length?quantile(gains,.995)-quantile(gains,.005):null,
    totalGainSpan:gains.length?gains.at(-1)-gains[0]:null,
    limitedFractionAfterStable:framesAfter?limitedAfter/framesAfter:1,
    finalGain:gain,boundLimited:limited,recalibrations,trace
  };
}
// Independent exact sorted-window reference, not the online histogram estimator.
function upper40(windows) {
  const energies=windows.filter(x=>Number.isFinite(x)&&x>-60)
    .map(x=>Math.pow(10,(x+.691)/10)).sort((a,b)=>b-a);
  const count=energies.length*.4;
  if(!count)return NaN;
  let remaining=count,total=0;
  for(const energy of energies){const take=Math.min(1,remaining);total+=energy*take;remaining-=take;if(remaining<=1e-9)break;}
  return -.691+10*Math.log10(total/count);
}
function quantile(sorted,p) {
  const index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);
}
function renderReport(summary) {
  return '# Realtime programme normalization benchmark\n\n'
    +'Target: -21 LUFS. Direct output upper-40% energy mean tolerance: ±1.5 LU. '
    +'After first stable state, central 99% effective gain span ≤0.5x; clipping ≤1% of frames. '
    +'Recalibrations remain included in stability statistics. No compressed-reference substitution.\n\n'
    +'| Video | Output upper40 LUFS | Target error LU | Integrated LUFS | Stable at s | Gain 99% span x | Clipping fraction | Recalibrations | Result |\n'
    +'|---|---:|---:|---:|---:|---:|---:|---:|---|\n'
    +summary.reports.map(r=>'| '+[r.id,r.outputUpper40Lufs.toFixed(3),r.outputTargetDiffLu.toFixed(3),
      r.outputIntegratedLufs.toFixed(3),r.firstStableSeconds,r.gain99Span?.toFixed(4),
      r.limitedFractionAfterStable.toFixed(5),r.recalibrations,r.included?(r.pass?'PASS':'FAIL'):'Diagnostic'].join(' | ')+' |').join('\n')
    +'\n\nCross-video upper40 spread: '+summary.crossVideoUpper40SpreadLu.toFixed(3)+' LU.\n';
}
