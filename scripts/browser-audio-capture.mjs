// Observe the PCM sum entering the native destination. All production
// connections remain intact; this terminal node records a parallel branch.
export const captureProcessor = `
class DestinationRecorder extends AudioWorkletProcessor {
  constructor(){super();this.index=0;this.buffer=new Float32Array(Math.round(sampleRate/10)*2);}
  process(inputs){
    const channels=inputs[0],frames=channels[0]?.length||128;
    for(let i=0;i<frames;i++){
      this.buffer[this.index++]=channels[0]?.[i]||0;
      this.buffer[this.index++]=channels[1]?.[i]||0;
      if(this.index===this.buffer.length){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Float32Array(Math.round(sampleRate/10)*2);this.index=0;}
    }
    return true;
  }
}
registerProcessor('destination-recorder',DestinationRecorder);`;

export const captureBootstrap = `
window.captureState=null;
const NativeContext=window.AudioContext,nativeConnect=AudioNode.prototype.connect,nativeDisconnect=AudioNode.prototype.disconnect;
window.AudioContext=class extends NativeContext {
  constructor(...args){
    super(...args);
    const state={context:this,sources:new Set(),recorder:null,recording:false,pending:new Set(),error:null,sequence:0};
    window.captureState=state;
    this.captureState=state;
    state.ready=this.audioWorklet.addModule('/capture.js').then(()=>{
      state.recorder=new AudioWorkletNode(this,'destination-recorder',{numberOfInputs:1,numberOfOutputs:0,channelCount:2,channelCountMode:'explicit'});
      state.recorder.onprocessorerror=()=>{state.error='Destination recorder failed';};
      state.recorder.port.onmessage=event=>{
        if(!state.recording)return;
        const upload=fetch('/recording',{method:'POST',headers:{'X-Audio-Sequence':String(state.sequence++)},body:event.data.buffer}).then(response=>{if(!response.ok)throw new Error('Recording upload failed');}).catch(error=>{state.error=String(error);}).finally(()=>state.pending.delete(upload));
        state.pending.add(upload);
      };
      for(const source of state.sources)Reflect.apply(nativeConnect,source,[state.recorder]);
    });
  }
};
AudioNode.prototype.connect=function(destination,...args){
  const result=Reflect.apply(nativeConnect,this,[destination,...args]),state=this.context.captureState;
  if(state&&destination===this.context.destination){state.sources.add(this);if(state.recorder)Reflect.apply(nativeConnect,this,[state.recorder]);}
  return result;
};
AudioNode.prototype.disconnect=function(...args){
  const result=Reflect.apply(nativeDisconnect,this,args),state=this.context.captureState;
  if(state&&(!args.length||args[0]===this.context.destination)){
    state.sources.delete(this);
    if(args.length&&state.recorder)Reflect.apply(nativeDisconnect,this,[state.recorder]);
  }
  return result;
};
window.startAudioCapture=async()=>{await window.captureState.ready;window.captureState.recording=true;return window.captureState.context.sampleRate;};
window.stopAudioCapture=async()=>{const state=window.captureState;state.recording=false;await Promise.all([...state.pending]);if(state.error)throw new Error(state.error);};`;
