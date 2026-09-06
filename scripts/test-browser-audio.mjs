import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { buildSync } from 'esbuild';
import assert from 'node:assert/strict';

// Uses an isolated browser profile, never the user's running browser/profile.
const executable = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].find(existsSync);
if (!executable) throw new Error('Set CHROME_PATH to a Chromium executable.');
const worklet = readFileSync(resolve('dist/limiter-worklet.js'));
const processorModule = buildSync({ entryPoints: ['src/audio-context.ts'], bundle: true,
  write: false, format: 'esm' }).outputFiles[0].text;
const page = `<!doctype html><script type="module">
import {createAudioProcessor} from '/processor.js';
window.result = null;
try {
  const results=[];
  for(const inputChannels of [1,2,6]) {
  const rate = 48000, target = -21, seconds = 8, length = Math.round((seconds + .1) * rate);
  const ctx = new OfflineAudioContext(2, length, rate);
  await ctx.audioWorklet.addModule('/worklet.js');
  const source = ctx.createBufferSource();
  source.buffer = ctx.createBuffer(inputChannels, seconds * rate, rate);
  for (let c=0;c<inputChannels;c++) {
    const data=source.buffer.getChannelData(c);
    for (let i=0;i<data.length;i++) {
      const t=i/rate;
      const amp=t<1?.04:t<4?0:t<4.2?.8:t<5?.03:.4;
      data[i]=amp*Math.sin(2*Math.PI*(t<5?(c?1200:1000):80)*t);
    }
  }
  const bass=ctx.createBiquadFilter(); bass.type='lowshelf'; bass.frequency.value=120; bass.gain.value=6;
  const gain=ctx.createGain(); gain.gain.value=1.8;
  const guard=createAudioProcessor(ctx);
  source.connect(bass).connect(gain).connect(guard,0,0).connect(ctx.destination);
  bass.connect(guard,0,1);
  source.start();
  const output=await ctx.startRendering();
  let first=-1,peak=0,stereoDifference=0;
  for(let i=0;i<length;i++) {
    for(let c=0;c<2;c++) {
      const x=output.getChannelData(c)[i];
      if(!Number.isFinite(x)) throw new Error('Nonfinite output');
      if(x!==0&&first<0)first=i;
      peak=Math.max(peak,Math.abs(x));
    }
    stereoDifference+=Math.abs(output.getChannelData(0)[i]-output.getChannelData(1)[i]);
  }
  const expectedLatencyMs=15;
  results.push({inputChannels,peak,stereoDifference,latencyMs:first/rate*1000,
    pass:peak<=.891251&&peak>0&&Math.abs(first/rate*1000-expectedLatencyMs)<=1
      &&(inputChannels===1||stereoDifference>1)});
  }
  async function toneRms(amplitude) {
    const toneRate=48000;
    const context=new OfflineAudioContext(1,Math.round(toneRate*.6),toneRate);
    await context.audioWorklet.addModule('/worklet.js');
    const tone=context.createBufferSource();
    tone.buffer=context.createBuffer(1,Math.round(toneRate*.5),toneRate);
    const data=tone.buffer.getChannelData(0);
    for(let i=0;i<data.length;i++)data[i]=amplitude*Math.sin(2*Math.PI*997*i/toneRate);
    const toneBass=context.createBiquadFilter(); toneBass.type='lowshelf'; toneBass.frequency.value=120; toneBass.gain.value=6;
    const toneGain=context.createGain(); toneGain.gain.value=1;
    const toneGuard=createAudioProcessor(context);
    tone.connect(toneBass).connect(toneGain).connect(toneGuard,0,0).connect(context.destination);
    toneBass.connect(toneGuard,0,1);
    tone.start();
    const rendered=await context.startRendering(),pcm=rendered.getChannelData(0);
    let energy=0,count=0;
    for(let i=Math.round(toneRate*.03);i<Math.round(toneRate*.5);i++){energy+=pcm[i]*pcm[i];count++;}
    return Math.sqrt(energy/count);
  }
  const quiet=await toneRms(.01), loud=await toneRms(.1);
  const toneDifference=20*Math.log10(loud/quiet);
  window.result={results,toneDifference,pass:results.every(result=>result.pass)&&Math.abs(toneDifference-20)<=.2};
}catch(error){window.result={error:String(error.stack||error)};}
</script>`;
const server = createServer((req,res) => {
  const body=req.url==='/worklet.js'?worklet:req.url==='/processor.js'?processorModule:page;
  res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html');
  res.end(body);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=mkdtempSync(join(tmpdir(),'volume-eq-browser-'));
let browser, socket;
const pending=new Map();let sequence=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function send(method,params={}) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},60000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});
    socket.send(JSON.stringify({id,method,params}));
  });
}
try {
  browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  const portFile=join(profile,'DevToolsActivePort');
  for(let i=0;i<200&&!existsSync(portFile);i++)await delay(100);
  assert.ok(existsSync(portFile),'Browser did not start');
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{
    const message=JSON.parse(event.data),request=pending.get(message.id);
    if(request){pending.delete(message.id);request.resolve(message);}
  };
  await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  let result;
  for(let i=0;i<300;i++) {
    await delay(100);
    const response=await send('Runtime.evaluate',{expression:'window.result',returnByValue:true});
    result=response.result?.result?.value;
    if(result)break;
  }
  console.log(JSON.stringify(result,null,2));
  assert.equal(result?.pass,true,'Browser output safety failed');
} finally {
  if(socket?.readyState===WebSocket.OPEN) {
    socket.send(JSON.stringify({id:++sequence,method:'Browser.close'}));
    socket.close();
  }
  if(browser){await delay(500);if(browser.exitCode===null)browser.kill();}
  server.close();
  // Only the unique profile created above is removed.
  rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
