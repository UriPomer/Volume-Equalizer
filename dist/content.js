(function(){var G="[Universal Volume EQ]",q="universal-volume-eq-panel",z="universalVolumeEqAttached",ne="video, audio",A={enabled:!0,targetRms:.1363,minGain:.5,maxGain:2,compressorThreshold:-20,compressorKnee:20,compressorRatio:3,compressorAttack:.003,compressorRelease:.3,bassBoost:0,gainChangePerSec:.2},B={minIntegrationSeconds:1,coldStartSeconds:3,silenceThreshold:.001},re=3e4,U=new Map;function $(e){const t=Date.now();return t-(U.get(e)||0)<re?!1:(U.set(e,t),!0)}function m(e,t,s){$(`warn:${e}`)&&(s!==void 0?console.warn(`${G} ${t}`,s):console.warn(`${G} ${t}`))}function oe(e,t,s){$(`error:${e}`)&&(s!==void 0?console.error(`${G} ${t}`,s):console.error(`${G} ${t}`))}var W=window.AudioContext||window.webkitAudioContext,k=null;function H(){return k||(k=new W),k}function le(){const e=()=>{try{k&&k.state==="suspended"&&k.resume().catch(t=>{m("audio-context-resume","AudioContext resume failed",t)})}catch(t){m("audio-context-resume-handler","AudioContext resume handler failed",t)}};["pointerdown","keydown","click","touchstart"].forEach(t=>{document.addEventListener(t,e,{capture:!0,passive:!0})}),document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&e()})}function he(){return!!W}var V=typeof chrome<"u"&&!!chrome?.storage?.local;function ce(){return V?new Promise(e=>{chrome.storage.local.get(A,t=>{e(t||{...A})})}):Promise.resolve({...A})}function de(e){V&&chrome.storage.local.set(e)}function v(e){return e<=1e-5?-70:20*Math.log10(e)-.691}function ue(e){return Math.pow(10,(e+.691)/20)}function fe(e,t,s){return Math.min(Math.max(e,t),s)}var me=class{constructor(){this.listeners=new Map}on(e,t){return this.listeners.has(e)||this.listeners.set(e,new Set),this.listeners.get(e).add(t),()=>this.off(e,t)}once(e,t){const s=this.on(e,i=>{s(),t(i)});return s}off(e,t){const s=this.listeners.get(e);s&&(s.delete(t),s.size===0&&this.listeners.delete(e))}emit(e,t){const s=this.listeners.get(e);s&&[...s].forEach(i=>{try{i(t)}catch{}})}},C=new me,E={SETTINGS_CHANGED:"settings:changed",MEDIA_PLAY:"media:play",MEDIA_PAUSE:"media:pause",MEDIA_SEEKED:"media:seeked",MEDIA_EMPTIED:"media:emptied"},K=class{constructor(e,t,s,i,a){this.x1=0,this.x2=0,this.y1=0,this.y2=0,this.b0=0,this.b1=0,this.b2=0,this.a1=0,this.a2=0,this.type=e,this.fc=t,this.Q=s,this.gain=i,this.sampleRate=a,this.calculateCoefficients()}calculateCoefficients(){const e=Math.tan(Math.PI*this.fc/this.sampleRate);if(this.type==="high_shelf"){const t=Math.pow(10,this.gain/20),s=Math.pow(t,.499666774155),i=1+e/this.Q+e*e;this.b0=(t+s*e/this.Q+e*e)/i,this.b1=2*(e*e-t)/i,this.b2=(t-s*e/this.Q+e*e)/i,this.a1=2*(e*e-1)/i,this.a2=(1-e/this.Q+e*e)/i}else if(this.type==="high_pass"){const t=1+e/this.Q+e*e;this.b0=1/t,this.b1=-2/t,this.b2=1/t,this.a1=2*(e*e-1)/t,this.a2=(1-e/this.Q+e*e)/t}}processSample(e){const t=this.b0*e+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;return this.x2=this.x1,this.x1=e,this.y2=this.y1,this.y1=t,t}processBlock(e){const t=new Float32Array(e.length);for(let s=0;s<e.length;s++)t[s]=this.processSample(e[s]);return t}reset(){this.x1=this.x2=this.y1=this.y2=0}},I=class{constructor(e=48e3){this.blockSize=.4,this.overlap=.75,this.absoluteThreshold=-70,this.relativeThreshold=-10,this.blocks=[],this.blockLoudness=[],this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.sampleRate=e,this.channelFilters=[this.createChannelFilters(e)],this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffers=[new Float32Array(this.samplesPerBlock)],this.maxBlocks=Math.ceil(600/(this.blockSize*(1-this.overlap)))}applyKWeighting(e,t){const s=this.channelFilters[t];let i=s.highShelf.processSample(e);return i=s.highPass.processSample(i),i}processBlock(e){this.processChannels([e])}processChannels(e){const t=Math.max(1,e.length);this.ensureChannelCount(t);const s=e.reduce((i,a)=>Math.max(i,a.length),0);for(let i=0;i<s;i++){for(let a=0;a<t;a++){const n=e[a]?.[i]??0;this.blockBuffers[a][this.blockBufferIndex]=this.applyKWeighting(n,a)}if(this.blockBufferIndex++,this.samplesSinceLastBlock++,this.blockBufferIndex>=this.samplesPerBlock){const a=this.calculateWeightedMeanSquare(this.blockBuffers,this.samplesPerBlock),n=-.691+10*Math.log10(a);if(n>=this.absoluteThreshold&&(this.blocks.push(a),this.blockLoudness.push(n),this.blocks.length>this.maxBlocks&&(this.blocks.shift(),this.blockLoudness.shift())),this.samplesSinceLastBlock>=this.stepSamples){for(let r=0;r<this.blockBuffers.length;r++)this.blockBuffers[r].copyWithin(0,this.stepSamples);this.blockBufferIndex=this.samplesPerBlock-this.stepSamples,this.samplesSinceLastBlock=0}}}}calculateMeanSquare(e,t=e.length){let s=0;for(let i=0;i<t;i++)s+=e[i]*e[i];return s/t}calculateWeightedMeanSquare(e,t){let s=0;for(let i=0;i<e.length;i++)s+=this.channelWeight(i)*this.calculateMeanSquare(e[i],t);return s}channelWeight(e){return e<=1?1:Math.pow(10,1.5/10)}getIntegratedLoudness(){if(this.blocks.length===0)return NaN;const e=this.blocks.reduce((n,r)=>n+r,0)/this.blocks.length,t=-.691+10*Math.log10(e)+this.relativeThreshold;let s=0,i=0;for(let n=0;n<this.blocks.length;n++){const r=this.blockLoudness[n];r>=this.absoluteThreshold&&r>=t&&(s+=this.blocks[n],i++)}if(i===0)return NaN;const a=s/i;return-.691+10*Math.log10(a)}getMomentaryLoudness(){if(this.blockBufferIndex<this.samplesPerBlock*.5)return NaN;let e=0;for(let s=0;s<this.blockBuffers.length;s++)e+=this.channelWeight(s)*this.calculateMeanSquare(this.blockBuffers[s],this.blockBufferIndex);const t=e;return t<=0?-1/0:-.691+10*Math.log10(t)}getShortTermLoudness(){const e=Math.ceil(3/(this.blockSize*(1-this.overlap)));if(this.blocks.length<e)return this.getIntegratedLoudness();const t=this.blocks.slice(-e),s=t.reduce((i,a)=>i+a,0)/t.length;return s<=0?-1/0:-.691+10*Math.log10(s)}getIntegrationTime(){return this.blocks.length*this.blockSize*(1-this.overlap)}reset(){this.blocks=[],this.blockLoudness=[],this.blockBuffers.forEach(e=>e.fill(0)),this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.channelFilters.forEach(e=>{e.highShelf.reset(),e.highPass.reset()})}setSampleRate(e){this.sampleRate!==e&&(this.sampleRate=e,this.channelFilters=this.channelFilters.map(()=>this.createChannelFilters(e)),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffers=this.blockBuffers.map(()=>new Float32Array(this.samplesPerBlock)),this.reset())}createChannelFilters(e){return{highShelf:new K("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),highPass:new K("high_pass",38.13547087613982,.5003270373253953,0,e)}}ensureChannelCount(e){for(;this.channelFilters.length<e;)this.channelFilters.push(this.createChannelFilters(this.sampleRate)),this.blockBuffers.push(new Float32Array(this.samplesPerBlock))}};function pe(e,t){if(!isFinite(e)||!isFinite(t))return 1;const s=t-e;return Math.pow(10,s/20)}var ge=18,be=10,_=.1,xe=.35,Q=1.3,Se=.8912509381337456,j=-62,ve=-80,Le=-30,Y=10,ye=6,ke=28,Ce=34,Ee=.04,Me=.025,Ae=.8;function Fe(e){return e.integrationTime<e.minIntegrationSeconds?isFinite(e.momentaryLufs)?e.momentaryLufs:NaN:isFinite(e.integratedLufs)?e.integratedLufs:isFinite(e.shortTermLufs)?e.shortTermLufs:isFinite(e.momentaryLufs)?e.momentaryLufs:NaN}function X(e,t){if(!isFinite(e)||!isFinite(t))return 0;const s=t-e;return s>ge?_:s>be?xe:1}var we=class{constructor(){this.gateOpen=!1,this.noiseFloorLufs=j,this.closeHoldSec=0}reset(){this.gateOpen=!1,this.noiseFloorLufs=j,this.closeHoldSec=0}update(e){this.updateGate(e);const t=X(e.controlLufs,e.targetLufs),s=this.computePeakLimitedMaxGain(e),i=e.integrationTime<e.coldStartSeconds,a=isFinite(e.desiredGain??NaN)?e.desiredGain:Ge(e.controlLufs,e.targetLufs),n=this.computeDesiredGain(e,a,s,i,t),r=Math.min(Math.max(e.currentGain,e.minGain),e.maxGain);if(!this.gateOpen&&n>r)return{nextGain:r,gateOpen:this.gateOpen,state:"noise-hold",peakLimitedGain:s,riseScale:t};const l=this.slewLimitGain(e,r,n,t);return{nextGain:l,gateOpen:this.gateOpen,state:this.classifyState(i,l,r),peakLimitedGain:s,riseScale:t}}updateGate(e){const t=[e.momentaryLufs,e.shortTermLufs,e.controlLufs].filter(n=>isFinite(n)),s=t.length>0?Math.max(...t):NaN;if(!isFinite(s)){this.gateOpen=!1,this.closeHoldSec=0;return}this.updateNoiseFloor(s,e.deltaSec);const i=Math.max(this.noiseFloorLufs+Y,e.targetLufs-ke),a=Math.max(this.noiseFloorLufs+ye,e.targetLufs-Ce);if(!this.gateOpen){this.gateOpen=s>=i||e.sourcePeak>=Ee,this.closeHoldSec=0;return}s<=a&&e.sourcePeak<=Me?(this.closeHoldSec+=Math.max(0,e.deltaSec),this.closeHoldSec>=Ae&&(this.gateOpen=!1)):this.closeHoldSec=0}updateNoiseFloor(e,t){if(this.gateOpen&&e>this.noiseFloorLufs+Y)return;const s=Math.min(Math.max(e,ve),Le),i=s>this.noiseFloorLufs?8:2,a=1-Math.exp(-Math.max(0,t)/i);this.noiseFloorLufs+=(s-this.noiseFloorLufs)*a}computePeakLimitedMaxGain(e){let t=e.maxGain;return X(e.controlLufs,e.targetLufs)===_&&(t=Math.min(t,Q)),e.integrationTime<e.coldStartSeconds&&(t=Math.min(t,1)),isFinite(e.sourcePeak)&&e.sourcePeak>0&&(t=Math.min(t,Se/e.sourcePeak)),t}computeDesiredGain(e,t,s,i,a){let n=s;return a===_&&(n=Math.min(n,Q)),i&&(n=Math.min(n,1)),Math.min(Math.max(t,e.minGain),n)}slewLimitGain(e,t,s,i){const a=Math.max(0,e.gainChangePerSec*e.deltaSec);return s>t?Math.min(s,t+a*i):Math.max(s,t-a*3)}classifyState(e,t,s){return e?"cold-start":t<s?"attenuate":t>s?"boost":"hold"}};function Ge(e,t){return!isFinite(e)||!isFinite(t)?1:Math.pow(10,(t-e)/20)}var T=null;function Ie(e,t){return T||(T=e.audioWorklet.addModule(t).catch(s=>{throw T=null,s})),T}var Te=class{constructor(e,t,s){this.rafId=0,this.processingEnabled=null,this.lastTickTime=performance.now(),this.agc=new we,this.originalChannelAnalysers=[],this.originalChannelBuffers=[],this.outputChannelAnalysers=[],this.outputChannelBuffers=[],this.workletLimiter=null,this.destroyed=!1,this.media=e,this.settings=t,this.meterStateCallback=s,this.originalMeter=new I(48e3),this.outputMeter=new I(48e3),this.initAudioNodes(),this.bindEventListeners(),this.tick=this.tick.bind(this),this.rafId=requestAnimationFrame(this.tick)}initAudioNodes(){const e=H();this.audioContext=e,this.sourceNode=e.createMediaElementSource(this.media),this.compressor=e.createDynamicsCompressor(),this.gainNode=e.createGain(),this.originalAnalyser=e.createAnalyser(),this.originalAnalyser.fftSize=2048,this.originalBuffer=new Float32Array(this.originalAnalyser.fftSize),this.originalSplitter=e.createChannelSplitter(2),this.originalChannelAnalysers=this.createChannelAnalysers(e),this.originalChannelBuffers=this.originalChannelAnalysers.map(t=>new Float32Array(t.fftSize)),this.analyser=e.createAnalyser(),this.analyser.fftSize=2048,this.buffer=new Float32Array(this.analyser.fftSize),this.outputSplitter=e.createChannelSplitter(2),this.outputChannelAnalysers=this.createChannelAnalysers(e),this.outputChannelBuffers=this.outputChannelAnalysers.map(t=>new Float32Array(t.fftSize)),this.bassFilter=e.createBiquadFilter(),this.bassFilter.type="lowshelf",this.bassFilter.frequency.value=200,this.bassFilter.gain.value=this.settings.bassBoost,this.fallbackLimiter=e.createDynamicsCompressor(),this.applyLimiter(),this.initLookaheadLimiter(),this.originalMeter=new I(e.sampleRate),this.outputMeter=new I(e.sampleRate),this.applyCompressor(),this.setProcessingEnabled(this.settings.enabled)}bindEventListeners(){this.handleEmptied=()=>{C.emit(E.MEDIA_EMPTIED,{media:this.media}),this.resetGain()},this.handleSeeked=()=>{C.emit(E.MEDIA_SEEKED,{media:this.media}),this.resetIntegration()},this.handlePlay=()=>{C.emit(E.MEDIA_PLAY,{media:this.media});try{const e=H();e.state==="suspended"&&e.resume().catch(t=>{m("media-play-resume","AudioContext play resume failed",t)})}catch(e){m("media-play-handler","Media play handler failed",e)}},this.handlePause=()=>{C.emit(E.MEDIA_PAUSE,{media:this.media})},this.media.addEventListener("emptied",this.handleEmptied),this.media.addEventListener("seeked",this.handleSeeked),this.media.addEventListener("play",this.handlePlay),this.media.addEventListener("pause",this.handlePause),this.handleVisibilityChange=()=>{this.freezeGain(),this.resetIntegration(),this.lastTickTime=performance.now()},document.addEventListener("visibilitychange",this.handleVisibilityChange)}applyCompressor(){this.compressor.threshold.value=this.settings.compressorThreshold,this.compressor.knee.value=this.settings.compressorKnee,this.compressor.ratio.value=this.settings.compressorRatio,this.compressor.attack.value=this.settings.compressorAttack,this.compressor.release.value=this.settings.compressorRelease}applyLimiter(){this.fallbackLimiter.threshold.value=-1,this.fallbackLimiter.knee.value=0,this.fallbackLimiter.ratio.value=20,this.fallbackLimiter.attack.value=.001,this.fallbackLimiter.release.value=.05}initLookaheadLimiter(){const e=this.getExtensionUrl("limiter-worklet.js");!e||!this.audioContext.audioWorklet||typeof AudioWorkletNode>"u"||Ie(this.audioContext,e).then(()=>{if(this.destroyed)return;const t=new AudioWorkletNode(this.audioContext,"lookahead-peak-limiter",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{lookaheadMs:15,releaseMs:50,ceiling:.8912509381337456,interSampleMargin:1.03}});t.onprocessorerror=s=>{m("lookahead-limiter-processor","Lookahead limiter processor failed",s)},this.workletLimiter=t,this.reconnectCurrentChain()}).catch(t=>{m("lookahead-limiter-load","Lookahead limiter load failed; using compressor fallback",t)})}getExtensionUrl(e){try{if(typeof chrome<"u"&&chrome.runtime?.getURL)return chrome.runtime.getURL(e)}catch(t){m("extension-url","Failed to resolve extension asset URL",t)}return null}setProcessingEnabled(e){this.processingEnabled!==e&&(this.processingEnabled=e,e?this.connectProcessingChain():(this.connectBypassChain(),this.gainNode.gain.value=1))}disconnectNodes(){this.safeDisconnect(this.sourceNode),this.safeDisconnect(this.compressor),this.safeDisconnect(this.originalAnalyser),this.safeDisconnect(this.originalSplitter),this.originalChannelAnalysers.forEach(e=>this.safeDisconnect(e)),this.safeDisconnect(this.gainNode),this.safeDisconnect(this.bassFilter),this.safeDisconnect(this.fallbackLimiter),this.workletLimiter&&this.safeDisconnect(this.workletLimiter),this.safeDisconnect(this.analyser),this.safeDisconnect(this.outputSplitter),this.outputChannelAnalysers.forEach(e=>this.safeDisconnect(e))}safeDisconnect(e){try{e.disconnect()}catch{}}reconnectCurrentChain(){this.processingEnabled?this.connectProcessingChain():this.connectBypassChain()}connectProcessingChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.compressor),this.originalAnalyser.connect(this.originalSplitter),this.connectSplitter(this.originalSplitter,this.originalChannelAnalysers),this.compressor.connect(this.gainNode),this.gainNode.connect(this.bassFilter);const e=this.workletLimiter??this.fallbackLimiter;this.bassFilter.connect(e),e.connect(this.analyser),this.analyser.connect(this.outputSplitter),this.connectSplitter(this.outputSplitter,this.outputChannelAnalysers),this.analyser.connect(this.audioContext.destination)}connectBypassChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.originalSplitter),this.connectSplitter(this.originalSplitter,this.originalChannelAnalysers),this.originalAnalyser.connect(this.analyser),this.analyser.connect(this.outputSplitter),this.connectSplitter(this.outputSplitter,this.outputChannelAnalysers),this.analyser.connect(this.audioContext.destination)}createChannelAnalysers(e){return[e.createAnalyser(),e.createAnalyser()].map(t=>(t.fftSize=2048,t))}connectSplitter(e,t){for(let s=0;s<t.length;s++)e.connect(t[s],s)}updateSettings(e){const{_changedField:t,...s}=e,i=t==="targetLufs",a=this.settings.enabled;this.settings=s,this.applyCompressor(),this.bassFilter.gain.value=s.bassBoost,a!==s.enabled&&this.setProcessingEnabled(s.enabled),i&&this.resetOutputIntegration()}resetGain(){this.setGainImmediate(1),this.resetIntegration()}resetIntegration(){this.originalMeter.reset(),this.outputMeter.reset(),this.agc.reset()}setGainImmediate(e){const t=fe(e,this.settings.minGain,this.settings.maxGain);this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime),this.gainNode.gain.setValueAtTime(t,this.audioContext.currentTime),this.gainNode.gain.value=t}freezeGain(){this.setGainImmediate(this.gainNode.gain.value)}resetOutputIntegration(){this.outputMeter.reset();const e=this.measureRms(),t=this.measureOriginalRms();this.updateMeterState(e,t,this.gainNode.gain.value)}measureRms(){this.analyser.getFloatTimeDomainData(this.buffer);let e=0;for(let t=0;t<this.buffer.length;t++){const s=this.buffer[t];e+=s*s}return Math.sqrt(e/this.buffer.length)}measureOriginalRms(){this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);let e=0;for(let t=0;t<this.originalBuffer.length;t++){const s=this.originalBuffer[t];e+=s*s}return Math.sqrt(e/this.originalBuffer.length)}measureOriginalPeak(){let e=0;for(let t=0;t<this.originalChannelBuffers.length;t++){const s=this.originalChannelBuffers[t];for(let i=0;i<s.length;i++){const a=Math.abs(s[i]);a>e&&(e=a)}}return e}updateLoudnessMeasurement(){const e=B.silenceThreshold;let t=!1,s=!1;for(const i of this.originalChannelBuffers){for(let a=0;a<i.length;a++)if(Math.abs(i[a])>e){t=!0;break}if(t)break}for(const i of this.outputChannelBuffers){for(let a=0;a<i.length;a++)if(Math.abs(i[a])>e){s=!0;break}if(s)break}t&&this.originalMeter.processChannels(this.originalChannelBuffers),s&&this.outputMeter.processChannels(this.outputChannelBuffers)}tick(){if(!document.contains(this.media)){this.destroy();return}if(document.hidden){this.freezeGain(),this.lastTickTime=performance.now(),this.rafId=requestAnimationFrame(this.tick);return}const e=performance.now(),t=Math.max(.001,Math.min((e-this.lastTickTime)/1e3,.25));this.lastTickTime=e,this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer),this.analyser.getFloatTimeDomainData(this.buffer),this.readChannelData(this.originalChannelAnalysers,this.originalChannelBuffers),this.readChannelData(this.outputChannelAnalysers,this.outputChannelBuffers);const s=this.measureRms(),i=this.measureOriginalRms(),a=this.measureOriginalPeak();if(this.updateLoudnessMeasurement(),this.settings.enabled&&!this.media.muted&&!this.media.paused&&!this.media.ended){const n=this.originalMeter.getIntegratedLoudness(),r=this.outputMeter.getIntegratedLoudness(),l=this.originalMeter.getIntegrationTime(),c=this.originalMeter.getMomentaryLoudness(),b=this.originalMeter.getShortTermLoudness(),u=Fe({integratedLufs:n,shortTermLufs:b,momentaryLufs:c,integrationTime:l,minIntegrationSeconds:B.minIntegrationSeconds});if(isFinite(u)){const p=v(this.settings.targetRms),f=pe(u,p),M=this.agc.update({currentGain:this.gainNode.gain.value,desiredGain:f,minGain:this.settings.minGain,maxGain:this.settings.maxGain,deltaSec:t,controlLufs:u,targetLufs:p,integrationTime:l,coldStartSeconds:B.coldStartSeconds,sourcePeak:a,momentaryLufs:c,shortTermLufs:b,gainChangePerSec:this.settings.gainChangePerSec}).nextGain;this.setGainImmediate(M);const R=isFinite(n)?n:u;this.updateMeterState(s,i,M,R,r)}else this.updateMeterState(s,i,this.gainNode.gain.value)}else this.settings.enabled?this.updateMeterState(s,i,this.gainNode.gain.value):(this.setGainImmediate(1),this.updateMeterState(i,i,1,null,null,!0));this.rafId=requestAnimationFrame(this.tick)}readChannelData(e,t){for(let s=0;s<e.length;s++)e[s].getFloatTimeDomainData(t[s])}updateMeterState(e,t,s,i=null,a=null,n=!1){i===null&&(i=this.originalMeter.getIntegratedLoudness()),a===null&&(a=this.outputMeter.getIntegratedLoudness());const r=isFinite(a)?Math.pow(10,(a+.691)/20):e,l=isFinite(i)?Math.pow(10,(i+.691)/20):t;this.meterStateCallback({rms:n?t:e,integratedRms:n?l:r,originalRms:t,originalIntegratedRms:l,gain:s,sampleCount:Math.floor(this.originalMeter.getIntegrationTime()),originalLufs:i,outputLufs:a,integrationTime:this.originalMeter.getIntegrationTime()})}destroy(){this.destroyed=!0,cancelAnimationFrame(this.rafId),this.media.removeEventListener("emptied",this.handleEmptied),this.media.removeEventListener("seeked",this.handleSeeked),this.media.removeEventListener("play",this.handlePlay),this.media.removeEventListener("pause",this.handlePause),document.removeEventListener("visibilitychange",this.handleVisibilityChange),this.disconnectNodes(),delete this.media.dataset[z]}},N=!1,O=new WeakMap,Be=5e3;function _e(e,t){document.querySelectorAll(ne).forEach(s=>{Ne(s,e)}),t&&t()}function Ne(e,t){if(!(e instanceof HTMLMediaElement)||e.dataset.universalVolumeEqAttached==="1")return;const s=O.get(e)||0;if(!(Date.now()<s))try{t(e),e.dataset[z]="1",O.delete(e)}catch(i){O.set(e,Date.now()+Be),m("media-attach","无法绑定媒体元素，将稍后重试",i)}}function Oe(e){N||(N=!0,requestAnimationFrame(()=>{N=!1,e()}))}function Pe(e){new MutationObserver(()=>Oe(e)).observe(document.documentElement,{childList:!0,subtree:!0})}var o=null,P=null;function De(e,t,s){if(o&&document.contains(o))return o;const i=document.getElementById(q);if(i)return o=i,o;const a=document.createElement("div");a.id=q,a.style.cssText=`
    position: fixed;
    right: 0;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `,document.documentElement.appendChild(a),o=a;const n=a.attachShadow({mode:"open"}),r=document.createElement("style");r.textContent=Re(),n.appendChild(r);const l=document.createElement("div");return l.innerHTML=qe(e),n.appendChild(l.firstElementChild),ze(n,e,t),Ue(n,s),a}function J(e,t,s){return o&&document.contains(o)?o:(o=null,De(e,t,s))}function Z(e){if(e===0){o&&document.contains(o)&&(o.style.display="none");return}o&&(o.style.display="block")}function Re(){return`
    :host {
      all: initial;
      pointer-events: none;
    }

    /* ── 整体容器：用 transform 控制滑出 ── */
    .panel-wrapper {
      display: flex;
      align-items: flex-end;
      pointer-events: none;
      transform: translateX(220px);
      transition: transform 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    }
    :host([data-expanded]) .panel-wrapper {
      transform: translateX(0);
    }

    /* ── 卡片 ── */
    .panel {
      width: 220px;
      box-sizing: border-box;
      flex-shrink: 0;
      background: rgba(12, 12, 14, 0.35);
      color: #f0f0f0;
      border-radius: 14px 0 0 14px;
      padding: 12px 12px 10px;
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-right: none;
      backdrop-filter: blur(20px) saturate(180%);
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.2s ease 0.05s, border-radius 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    }
    :host([data-expanded]) .panel {
      opacity: 1;
      border-radius: 14px 0 0 0;
    }

    /* ── Dock 把手 ── */
    .dock {
      flex-shrink: 0;
      width: 26px;
      height: 72px;
      background: linear-gradient(160deg, rgba(0, 178, 255, 0.30), rgba(0, 122, 180, 0.30));
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-right: none;
      color: #fff;
      border-radius: 10px 0 0 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.3);
      cursor: pointer;
      pointer-events: auto;
      transition: border-radius 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94),
                  box-shadow 0.2s ease;
    }
    .dock:hover {
      box-shadow: -3px 0 10px rgba(0, 0, 0, 0.45);
    }
    :host([data-expanded]) .dock {
      box-shadow: none;
    }
    .dock-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      user-select: none;
    }
    .dock-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 6px #4ade80;
      transition: background 0.3s, box-shadow 0.3s;
    }
    .dock-dot.off {
      background: rgba(255,255,255,0.3);
      box-shadow: none;
    }

    /* ── 标题行 ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .header-title {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      letter-spacing: 0.3px;
    }
    .toggle-pill {
      border: none;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, box-shadow 0.2s;
      letter-spacing: 0.3px;
    }
    .toggle-pill.on {
      background: linear-gradient(90deg, #0ea5e9, #0284c7);
      color: #fff;
      box-shadow: 0 2px 8px rgba(14, 165, 233, 0.4);
    }
    .toggle-pill.off {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5);
    }

    /* ── 分割线 ── */
    .divider {
      height: 1px;
      background: rgba(255,255,255,0.07);
      margin: 8px 0;
    }

    /* ── 参数行 ── */
    .param-row {
      margin-top: 8px;
    }
    .param-label {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      margin-bottom: 4px;
    }
    .param-label span:last-child {
      font-size: 12px;
      font-weight: 600;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    input[type='range'] {
      -webkit-appearance: none;
      width: 100%;
      height: 3px;
      border-radius: 2px;
      background: rgba(255,255,255,0.12);
      outline: none;
      cursor: pointer;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56,189,248,0.3);
      transition: box-shadow 0.15s;
    }
    input[type='range']:hover::-webkit-slider-thumb {
      box-shadow: 0 0 0 4px rgba(56,189,248,0.3);
    }

    /* ── Meter 区域 ── */
    .meter {
      margin-top: 2px;
      font-size: 11px;
    }
    .meter-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-variant-numeric: tabular-nums;
    }
    .meter-row .label {
      color: rgba(255,255,255,0.35);
    }
    .meter-row .val {
      color: #cbd5e1;
      font-weight: 500;
    }
    .meter-row .val.highlight {
      color: #38bdf8;
    }
    .meter-sub-title {
      font-size: 10px;
      font-weight: 600;
      color: rgba(255,255,255,0.3);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-top: 6px;
      margin-bottom: 2px;
    }
  `}function qe(e){const t=v(e.targetRms).toFixed(1),s=e.bassBoost>0?"+":"";return`
    <div class="panel-wrapper">
      <div class="dock">
        <div class="dock-dot off"></div>
        <div class="dock-label">EQ</div>
      </div>
      <div class="panel">
        <div class="header">
          <span class="header-title">音量均衡</span>
          <button class="toggle-pill">···</button>
        </div>
        <div class="divider"></div>

        <div class="param-row">
          <div class="param-label">
            <span>目标响度</span>
            <span data-field="targetLufs">${t} LUFS</span>
          </div>
          <input type="range" min="-23" max="-10" step="0.5" data-role="targetLufs" value="${t}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>增益上限</span>
            <span data-field="maxGain">${e.maxGain.toFixed(1)}x</span>
          </div>
          <input type="range" min="1" max="3" step="0.1" data-role="maxGain" value="${e.maxGain}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>增益下限</span>
            <span data-field="minGain">${e.minGain.toFixed(1)}x</span>
          </div>
          <input type="range" min="0.2" max="1" step="0.05" data-role="minGain" value="${e.minGain}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>低频增益</span>
            <span data-field="bassBoost">${s}${e.bassBoost.toFixed(1)} dB</span>
          </div>
          <input type="range" min="-6" max="6" step="0.5" data-role="bassBoost" value="${e.bassBoost}">
        </div>

        <div class="divider" style="margin-top:10px;"></div>
        <div class="meter">
          <div class="meter-sub-title">原始</div>
          <div class="meter-row">
            <span class="label">积分</span>
            <span class="val"><span data-field="meterOriginalIntegratedLufs">-∞</span> LUFS <span style="opacity:0.5;font-size:10px;" data-field="sampleCount"></span></span>
          </div>
          <div class="meter-row">
            <span class="label">瞬时</span>
            <span class="val"><span data-field="meterOriginalLufs">-∞</span> LUFS</span>
          </div>

          <div class="meter-sub-title" style="margin-top:6px;">输出</div>
          <div class="meter-row">
            <span class="label">积分</span>
            <span class="val"><span data-field="meterIntegratedLufs">-∞</span> LUFS</span>
          </div>
          <div class="meter-row">
            <span class="label">瞬时</span>
            <span class="val"><span data-field="meterLufs">-∞</span> LUFS</span>
          </div>
          <div class="meter-row">
            <span class="label">增益</span>
            <span class="val highlight"><span data-field="meterGain">1.00x</span></span>
          </div>
        </div>
      </div>
    </div>
  `}function ze(e,t,s){const i=e.querySelector("button.toggle-pill"),a=e.querySelector(".dock-dot"),n=e.querySelectorAll('input[type="range"]'),r=ee(e),l=new Map([...n].map(h=>[h.dataset.role,h]));let c=t;const b=()=>{c.enabled?(i.textContent="已开启",i.className="toggle-pill on",a.className="dock-dot"):(i.textContent="已关闭",i.className="toggle-pill off",a.className="dock-dot off")},u=h=>{const x=v(h.targetRms),w=l.get("targetLufs");w&&(w.value=String(x)),F(r,"targetLufs",x);const L=l.get("maxGain");L&&(L.value=String(h.maxGain)),F(r,"maxGain",h.maxGain);const y=l.get("minGain");y&&(y.value=String(h.minGain)),F(r,"minGain",h.minGain);const S=l.get("bassBoost");S&&(S.value=String(h.bassBoost)),F(r,"bassBoost",h.bassBoost),b()};u(c),i.addEventListener("click",()=>{const h={...c,enabled:!c.enabled};c=s(h)||h,b(),i.blur()}),n.forEach(h=>{h.addEventListener("input",x=>{const w=x.target,L=w.dataset.role,y=parseFloat(w.value);if(Number.isNaN(y))return;const S={...c};S._changedField=L,L==="targetLufs"?S.targetRms=ue(y):S[L]=y,c=s(S)||S,F(r,L,y)}),h.addEventListener("change",x=>{x.target.blur()})});let p=null,f=null;const M=o,R=e.querySelector(".dock"),ae=e.querySelector(".panel-wrapper"),He=()=>{clearTimeout(f),f=null,M.hasAttribute("data-expanded")||(p=setTimeout(()=>{M.setAttribute("data-expanded","")},80))},Ve=()=>{clearTimeout(p),p=null,f=setTimeout(()=>{M.removeAttribute("data-expanded")},300)};R.addEventListener("mouseenter",He),ae.addEventListener("mouseleave",Ve),ae.addEventListener("mouseenter",()=>{clearTimeout(f),f=null}),P&&P(),P=C.on(E.SETTINGS_CHANGED,h=>{const{settings:x}=h;!o||!document.contains(o)||(c=x,u(c))})}function ee(e){return{targetLufs:e.querySelector('[data-field="targetLufs"]'),maxGain:e.querySelector('[data-field="maxGain"]'),minGain:e.querySelector('[data-field="minGain"]'),bassBoost:e.querySelector('[data-field="bassBoost"]'),meterOriginalIntegratedLufs:e.querySelector('[data-field="meterOriginalIntegratedLufs"]'),meterOriginalLufs:e.querySelector('[data-field="meterOriginalLufs"]'),meterIntegratedLufs:e.querySelector('[data-field="meterIntegratedLufs"]'),meterLufs:e.querySelector('[data-field="meterLufs"]'),meterGain:e.querySelector('[data-field="meterGain"]'),sampleCount:e.querySelector('[data-field="sampleCount"]')}}function F(e,t,s){t==="targetLufs"&&e.targetLufs&&(e.targetLufs.textContent=`${s.toFixed(1)} LUFS`),t==="maxGain"&&e.maxGain&&(e.maxGain.textContent=`${s.toFixed(1)}x`),t==="minGain"&&e.minGain&&(e.minGain.textContent=`${s.toFixed(1)}x`),t==="bassBoost"&&e.bassBoost&&(e.bassBoost.textContent=`${s>0?"+":""}${s.toFixed(1)} dB`)}function Ue(e,t){const s=ee(e);setInterval(()=>{if(!document.contains(o))return;const{rms:i,integratedRms:a,originalRms:n,originalIntegratedRms:r,gain:l,sampleCount:c}=t(),b=v(i),u=v(a||i),p=v(n),f=v(r||n);s.meterOriginalLufs&&(s.meterOriginalLufs.textContent=p>-70?p.toFixed(1):"-∞"),s.meterOriginalIntegratedLufs&&(s.meterOriginalIntegratedLufs.textContent=f>-70?f.toFixed(1):"-∞"),s.meterLufs&&(s.meterLufs.textContent=b>-70?b.toFixed(1):"-∞"),s.meterIntegratedLufs&&(s.meterIntegratedLufs.textContent=u>-70?u.toFixed(1):"-∞"),s.meterGain&&(s.meterGain.textContent=`${l.toFixed(2)}x`),s.sampleCount&&(s.sampleCount.textContent=`${c}s`)},100)}if(!he())throw m("audio-context-unsupported","当前浏览器不支持 AudioContext, 扩展已停用"),new Error("AudioContext not supported");var d={...A},D={rms:0,gain:1},g=new Map;le(),ce().then(e=>{d={...A,...e},te()}).catch(e=>{oe("settings-load","设置加载失败，使用默认设置启动",e),te()});function te(){const e=()=>{_e(t=>$e(t),()=>We())};e(),Pe(e)}function $e(e){const t=new Te(e,d,s=>{D=s});g.set(e,t),Z(g.size),J(d,se,ie)}function We(){g.forEach((e,t)=>{t.isConnected||(e.destroy(),g.delete(t))}),Z(g.size)}function se(e){const t=e._changedField||null,s={...e};return delete s._changedField,d=s,de(d),g.forEach(i=>{i.updateSettings({...d,_changedField:t})}),d.enabled||(g.forEach(i=>{i.gainNode.gain.value=1}),D={rms:0,integratedRms:0,originalRms:0,originalIntegratedRms:0,gain:1,sampleCount:0}),C.emit(E.SETTINGS_CHANGED,{settings:d,changedField:t}),d}function ie(){return D}setTimeout(()=>{g.size>0&&J(d,se,ie)},1e3)})();
