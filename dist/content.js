(function(){var O="[Universal Volume EQ]",H="universal-volume-eq-panel",W="universalVolumeEqAttached",de="video, audio",I={enabled:!0,fullAudioAnalysis:!1,targetRms:.09650504109445904,minGain:.25,maxGain:2,compressorThreshold:-20,compressorKnee:20,compressorRatio:3,compressorAttack:.003,compressorRelease:.3,bassBoost:0,gainChangePerSec:.2},D={minIntegrationSeconds:1,coldStartSeconds:10,silenceThreshold:.001},ue=3e4,K=new Map;function Y(e){const t=Date.now();return t-(K.get(e)||0)<ue?!1:(K.set(e,t),!0)}function b(e,t,i){Y(`warn:${e}`)&&(i!==void 0?console.warn(`${O} ${t}`,i):console.warn(`${O} ${t}`))}function fe(e,t,i){Y(`error:${e}`)&&(i!==void 0?console.error(`${O} ${t}`,i):console.error(`${O} ${t}`))}var Q=window.AudioContext||window.webkitAudioContext,C=null;function j(){return C||(C=new Q),C}function me(){const e=()=>{try{C&&C.state==="suspended"&&C.resume().catch(t=>{b("audio-context-resume","AudioContext resume failed",t)})}catch(t){b("audio-context-resume-handler","AudioContext resume handler failed",t)}};["pointerdown","keydown","click","touchstart"].forEach(t=>{document.addEventListener(t,e,{capture:!0,passive:!0})}),document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&e()})}function pe(){return!!Q}var X=typeof chrome<"u"&&!!chrome?.storage?.local;function ge(){if(!X)return Promise.resolve({...I});const e={...I};return new Promise(t=>{chrome.storage.local.get(e,i=>{t(i||{...I})})})}function be(e){X&&chrome.storage.local.set(e)}function v(e){return e<=1e-5?-70:20*Math.log10(e)-.691}function ye(e){return Math.pow(10,(e+.691)/20)}function xe(e,t,i){return Math.min(Math.max(e,t),i)}var Se=class{constructor(){this.listeners=new Map}on(e,t){return this.listeners.has(e)||this.listeners.set(e,new Set),this.listeners.get(e).add(t),()=>this.off(e,t)}once(e,t){const i=this.on(e,s=>{i(),t(s)});return i}off(e,t){const i=this.listeners.get(e);i&&(i.delete(t),i.size===0&&this.listeners.delete(e))}emit(e,t){const i=this.listeners.get(e);i&&[...i].forEach(s=>{try{s(t)}catch{}})}},w=new Se,G={SETTINGS_CHANGED:"settings:changed",MEDIA_PLAY:"media:play",MEDIA_PAUSE:"media:pause",MEDIA_SEEKED:"media:seeked",MEDIA_EMPTIED:"media:emptied"},J=class{constructor(e,t,i,s,a){this.x1=0,this.x2=0,this.y1=0,this.y2=0,this.b0=0,this.b1=0,this.b2=0,this.a1=0,this.a2=0,this.type=e,this.fc=t,this.Q=i,this.gain=s,this.sampleRate=a,this.calculateCoefficients()}calculateCoefficients(){const e=Math.tan(Math.PI*this.fc/this.sampleRate);if(this.type==="high_shelf"){const t=Math.pow(10,this.gain/20),i=Math.pow(t,.499666774155),s=1+e/this.Q+e*e;this.b0=(t+i*e/this.Q+e*e)/s,this.b1=2*(e*e-t)/s,this.b2=(t-i*e/this.Q+e*e)/s,this.a1=2*(e*e-1)/s,this.a2=(1-e/this.Q+e*e)/s}else if(this.type==="high_pass"){const t=1+e/this.Q+e*e;this.b0=1/t,this.b1=-2/t,this.b2=1/t,this.a1=2*(e*e-1)/t,this.a2=(1-e/this.Q+e*e)/t}}processSample(e){const t=this.b0*e+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;return this.x2=this.x1,this.x1=e,this.y2=this.y1,this.y1=t,t}processBlock(e){const t=new Float32Array(e.length);for(let i=0;i<e.length;i++)t[i]=this.processSample(e[i]);return t}reset(){this.x1=this.x2=this.y1=this.y2=0}},T=class{constructor(e=48e3,t=600){this.blockSize=.4,this.overlap=.75,this.absoluteThreshold=-70,this.relativeThreshold=-10,this.blocks=[],this.blockLoudness=[],this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.sampleRate=e,this.channelFilters=[this.createChannelFilters(e)],this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffers=[new Float32Array(this.samplesPerBlock)],this.maxBlocks=Number.isFinite(t)?Math.ceil(t/(this.blockSize*(1-this.overlap))):Number.POSITIVE_INFINITY}applyKWeighting(e,t){const i=this.channelFilters[t];let s=i.highShelf.processSample(e);return s=i.highPass.processSample(s),s}processBlock(e){this.processChannels([e])}processChannels(e){const t=Math.max(1,e.length);this.ensureChannelCount(t);const i=e.reduce((s,a)=>Math.max(s,a.length),0);for(let s=0;s<i;s++){for(let a=0;a<t;a++){const n=e[a]?.[s]??0;this.blockBuffers[a][this.blockBufferIndex]=this.applyKWeighting(n,a)}if(this.blockBufferIndex++,this.samplesSinceLastBlock++,this.blockBufferIndex>=this.samplesPerBlock){const a=this.calculateWeightedMeanSquare(this.blockBuffers,this.samplesPerBlock),n=-.691+10*Math.log10(a);if(n>=this.absoluteThreshold&&(this.blocks.push(a),this.blockLoudness.push(n),this.blocks.length>this.maxBlocks&&(this.blocks.shift(),this.blockLoudness.shift())),this.samplesSinceLastBlock>=this.stepSamples){for(let r=0;r<this.blockBuffers.length;r++)this.blockBuffers[r].copyWithin(0,this.stepSamples);this.blockBufferIndex=this.samplesPerBlock-this.stepSamples,this.samplesSinceLastBlock=0}}}}calculateMeanSquare(e,t=e.length){let i=0;for(let s=0;s<t;s++)i+=e[s]*e[s];return i/t}calculateWeightedMeanSquare(e,t){let i=0;for(let s=0;s<e.length;s++)i+=this.channelWeight(s)*this.calculateMeanSquare(e[s],t);return i}channelWeight(e){return e<=1?1:Math.pow(10,1.5/10)}getIntegratedLoudness(){if(this.blocks.length===0)return NaN;const e=this.blocks.reduce((n,r)=>n+r,0)/this.blocks.length,t=-.691+10*Math.log10(e)+this.relativeThreshold;let i=0,s=0;for(let n=0;n<this.blocks.length;n++){const r=this.blockLoudness[n];r>=this.absoluteThreshold&&r>=t&&(i+=this.blocks[n],s++)}if(s===0)return NaN;const a=i/s;return-.691+10*Math.log10(a)}getMomentaryLoudness(){if(this.blockBufferIndex<this.samplesPerBlock*.5)return NaN;let e=0;for(let i=0;i<this.blockBuffers.length;i++)e+=this.channelWeight(i)*this.calculateMeanSquare(this.blockBuffers[i],this.blockBufferIndex);const t=e;return t<=0?-1/0:-.691+10*Math.log10(t)}getShortTermLoudness(){const e=Math.ceil(3/(this.blockSize*(1-this.overlap)));if(this.blocks.length<e)return this.getIntegratedLoudness();const t=this.blocks.slice(-e),i=t.reduce((s,a)=>s+a,0)/t.length;return i<=0?-1/0:-.691+10*Math.log10(i)}getIntegrationTime(){return this.blocks.length*this.blockSize*(1-this.overlap)}reset(){this.blocks=[],this.blockLoudness=[],this.blockBuffers.forEach(e=>e.fill(0)),this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.channelFilters.forEach(e=>{e.highShelf.reset(),e.highPass.reset()})}setSampleRate(e){this.sampleRate!==e&&(this.sampleRate=e,this.channelFilters=this.channelFilters.map(()=>this.createChannelFilters(e)),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffers=this.blockBuffers.map(()=>new Float32Array(this.samplesPerBlock)),this.reset())}createChannelFilters(e){return{highShelf:new J("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),highPass:new J("high_pass",38.13547087613982,.5003270373253953,0,e)}}ensureChannelCount(e){for(;this.channelFilters.length<e;)this.channelFilters.push(this.createChannelFilters(this.sampleRate)),this.blockBuffers.push(new Float32Array(this.samplesPerBlock))}};function Ae(e,t){if(!isFinite(e)||!isFinite(t))return 1;const i=t-e;return Math.pow(10,i/20)}var ke=18,Le=10,q=.1,ve=.35,Z=1.3,Me=.8912509381337456,ee=-62,Ee=-80,Ce=-30,te=10,we=6,Ge=28,Fe=34,Ie=.04,Te=.025,Ne=.8,_e=2,Be=5,Pe=.2;function Oe(e){return e.integrationTime<e.minIntegrationSeconds?isFinite(e.momentaryLufs)?e.momentaryLufs:NaN:isFinite(e.integratedLufs)?e.integratedLufs:isFinite(e.shortTermLufs)?e.shortTermLufs:isFinite(e.momentaryLufs)?e.momentaryLufs:NaN}function ie(e,t){if(!isFinite(e)||!isFinite(t))return 0;const i=t-e;return i>ke?q:i>Le?ve:1}var Re=class{constructor(){this.gateOpen=!1,this.noiseFloorLufs=ee,this.closeHoldSec=0,this.programmePeakLimitedGain=Number.POSITIVE_INFINITY,this.predictionElapsedSec=0,this.lockedProgramGain=null,this.corridorMinGain=null,this.corridorMaxGain=null}reset(){this.gateOpen=!1,this.noiseFloorLufs=ee,this.closeHoldSec=0,this.programmePeakLimitedGain=Number.POSITIVE_INFINITY,this.predictionElapsedSec=0,this.lockedProgramGain=null,this.corridorMinGain=null,this.corridorMaxGain=null}isLocked(){return this.lockedProgramGain!==null||this.corridorMinGain!==null}lockGain(e){Number.isFinite(e)&&(this.lockedProgramGain=e)}update(e){if(this.lockedProgramGain!==null)return{nextGain:this.lockedProgramGain,gateOpen:this.gateOpen,state:"locked",peakLimitedGain:this.lockedProgramGain,riseScale:0};this.updateGate(e),this.predictionElapsedSec+=Math.max(0,e.deltaSec);const t=ie(e.controlLufs,e.targetLufs),i=this.computePeakLimitedMaxGain(e),s=(Number.isFinite(e.programTimeSeconds)?e.programTimeSeconds:this.predictionElapsedSec)<e.coldStartSeconds,a=isFinite(e.desiredGain??NaN)?e.desiredGain:De(e.controlLufs,e.targetLufs),n=this.computeDesiredGain(e,a,i,t),r=Math.min(Math.max(e.currentGain,e.minGain),e.maxGain);if(!s){if(this.corridorMinGain===null||this.corridorMaxGain===null){const h=Pe/2;this.corridorMinGain=Math.max(e.minGain,n-h),this.corridorMaxGain=Math.min(e.maxGain,n+h)}const l=Math.min(Math.max(n,this.corridorMinGain),this.corridorMaxGain);return{nextGain:Math.min(Math.max(this.slewLimitGain(e,r,l,t),this.corridorMinGain),this.corridorMaxGain),gateOpen:this.gateOpen,state:"bounded",peakLimitedGain:i,riseScale:t}}if(!this.gateOpen&&n>r)return{nextGain:r,gateOpen:this.gateOpen,state:"noise-hold",peakLimitedGain:i,riseScale:t};const o=this.slewLimitGain(e,r,n,t);return{nextGain:o,gateOpen:this.gateOpen,state:this.classifyState(s,o,r),peakLimitedGain:i,riseScale:t}}updateGate(e){const t=[e.momentaryLufs,e.shortTermLufs,e.controlLufs].filter(n=>isFinite(n)),i=t.length>0?Math.max(...t):NaN;if(!isFinite(i)){this.gateOpen=!1,this.closeHoldSec=0;return}this.updateNoiseFloor(i,e.deltaSec);const s=Math.max(this.noiseFloorLufs+te,e.targetLufs-Ge),a=Math.max(this.noiseFloorLufs+we,e.targetLufs-Fe);if(!this.gateOpen){this.gateOpen=i>=s||e.sourcePeak>=Ie,this.closeHoldSec=0;return}i<=a&&e.sourcePeak<=Te?(this.closeHoldSec+=Math.max(0,e.deltaSec),this.closeHoldSec>=Ne&&(this.gateOpen=!1)):this.closeHoldSec=0}updateNoiseFloor(e,t){if(this.gateOpen&&e>this.noiseFloorLufs+te)return;const i=Math.min(Math.max(e,Ee),Ce),s=i>this.noiseFloorLufs?8:2,a=1-Math.exp(-Math.max(0,t)/s);this.noiseFloorLufs+=(i-this.noiseFloorLufs)*a}computePeakLimitedMaxGain(e){let t=e.maxGain;return ie(e.controlLufs,e.targetLufs)===q&&(t=Math.min(t,Z)),isFinite(e.sourcePeak)&&e.sourcePeak>0&&(this.programmePeakLimitedGain=Math.min(this.programmePeakLimitedGain,Me/e.sourcePeak)),t=Math.min(t,this.programmePeakLimitedGain),t}computeDesiredGain(e,t,i,s){let a=i;return s===q&&(a=Math.min(a,Z)),Math.min(Math.max(t,e.minGain),a)}slewLimitGain(e,t,i,s){const a=Math.max(0,e.gainChangePerSec*e.deltaSec);if(i>t){const r=t*Math.pow(10,_e*e.deltaSec/20);return Math.min(i,t+a*s,r)}const n=t*Math.pow(10,-Be*e.deltaSec/20);return Math.max(i,t-a*3,n)}classifyState(e,t,i){return e?"cold-start":t<i?"attenuate":t>i?"boost":"hold"}};function De(e,t){return!isFinite(e)||!isFinite(t)?1:Math.pow(10,(t-e)/20)}var se=48*1024*1024,qe=1,ze=1.03,Ue=.8912509381337456;async function $e(e,t,i){const s=Ye(e);if(!s)throw new Error("No fetchable full audio URL found");const a=new URL(s,location.href).origin,n=await fetch(s,{credentials:a===location.origin?"include":"omit",referrer:location.href,signal:i});if(!n.ok)throw new Error(`Full audio request failed: HTTP ${n.status}`);const r=Number(n.headers.get("content-length"));if(Number.isFinite(r)&&r>se)throw new Error("Full audio exceeds 48 MiB analysis limit");const o=await n.arrayBuffer();if(o.byteLength>se)throw new Error("Full audio exceeds 48 MiB analysis limit");if(i.aborted)throw new DOMException("Aborted","AbortError");const l=await t.decodeAudioData(o);if(i.aborted)throw new DOMException("Aborted","AbortError");const h=new T(l.sampleRate,Number.POSITIVE_INFINITY),f=Array.from({length:l.numberOfChannels},(u,_)=>l.getChannelData(_)),m=Math.max(1,Math.floor(l.sampleRate*qe));let g=0;const p=new He;for(let u=0;u<l.length;u+=m){if(i.aborted)throw new DOMException("Aborted","AbortError");const _=Math.min(l.length,u+m),F=f.map(A=>A.subarray(u,_));for(const A of F)for(let B=0;B<A.length;B++)g=Math.max(g,Math.abs(A[B]));p.processChannels(F),h.processChannels(F),await new Promise(A=>setTimeout(A,0))}const x=h.getIntegratedLoudness();if(!Number.isFinite(x))throw new Error("Full audio contains no measurable programme loudness");return{integratedLufs:x,samplePeak:g,estimatedTruePeak:p.getPeak(),duration:l.duration,sourceUrl:s}}function Ve(e,t,i,s){const a=Math.pow(10,(t-e.integratedLufs)/20),n=Math.max(e.samplePeak,e.estimatedTruePeak??0),r=n>0?Ue/(n*ze):s;return Math.min(Math.max(a,i),s,r)}var He=class{constructor(){this.histories=[],this.peak=0}processChannels(e){for(;this.histories.length<e.length;)this.histories.push(new Float32Array(3));for(let t=0;t<e.length;t++){const i=this.histories[t],s=e[t];for(let a=0;a<s.length;a++){const n=s[a];this.peak=Math.max(this.peak,Math.abs(n),We(i[0],i[1],i[2],n)),i[0]=i[1],i[1]=i[2],i[2]=n}}}getPeak(){return this.peak}};function We(e,t,i,s){let a=0;for(let n=0;n<4;n++){const r=n/4,o=r*r,l=o*r,h=.5*(2*t+(-e+i)*r+(2*e-5*t+4*i-s)*o+(-e+3*t-3*i+s)*l);a=Math.max(a,Math.abs(h))}return a}function Ke(e){for(const t of e){const i=Qe(t,"window.__playinfo__");if(i)try{const s=JSON.parse(i),a=s?.data?.dash?.audio??s?.result?.dash?.audio;if(!Array.isArray(a)||a.length===0)continue;const n=[...a].sort((o,l)=>Number(l?.bandwidth??0)-Number(o?.bandwidth??0))[0],r=n?.baseUrl??n?.base_url;if(typeof r=="string"&&/^https?:\/\//i.test(r))return r}catch{}}return null}function Ye(e){const t=e.currentSrc||e.src;return/^https?:\/\//i.test(t)?t:Ke(Array.from(document.scripts,i=>i.textContent||""))}function Qe(e,t){const i=e.indexOf(t);if(i<0)return null;const s=e.indexOf("{",i+t.length);if(s<0)return null;let a=0,n=!1,r=!1;for(let o=s;o<e.length;o++){const l=e[o];if(n){r?r=!1:l==="\\"?r=!0:l==='"'&&(n=!1);continue}if(l==='"')n=!0;else if(l==="{")a++;else if(l==="}"&&--a===0)return e.slice(s,o+1)}return null}var R=null;function je(e,t){return R||(R=e.audioWorklet.addModule(t).catch(i=>{throw R=null,i})),R}var Xe=class{constructor(e,t,i){this.rafId=0,this.processingEnabled=null,this.lastTickTime=performance.now(),this.agc=new Re,this.originalChannelAnalysers=[],this.originalChannelBuffers=[],this.outputChannelAnalysers=[],this.outputChannelBuffers=[],this.workletLimiter=null,this.destroyed=!1,this.fullAnalysisAbort=null,this.fullAnalysisResult=null,this.analysisStatus="realtime",this.media=e,this.settings=t,this.meterStateCallback=i,this.originalMeter=new T(48e3),this.outputMeter=new T(48e3),this.initAudioNodes(),this.bindEventListeners(),this.startFullAudioAnalysis(),this.tick=this.tick.bind(this),this.rafId=requestAnimationFrame(this.tick)}initAudioNodes(){const e=j();this.audioContext=e,this.sourceNode=e.createMediaElementSource(this.media),this.compressor=e.createDynamicsCompressor(),this.gainNode=e.createGain(),this.originalAnalyser=e.createAnalyser(),this.originalAnalyser.fftSize=2048,this.originalBuffer=new Float32Array(this.originalAnalyser.fftSize),this.originalSplitter=e.createChannelSplitter(2),this.originalChannelAnalysers=this.createChannelAnalysers(e),this.originalChannelBuffers=this.originalChannelAnalysers.map(t=>new Float32Array(t.fftSize)),this.analyser=e.createAnalyser(),this.analyser.fftSize=2048,this.buffer=new Float32Array(this.analyser.fftSize),this.outputSplitter=e.createChannelSplitter(2),this.outputChannelAnalysers=this.createChannelAnalysers(e),this.outputChannelBuffers=this.outputChannelAnalysers.map(t=>new Float32Array(t.fftSize)),this.bassFilter=e.createBiquadFilter(),this.bassFilter.type="lowshelf",this.bassFilter.frequency.value=200,this.bassFilter.gain.value=this.settings.bassBoost,this.fallbackLimiter=e.createDynamicsCompressor(),this.applyLimiter(),this.initLookaheadLimiter(),this.originalMeter=new T(e.sampleRate),this.outputMeter=new T(e.sampleRate),this.applyCompressor(),this.setProcessingEnabled(this.settings.enabled)}bindEventListeners(){this.handleEmptied=()=>{w.emit(G.MEDIA_EMPTIED,{media:this.media}),this.resetGain(),this.cancelFullAudioAnalysis(),this.fullAnalysisResult=null,this.analysisStatus=this.settings.fullAudioAnalysis?"analyzing":"realtime"},this.handleSeeked=()=>{w.emit(G.MEDIA_SEEKED,{media:this.media})},this.handlePlay=()=>{w.emit(G.MEDIA_PLAY,{media:this.media});try{const e=j();e.state==="suspended"&&e.resume().catch(t=>{b("media-play-resume","AudioContext play resume failed",t)}),this.startFullAudioAnalysis()}catch(e){b("media-play-handler","Media play handler failed",e)}},this.handlePause=()=>{w.emit(G.MEDIA_PAUSE,{media:this.media})},this.handleLoadedMetadata=()=>this.startFullAudioAnalysis(),this.media.addEventListener("emptied",this.handleEmptied),this.media.addEventListener("seeked",this.handleSeeked),this.media.addEventListener("play",this.handlePlay),this.media.addEventListener("pause",this.handlePause),this.media.addEventListener("loadedmetadata",this.handleLoadedMetadata),this.handleVisibilityChange=()=>{this.freezeGain(),this.lastTickTime=performance.now()},document.addEventListener("visibilitychange",this.handleVisibilityChange)}applyCompressor(){this.compressor.threshold.value=this.settings.compressorThreshold,this.compressor.knee.value=this.settings.compressorKnee,this.compressor.ratio.value=this.settings.compressorRatio,this.compressor.attack.value=this.settings.compressorAttack,this.compressor.release.value=this.settings.compressorRelease}applyLimiter(){this.fallbackLimiter.threshold.value=-1,this.fallbackLimiter.knee.value=0,this.fallbackLimiter.ratio.value=20,this.fallbackLimiter.attack.value=.001,this.fallbackLimiter.release.value=.05}initLookaheadLimiter(){const e=this.getExtensionUrl("limiter-worklet.js");!e||!this.audioContext.audioWorklet||typeof AudioWorkletNode>"u"||je(this.audioContext,e).then(()=>{if(this.destroyed)return;const t=new AudioWorkletNode(this.audioContext,"lookahead-peak-limiter",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{lookaheadMs:15,releaseMs:50,ceiling:.8912509381337456,interSampleMargin:1.03}});t.onprocessorerror=i=>{b("lookahead-limiter-processor","Lookahead limiter processor failed",i)},this.workletLimiter=t,this.reconnectCurrentChain()}).catch(t=>{b("lookahead-limiter-load","Lookahead limiter load failed; using compressor fallback",t)})}getExtensionUrl(e){try{if(typeof chrome<"u"&&chrome.runtime?.getURL)return chrome.runtime.getURL(e)}catch(t){b("extension-url","Failed to resolve extension asset URL",t)}return null}setProcessingEnabled(e){this.processingEnabled!==e&&(this.processingEnabled=e,e?this.connectProcessingChain():(this.connectBypassChain(),this.gainNode.gain.value=1))}disconnectNodes(){this.safeDisconnect(this.sourceNode),this.safeDisconnect(this.compressor),this.safeDisconnect(this.originalAnalyser),this.safeDisconnect(this.originalSplitter),this.originalChannelAnalysers.forEach(e=>this.safeDisconnect(e)),this.safeDisconnect(this.gainNode),this.safeDisconnect(this.bassFilter),this.safeDisconnect(this.fallbackLimiter),this.workletLimiter&&this.safeDisconnect(this.workletLimiter),this.safeDisconnect(this.analyser),this.safeDisconnect(this.outputSplitter),this.outputChannelAnalysers.forEach(e=>this.safeDisconnect(e))}safeDisconnect(e){try{e.disconnect()}catch{}}reconnectCurrentChain(){this.processingEnabled?this.connectProcessingChain():this.connectBypassChain()}connectProcessingChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.compressor),this.originalAnalyser.connect(this.originalSplitter),this.connectSplitter(this.originalSplitter,this.originalChannelAnalysers),this.compressor.connect(this.gainNode),this.gainNode.connect(this.bassFilter);const e=this.workletLimiter??this.fallbackLimiter;this.bassFilter.connect(e),e.connect(this.analyser),this.analyser.connect(this.outputSplitter),this.connectSplitter(this.outputSplitter,this.outputChannelAnalysers),this.analyser.connect(this.audioContext.destination)}connectBypassChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.originalSplitter),this.connectSplitter(this.originalSplitter,this.originalChannelAnalysers),this.originalAnalyser.connect(this.analyser),this.analyser.connect(this.outputSplitter),this.connectSplitter(this.outputSplitter,this.outputChannelAnalysers),this.analyser.connect(this.audioContext.destination)}createChannelAnalysers(e){return[e.createAnalyser(),e.createAnalyser()].map(t=>(t.fftSize=2048,t))}connectSplitter(e,t){for(let i=0;i<t.length;i++)e.connect(t[i],i)}updateSettings(e){const{_changedField:t,...i}=e,s=t==="targetLufs",a=t==="fullAudioAnalysis",n=this.settings.enabled;this.settings=i,this.applyCompressor(),this.bassFilter.gain.value=i.bassBoost,n!==i.enabled&&this.setProcessingEnabled(i.enabled),s&&(this.agc.reset(),this.resetOutputIntegration()),a&&(i.fullAudioAnalysis?this.startFullAudioAnalysis():(this.cancelFullAudioAnalysis(),this.fullAnalysisResult=null,this.analysisStatus="realtime",this.resetIntegration()))}startFullAudioAnalysis(){if(!this.settings.fullAudioAnalysis||this.destroyed||this.fullAnalysisAbort||this.fullAnalysisResult)return;const e=new AbortController;this.fullAnalysisAbort=e,this.analysisStatus="analyzing",$e(this.media,this.audioContext,e.signal).then(t=>{this.destroyed||e.signal.aborted||(this.fullAnalysisResult=t,this.analysisStatus=this.agc.isLocked()?"fallback":"analyzing")}).catch(t=>{e.signal.aborted||(this.analysisStatus="fallback",b("full-audio-analysis","完整音轨分析失败，继续使用实时算法",t))}).finally(()=>{this.fullAnalysisAbort===e&&(this.fullAnalysisAbort=null)})}cancelFullAudioAnalysis(){this.fullAnalysisAbort?.abort(),this.fullAnalysisAbort=null}resetGain(){this.setGainImmediate(1),this.resetIntegration()}resetIntegration(){this.originalMeter.reset(),this.outputMeter.reset(),this.agc.reset()}setGainImmediate(e){const t=xe(e,this.settings.minGain,this.settings.maxGain);this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime),this.gainNode.gain.setValueAtTime(t,this.audioContext.currentTime),this.gainNode.gain.value=t}freezeGain(){this.setGainImmediate(this.gainNode.gain.value)}resetOutputIntegration(){this.outputMeter.reset();const e=this.measureRms(),t=this.measureOriginalRms();this.updateMeterState(e,t,this.gainNode.gain.value)}measureRms(){this.analyser.getFloatTimeDomainData(this.buffer);let e=0;for(let t=0;t<this.buffer.length;t++){const i=this.buffer[t];e+=i*i}return Math.sqrt(e/this.buffer.length)}measureOriginalRms(){this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);let e=0;for(let t=0;t<this.originalBuffer.length;t++){const i=this.originalBuffer[t];e+=i*i}return Math.sqrt(e/this.originalBuffer.length)}measureOriginalPeak(){let e=0;for(let t=0;t<this.originalChannelBuffers.length;t++){const i=this.originalChannelBuffers[t];for(let s=0;s<i.length;s++){const a=Math.abs(i[s]);a>e&&(e=a)}}return e}updateLoudnessMeasurement(){const e=D.silenceThreshold;let t=!1,i=!1;for(const s of this.originalChannelBuffers){for(let a=0;a<s.length;a++)if(Math.abs(s[a])>e){t=!0;break}if(t)break}for(const s of this.outputChannelBuffers){for(let a=0;a<s.length;a++)if(Math.abs(s[a])>e){i=!0;break}if(i)break}t&&this.originalMeter.processChannels(this.originalChannelBuffers),i&&this.outputMeter.processChannels(this.outputChannelBuffers)}tick(){if(!document.contains(this.media)){this.destroy();return}if(document.hidden){this.freezeGain(),this.lastTickTime=performance.now(),this.rafId=requestAnimationFrame(this.tick);return}const e=performance.now(),t=Math.max(.001,Math.min((e-this.lastTickTime)/1e3,.25));this.lastTickTime=e,this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer),this.analyser.getFloatTimeDomainData(this.buffer),this.readChannelData(this.originalChannelAnalysers,this.originalChannelBuffers),this.readChannelData(this.outputChannelAnalysers,this.outputChannelBuffers);const i=this.measureRms(),s=this.measureOriginalRms(),a=this.measureOriginalPeak();if(this.updateLoudnessMeasurement(),this.settings.enabled&&!this.media.muted&&!this.media.paused&&!this.media.ended){const n=this.originalMeter.getIntegratedLoudness(),r=this.outputMeter.getIntegratedLoudness(),o=this.originalMeter.getIntegrationTime(),l=this.originalMeter.getMomentaryLoudness(),h=this.originalMeter.getShortTermLoudness(),f=Oe({integratedLufs:n,shortTermLufs:h,momentaryLufs:l,integrationTime:o,minIntegrationSeconds:D.minIntegrationSeconds});if(isFinite(f)){const m=v(this.settings.targetRms);if(this.settings.fullAudioAnalysis&&this.fullAnalysisResult){const u=Ve(this.fullAnalysisResult,m,this.settings.minGain,this.settings.maxGain);if(!this.agc.isLocked()){this.agc.lockGain(u),this.analysisStatus="full-track",this.setGainImmediate(u),this.updateMeterState(i,s,u,this.fullAnalysisResult.integratedLufs,r),this.rafId=requestAnimationFrame(this.tick);return}}const g=Ae(f,m),p=this.agc.update({currentGain:this.gainNode.gain.value,desiredGain:g,minGain:this.settings.minGain,maxGain:this.settings.maxGain,deltaSec:t,controlLufs:f,targetLufs:m,integrationTime:o,coldStartSeconds:D.coldStartSeconds,sourcePeak:a,momentaryLufs:l,shortTermLufs:h,gainChangePerSec:this.settings.gainChangePerSec,programTimeSeconds:this.media.currentTime}).nextGain;this.setGainImmediate(p);const x=isFinite(n)?n:f;this.updateMeterState(i,s,p,x,r)}else this.updateMeterState(i,s,this.gainNode.gain.value)}else this.settings.enabled?this.updateMeterState(i,s,this.gainNode.gain.value):(this.setGainImmediate(1),this.updateMeterState(s,s,1,null,null,!0));this.rafId=requestAnimationFrame(this.tick)}readChannelData(e,t){for(let i=0;i<e.length;i++)e[i].getFloatTimeDomainData(t[i])}updateMeterState(e,t,i,s=null,a=null,n=!1){s===null&&(s=this.originalMeter.getIntegratedLoudness()),a===null&&(a=this.outputMeter.getIntegratedLoudness());const r=isFinite(a)?Math.pow(10,(a+.691)/20):e,o=isFinite(s)?Math.pow(10,(s+.691)/20):t;this.meterStateCallback({rms:n?t:e,integratedRms:n?o:r,originalRms:t,originalIntegratedRms:o,gain:i,sampleCount:Math.floor(this.originalMeter.getIntegrationTime()),originalLufs:s,outputLufs:a,integrationTime:this.originalMeter.getIntegrationTime(),analysisStatus:this.analysisStatus})}destroy(){this.destroyed=!0,cancelAnimationFrame(this.rafId),this.media.removeEventListener("emptied",this.handleEmptied),this.media.removeEventListener("seeked",this.handleSeeked),this.media.removeEventListener("play",this.handlePlay),this.media.removeEventListener("pause",this.handlePause),this.media.removeEventListener("loadedmetadata",this.handleLoadedMetadata),document.removeEventListener("visibilitychange",this.handleVisibilityChange),this.cancelFullAudioAnalysis(),this.disconnectNodes(),delete this.media.dataset[W]}},z=!1,U=new WeakMap,Je=5e3;function Ze(e,t){document.querySelectorAll(de).forEach(i=>{et(i,e)}),t&&t()}function et(e,t){if(!(e instanceof HTMLMediaElement)||e.dataset.universalVolumeEqAttached==="1")return;const i=U.get(e)||0;if(!(Date.now()<i))try{t(e),e.dataset[W]="1",U.delete(e)}catch(s){U.set(e,Date.now()+Je),b("media-attach","无法绑定媒体元素，将稍后重试",s)}}function tt(e){z||(z=!0,requestAnimationFrame(()=>{z=!1,e()}))}function it(e){new MutationObserver(()=>tt(e)).observe(document.documentElement,{childList:!0,subtree:!0})}var d=null,$=null;function st(e,t,i){if(d&&document.contains(d))return d;const s=document.getElementById(H);if(s)return d=s,d;const a=document.createElement("div");a.id=H,a.style.cssText=`
    position: fixed;
    right: 0;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `,document.documentElement.appendChild(a),d=a;const n=a.attachShadow({mode:"open"}),r=document.createElement("style");r.textContent=at(),n.appendChild(r);const o=document.createElement("div");return o.innerHTML=nt(e),n.appendChild(o.firstElementChild),rt(n,e,t),ot(n,i),a}function ae(e,t,i){return d&&document.contains(d)?d:(d=null,st(e,t,i))}function ne(e){if(e===0){d&&document.contains(d)&&(d.style.display="none");return}d&&(d.style.display="block")}function at(){return`
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
    .mode-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 9px;
      font-size: 11px;
      color: rgba(255,255,255,0.55);
    }
    .mode-button {
      border: 0;
      border-radius: 999px;
      padding: 3px 9px;
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      font-size: 10px;
    }
    .mode-button.on {
      background: rgba(56,189,248,0.24);
      color: #7dd3fc;
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
  `}function nt(e){const t=v(e.targetRms).toFixed(1),i=e.bassBoost>0?"+":"";return`
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

        <div class="mode-row">
          <span>完整音轨预分析</span>
          <button class="mode-button" data-role="fullAudioAnalysis"></button>
        </div>

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
            <span data-field="bassBoost">${i}${e.bassBoost.toFixed(1)} dB</span>
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
          <div class="meter-row">
            <span class="label">算法</span>
            <span class="val" data-field="analysisStatus">实时</span>
          </div>
        </div>
      </div>
    </div>
  `}function rt(e,t,i){const s=e.querySelector("button.toggle-pill"),a=e.querySelector(".dock-dot"),n=e.querySelectorAll('input[type="range"]'),r=re(e),o=new Map([...n].map(c=>[c.dataset.role,c])),l=e.querySelector('[data-role="fullAudioAnalysis"]');let h=t;const f=()=>{h.enabled?(s.textContent="已开启",s.className="toggle-pill on",a.className="dock-dot"):(s.textContent="已关闭",s.className="toggle-pill off",a.className="dock-dot off")},m=()=>{l.textContent=h.fullAudioAnalysis?"已开启":"实时模式",l.className=h.fullAudioAnalysis?"mode-button on":"mode-button"},g=c=>{const k=v(c.targetRms),P=o.get("targetLufs");P&&(P.value=String(k)),N(r,"targetLufs",k);const M=o.get("maxGain");M&&(M.value=String(c.maxGain)),N(r,"maxGain",c.maxGain);const E=o.get("minGain");E&&(E.value=String(c.minGain)),N(r,"minGain",c.minGain);const L=o.get("bassBoost");L&&(L.value=String(c.bassBoost)),N(r,"bassBoost",c.bassBoost),f(),m()};g(h),s.addEventListener("click",()=>{const c={...h,enabled:!h.enabled};h=i(c)||c,f(),s.blur()}),l.addEventListener("click",()=>{const c={...h,fullAudioAnalysis:!h.fullAudioAnalysis,_changedField:"fullAudioAnalysis"};h=i(c)||c,m(),l.blur()}),n.forEach(c=>{c.addEventListener("input",k=>{const P=k.target,M=P.dataset.role,E=parseFloat(P.value);if(Number.isNaN(E))return;const L={...h};L._changedField=M,M==="targetLufs"?L.targetRms=ye(E):L[M]=E,h=i(L)||L,N(r,M,E)}),c.addEventListener("change",k=>{k.target.blur()})});let p=null,x=null;const u=d,_=e.querySelector(".dock"),F=e.querySelector(".panel-wrapper"),A=()=>{clearTimeout(x),x=null,u.hasAttribute("data-expanded")||(p=setTimeout(()=>{u.setAttribute("data-expanded","")},80))},B=()=>{clearTimeout(p),p=null,x=setTimeout(()=>{u.removeAttribute("data-expanded")},300)};_.addEventListener("mouseenter",A),F.addEventListener("mouseleave",B),F.addEventListener("mouseenter",()=>{clearTimeout(x),x=null}),$&&$(),$=w.on(G.SETTINGS_CHANGED,c=>{const{settings:k}=c;!d||!document.contains(d)||(h=k,g(h))})}function re(e){return{targetLufs:e.querySelector('[data-field="targetLufs"]'),maxGain:e.querySelector('[data-field="maxGain"]'),minGain:e.querySelector('[data-field="minGain"]'),bassBoost:e.querySelector('[data-field="bassBoost"]'),meterOriginalIntegratedLufs:e.querySelector('[data-field="meterOriginalIntegratedLufs"]'),meterOriginalLufs:e.querySelector('[data-field="meterOriginalLufs"]'),meterIntegratedLufs:e.querySelector('[data-field="meterIntegratedLufs"]'),meterLufs:e.querySelector('[data-field="meterLufs"]'),meterGain:e.querySelector('[data-field="meterGain"]'),sampleCount:e.querySelector('[data-field="sampleCount"]'),analysisStatus:e.querySelector('[data-field="analysisStatus"]')}}function N(e,t,i){t==="targetLufs"&&e.targetLufs&&(e.targetLufs.textContent=`${i.toFixed(1)} LUFS`),t==="maxGain"&&e.maxGain&&(e.maxGain.textContent=`${i.toFixed(1)}x`),t==="minGain"&&e.minGain&&(e.minGain.textContent=`${i.toFixed(1)}x`),t==="bassBoost"&&e.bassBoost&&(e.bassBoost.textContent=`${i>0?"+":""}${i.toFixed(1)} dB`)}function ot(e,t){const i=re(e);setInterval(()=>{if(!document.contains(d))return;const{rms:s,integratedRms:a,originalRms:n,originalIntegratedRms:r,gain:o,sampleCount:l,analysisStatus:h}=t(),f=v(s),m=v(a||s),g=v(n),p=v(r||n);i.meterOriginalLufs&&(i.meterOriginalLufs.textContent=g>-70?g.toFixed(1):"-∞"),i.meterOriginalIntegratedLufs&&(i.meterOriginalIntegratedLufs.textContent=p>-70?p.toFixed(1):"-∞"),i.meterLufs&&(i.meterLufs.textContent=f>-70?f.toFixed(1):"-∞"),i.meterIntegratedLufs&&(i.meterIntegratedLufs.textContent=m>-70?m.toFixed(1):"-∞"),i.meterGain&&(i.meterGain.textContent=`${o.toFixed(2)}x`),i.sampleCount&&(i.sampleCount.textContent=`${l}s`),i.analysisStatus&&(i.analysisStatus.textContent={realtime:"实时",analyzing:"分析中","full-track":"整段锁定",fallback:"实时回退"}[h])},100)}function oe(){return{rms:0,integratedRms:0,originalRms:0,originalIntegratedRms:0,gain:1,sampleCount:0,originalLufs:NaN,outputLufs:NaN,integrationTime:0,analysisStatus:"realtime"}}if(!pe())throw b("audio-context-unsupported","当前浏览器不支持 AudioContext, 扩展已停用"),new Error("AudioContext not supported");var y={...I},V=oe(),S=new Map;me(),ge().then(e=>{y={...I,...e},le()}).catch(e=>{fe("settings-load","设置加载失败，使用默认设置启动",e),le()});function le(){const e=()=>{Ze(t=>lt(t),()=>ht())};e(),it(e)}function lt(e){const t=new Xe(e,y,i=>{V=i});S.set(e,t),ne(S.size),ae(y,he,ce)}function ht(){S.forEach((e,t)=>{t.isConnected||(e.destroy(),S.delete(t))}),ne(S.size)}function he(e){const t=e._changedField,i={...e};return delete i._changedField,y=i,be(y),S.forEach(s=>{s.updateSettings({...y,_changedField:t})}),y.enabled||(S.forEach(s=>{s.gainNode.gain.value=1}),V=oe()),w.emit(G.SETTINGS_CHANGED,{settings:y,changedField:t}),y}function ce(){return V}setTimeout(()=>{S.size>0&&ae(y,he,ce)},1e3)})();
