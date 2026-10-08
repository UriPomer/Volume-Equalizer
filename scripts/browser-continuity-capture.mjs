// Independent measurement taps before processing and at the native destination.
// Neither tap feeds production audio. Preserve the input observation even when
// production disconnects its source, so a missing output cannot hide its input.
export const continuityProcessor = `
class ContinuityRecorder extends AudioWorkletProcessor {
  constructor(){super();this.index=0;this.frames=Math.round(sampleRate/10);this.pcm=new Float32Array(this.frames*4);this.sequence=0;}
  process(inputs){
    const frames=inputs[0][0]?.length||inputs[1][0]?.length||128;
    for(let frame=0;frame<frames;frame++){
      for(let side=0;side<2;side++)for(let channel=0;channel<2;channel++){
        this.pcm[this.index*4+side*2+channel]=inputs[side][channel]?.[frame]||0;
      }
      if(++this.index===this.frames){
        this.port.postMessage({sequence:this.sequence++,startFrame:currentFrame+frame+1-this.frames,pcm:this.pcm},[this.pcm.buffer]);
        this.pcm=new Float32Array(this.frames*4);this.index=0;
      }
    }
    return true;
  }
}
registerProcessor('continuity-recorder',ContinuityRecorder);`;

export function continuityBootstrap(recorderUrl) {
  return `
window.continuity=null;
const NativeContext=window.AudioContext,nativeConnect=AudioNode.prototype.connect,nativeDisconnect=AudioNode.prototype.disconnect;
window.AudioContext=class extends NativeContext {
  constructor(...args){
    super(...args);
    const state={context:this,inputs:new Set(),mediaSources:new Map(),events:[],outputs:new Set(),recorder:null,error:null,graphs:[],gains:[]};
    window.continuity=state;this.continuity=state;
    state.ready=this.audioWorklet.addModule(${recorderUrl}).then(()=>{
      state.recorder=new AudioWorkletNode(this,'continuity-recorder',{numberOfInputs:2,numberOfOutputs:0,channelCount:2,channelCountMode:'explicit'});
      state.recorder.onprocessorerror=()=>{state.error='Independent recorder failed';};
      state.recorder.port.onmessage=event=>{
        const bytes=new Uint8Array(event.data.pcm.buffer),parts=[];
        for(let i=0;i<bytes.length;i+=16384)parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
        window.__volumeEqRecording(JSON.stringify({sequence:event.data.sequence,startFrame:event.data.startFrame,pcm:btoa(parts.join(''))}));
      };
      for(const source of state.inputs)Reflect.apply(nativeConnect,source,[state.recorder,0,0]);
      for(const source of state.outputs)Reflect.apply(nativeConnect,source,[state.recorder,0,1]);
    });
    this.addEventListener('statechange',()=>state.graphs.push({type:'context-state',state:this.state,time:this.currentTime}));
  }
  createMediaElementSource(media){
    const source=super.createMediaElementSource(media),state=this.continuity;
    state.inputs.add(source);
    state.mediaSources.set(media,source);
    for(const type of ['play','pause','waiting','stalled','seeking','seeked','ended','emptied'])media.addEventListener(type,()=>state.events.push({type,primary:media.hasAttribute('data-volume-eq-primary'),mediaTime:media.currentTime,contextTime:source.context.currentTime}));
    if(state.recorder)Reflect.apply(nativeConnect,source,[state.recorder,0,0]);
    return source;
  }
  createGain(){
    const node=super.createGain(),set=node.gain.setValueAtTime,state=this.continuity;
    node.gain.setValueAtTime=function(value,time){state.gains.push({value,time});return Reflect.apply(set,this,[value,time]);};
    return node;
  }
};
AudioNode.prototype.connect=function(destination,...args){
  const result=Reflect.apply(nativeConnect,this,[destination,...args]),state=this.context.continuity;
  if(state&&destination===this.context.destination){
    state.outputs.add(this);state.graphs.push({type:'output-connect',node:this.constructor.name,time:this.context.currentTime});
    if(state.recorder)Reflect.apply(nativeConnect,this,[state.recorder,0,1]);
  }
  return result;
};
AudioNode.prototype.disconnect=function(...args){
  const result=Reflect.apply(nativeDisconnect,this,args),state=this.context.continuity;
  if(state&&(!args.length||args[0]===this.context.destination)){
    state.outputs.delete(this);state.graphs.push({type:'output-disconnect',node:this.constructor.name,time:this.context.currentTime});
    if(args.length&&state.recorder)Reflect.apply(nativeDisconnect,this,[state.recorder,0,1]);
    if(state.inputs.has(this)&&state.recorder)Reflect.apply(nativeConnect,this,[state.recorder,0,0]);
  }
  return result;
};
`;
}
