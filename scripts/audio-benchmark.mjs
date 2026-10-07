import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFloatWav } from './audio-test-artifacts.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REFERENCE_SETTINGS, measureWithFfmpeg } from './offline-loudness-reference.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = process.env.VOLUME_EQ_RESULTS_DIR || join(root, 'test-results');
const fixtures = JSON.parse(readFileSync(join(root, 'tests/fixtures/audio-videos.json'), 'utf8'));
// Level-shift holdouts share content, not an offline gain decision. They exercise
// cross-video normalization at amplitudes not used to tune the original fixture.
const levelSource = fixtures.find(f => f.id === 'clear-layout');
for (const offset of [-6, 6]) fixtures.push({ ...levelSource,
  id: `clear-layout-${offset < 0 ? 'quiet' : 'loud'}-holdout`, inputGainDb: offset });
if(process.env.VOLUME_EQ_REFERENCE_AUDIO)fixtures.push({id:'reported-bilibili',file:process.env.VOLUME_EQ_REFERENCE_AUDIO,inputGainDb:0});
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
  (name,value)=>{if(name==='lookahead-peak-limiter')Processor=value;},48000);

mkdirSync(resultsDir,{recursive:true});
const reports=[];
for(const fixture of selectedFixtures) {
  const file=fixture.id==='reported-bilibili'?fixture.file:join(root,'tests/fixtures/videos',fixture.file);
  if(!existsSync(file)) throw new Error('Run npm run test:audio:download first');
  const ffmpeg=measureWithFfmpeg(file,fixture.inputGainDb);
  const decoded=spawnSync('ffmpeg',['-v','error','-i',file,'-map','0:a:0',
    '-af',`volume=${fixture.inputGainDb}dB`,'-ar','48000','-ac','2','-f','f32le','-'],
    {maxBuffer:512*1024*1024});
  if(decoded.status!==0)throw new Error(decoded.stderr.toString());
  const pcm=new Float32Array(decoded.stdout.buffer,decoded.stdout.byteOffset,decoded.stdout.length/4);
  const result=simulate(pcm);
  const outputFile=join(resultsDir,fixture.id+'-output.wav');
  writeFloatWav(outputFile,result.outputPcm,48000,2);
  const outputReference=measureWithFfmpeg(outputFile);
  delete result.outputPcm;
  const included=fixture.includeInEvaluation!==false;
  const report={id:fixture.id,included,mode:'realtime',...result,
    sourceSha256:createHash('sha256').update(readFileSync(file)).digest('hex'),
    outputFile,ffmpegOutput:outputReference,
    ffmpegInputIntegratedLufs:ffmpeg.integratedLufs,
    inputMeasurementDiffLu:result.inputIntegratedLufs-ffmpeg.integratedLufs};
  report.measurementPass=Math.abs(report.inputMeasurementDiffLu)<=.5
    &&Math.abs(result.outputIntegratedLufs-outputReference.integratedLufs)<=.5;
  report.targetReached=Math.abs(outputReference.integratedLufs+21)<=2;
  report.loudnessPass=report.targetReached;
  report.stabilityPass=report.maximumStableGainStep<=.020001
    &&report.limitedFractionAfterStable<=.01;
  report.pass=report.measurementPass&&report.loudnessPass&&report.stabilityPass;
  reports.push(report);
  console.log(JSON.stringify({...report,trace:undefined}));
  if(traceEnabled)writeFileSync(join(resultsDir,fixture.id+'-gain-trace.jsonl'),
    result.trace.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
const summary={targetLufs:DEFAULT_REFERENCE_SETTINGS.targetLufs,allFixtures:fixtureIndex<0,generatedAt:new Date().toISOString(),
  reports:reports.map(({trace,...report})=>report)};
const evaluated=summary.reports.filter(r=>r.included);
summary.crossVideoIntegratedSpreadLu=Math.max(...evaluated.map(r=>r.outputIntegratedLufs))
  -Math.min(...evaluated.map(r=>r.outputIntegratedLufs));
summary.pass=evaluated.every(r=>r.pass)&&summary.crossVideoIntegratedSpreadLu<=3;
writeFileSync(join(resultsDir,'audio-benchmark.json'),JSON.stringify(summary,null,2)+'\n');
writeFileSync(join(resultsDir,'audio-benchmark.md'),renderReport(summary));
console.log('cross-video integrated spread:',summary.crossVideoIntegratedSpreadLu.toFixed(3),'LU; pass:',summary.pass);
if(enforce&&!summary.pass)process.exitCode=1;

function simulate(pcm) {
  const rate=48000,frames=pcm.length/2,chunk=4800;
  const inputMeter=new LoudnessMeter(rate,Infinity), outputMeter=new LoudnessMeter(rate,Infinity);
  const agc=new RealtimeAgc(),processor=new Processor({processorOptions:{}});
  const trace=[],messages=[];
  processor.port.postMessage=m=>messages.push(m);
  let gain=INITIAL_GAIN,firstStable=null,anchor=null,limited=false,limitedAfter=0,framesAfter=0;
  const outputPcm=new Float32Array((frames+rate)*2);
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
    for(let offset=0;offset<count;offset+=128) {
      const end=Math.min(count,offset+128);
      const rendered=[new Float32Array(end-offset),new Float32Array(end-offset)];
      processor.process([gained.map(c=>c.subarray(offset,end)),raw.map(c=>c.subarray(offset,end))],
        [rendered]);
      for(let i=0;i<end-offset;i++)for(let c=0;c<2;c++)outputPcm[(start+offset+i)*2+c]=rendered[c][i];
    }
    for(const message of messages.splice(0)){
      outputMeter.processChannels(message.output);
      if(start<frames) {
        inputMeter.processChannels(message.original);
        const momentary=inputMeter.getMomentaryLoudness();
        const decision=agc.update({
          currentGain:gain,minGain:.25,maxGain:2,deltaSec:.1,targetLufs:-21,
          integratedLufs:inputMeter.getIntegratedLoudness(),
          momentaryLufs:momentary,gainChangePerSec:.2
        });
        gain=decision.nextGain;
        limited=decision.limited;
        const time=Math.min((start+count)/rate,frames/rate);
        if(firstStable===null&&decision.phase==='stable'){firstStable=time;anchor=gain;}
        if(firstStable!==null) {
          limitedAfter+=message.limitedFrames??0;
          framesAfter+=message.frames??message.output[0].length;
        }
        trace.push({time,inputMomentaryLufs:momentary,outputMomentaryLufs:outputMeter.getMomentaryLoudness(),gain:previousGain,effectiveGain:previousGain*(message.safetyGain??1),
          nextProgrammeGain:gain,referenceLufs:decision.referenceLufs,phase:decision.phase});
      }
    }
  }
  const gains=trace.filter(r=>firstStable!==null&&r.time>=firstStable).map(r=>r.effectiveGain).sort((a,b)=>a-b);
  // The stable decision applies to the next audio block. Include the anchor
  // and every subsequent decision, never discard outliers or changed phases.
  const programmeGains=trace.filter(r=>firstStable!==null&&r.time>=firstStable).map(r=>r.nextProgrammeGain).sort((a,b)=>a-b);
  return {
    outputPcm, durationSeconds:frames/rate,inputIntegratedLufs:inputMeter.getIntegratedLoudness(),
    outputIntegratedLufs:outputMeter.getIntegratedLoudness(),
    inputMaximumMomentaryLufs:inputMeter.getMaximumMomentaryLoudness(),inputMaximumShortTermLufs:inputMeter.getMaximumShortTermLoudness(),
    outputMaximumMomentaryLufs:outputMeter.getMaximumMomentaryLoudness(),outputMaximumShortTermLufs:outputMeter.getMaximumShortTermLoudness(),
    outputTargetDiffLu:outputMeter.getIntegratedLoudness()+21,
    firstStableSeconds:firstStable,gain99Span:gains.length?quantile(gains,.995)-quantile(gains,.005):null,
    totalGainSpan:gains.length?gains.at(-1)-gains[0]:null,
    programmeGainAnchor:anchor,
    programmeGainSpan:programmeGains.length?programmeGains.at(-1)-programmeGains[0]:null,
    programmeGainAnchorDeviation:programmeGains.length?Math.max(Math.abs(programmeGains[0]-anchor),Math.abs(programmeGains.at(-1)-anchor)):null,
    limitedFractionAfterStable:framesAfter?limitedAfter/framesAfter:1,
    maximumStableGainStep:trace.reduce((maximum,row,i)=>firstStable!==null&&row.time>=firstStable&&i
      ?Math.max(maximum,Math.abs(row.nextProgrammeGain-trace[i-1].nextProgrammeGain)):maximum,0),
    finalGain:gain,boundLimited:limited,trace
  };
}
function quantile(sorted,p) {
  const index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);
}
function renderReport(summary) {
  return '# Realtime programme normalization benchmark\n\n'
    +'Causal realtime target: -21 LUFS, whole-output tolerance 2 LU. '
    +'Each decision uses only previously rendered PCM. Independent FFmpeg measures the saved destination WAV. '
    +'LUFS extrema are displayed without imposing a loudness ceiling; every stable gain step is at most 0.02x.\n\n'
    +'| Video | Output integrated LUFS | Target error LU | Max momentary LUFS | Max short-term LUFS | Programme gain span | Target reached | Result |\n'
    +'|---|---:|---:|---:|---:|---:|---|---|\n'
    +summary.reports.map(r=>'| '+[r.id,r.outputIntegratedLufs.toFixed(3),r.outputTargetDiffLu.toFixed(3),
      r.outputMaximumMomentaryLufs.toFixed(3),r.outputMaximumShortTermLufs.toFixed(3),
      r.programmeGainSpan?.toFixed(4),r.targetReached,r.included?(r.pass?'PASS':'FAIL'):'Diagnostic'].join(' | ')+' |').join('\n')
    +'\n\nCross-video integrated spread: '+summary.crossVideoIntegratedSpreadLu.toFixed(3)+' LU.\n';
}
