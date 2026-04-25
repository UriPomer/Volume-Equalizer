(function(){var p="[Universal Volume EQ]",z="universal-volume-eq-panel",O="universalVolumeEqAttached",Z="video, audio",I={enabled:!0,targetRms:.1363,minGain:.5,maxGain:2,compressorThreshold:-20,compressorKnee:20,compressorRatio:3,compressorAttack:.003,compressorRelease:.3,bassBoost:0,gainChangePerSec:.2},B={Kp:.15,Ki:.005,Kd:.08,integralLimit:5},K={minIntegrationSeconds:3,silenceThreshold:.001},N=window.AudioContext||window.webkitAudioContext;N||console.warn(`${p} 当前浏览器不支持 AudioContext, 扩展已停用`);var M=null;function U(){return M||(M=new N),M}function ee(){const e=()=>{try{M&&M.state==="suspended"&&M.resume().catch(t=>{console.debug(`${p} AudioContext resume failed:`,t)})}catch(t){console.debug(`${p} Resume handler error:`,t)}};["pointerdown","keydown","click","touchstart"].forEach(t=>{document.addEventListener(t,e,{capture:!0,passive:!0})}),document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&e()})}function te(){return!!N}var Q=typeof chrome<"u"&&!!chrome?.storage?.local;function se(){return Q?new Promise(e=>{chrome.storage.local.get(I,t=>{e(t||{...I})})}):Promise.resolve({...I})}function ie(e){Q&&chrome.storage.local.set(e)}function E(e){return e<=1e-5?-70:20*Math.log10(e)-.691}function ne(e){return Math.pow(10,(e+.691)/20)}function H(e,t,s){return Math.min(Math.max(e,t),s)}var ae=class{constructor(){this.integral=0,this.lastError=0,this.Kp=B.Kp,this.Ki=B.Ki,this.Kd=B.Kd,this.integralLimit=B.integralLimit}compute(e){const t=this.Kp*e;this.integral+=e,this.integral=H(this.integral,-this.integralLimit,this.integralLimit);const s=this.Ki*this.integral,i=this.Kd*(e-this.lastError);return this.lastError=e,t+s+i}reset(){this.integral=0,this.lastError=0}},re=class{constructor(){this.listeners=new Map}on(e,t){return this.listeners.has(e)||this.listeners.set(e,new Set),this.listeners.get(e).add(t),()=>this.off(e,t)}once(e,t){const s=this.on(e,i=>{s(),t(i)});return s}off(e,t){const s=this.listeners.get(e);s&&(s.delete(t),s.size===0&&this.listeners.delete(e))}emit(e,t){const s=this.listeners.get(e);s&&[...s].forEach(i=>{try{i(t)}catch{}})}},w=new re,F={SETTINGS_CHANGED:"settings:changed",MEDIA_PLAY:"media:play",MEDIA_PAUSE:"media:pause",MEDIA_SEEKED:"media:seeked",MEDIA_EMPTIED:"media:emptied"},T=class{constructor(e,t,s,i,n){this.x1=0,this.x2=0,this.y1=0,this.y2=0,this.b0=0,this.b1=0,this.b2=0,this.a1=0,this.a2=0,this.type=e,this.fc=t,this.Q=s,this.gain=i,this.sampleRate=n,this.calculateCoefficients()}calculateCoefficients(){const e=Math.tan(Math.PI*this.fc/this.sampleRate);if(this.type==="high_shelf"){const t=Math.pow(10,this.gain/20),s=Math.pow(t,.499666774155),i=1+e/this.Q+e*e;this.b0=(t+s*e/this.Q+e*e)/i,this.b1=2*(e*e-t)/i,this.b2=(t-s*e/this.Q+e*e)/i,this.a1=2*(e*e-1)/i,this.a2=(1-e/this.Q+e*e)/i}else if(this.type==="high_pass"){const t=1+e/this.Q+e*e;this.b0=1/t,this.b1=-2/t,this.b2=1/t,this.a1=2*(e*e-1)/t,this.a2=(1-e/this.Q+e*e)/t}}processSample(e){const t=this.b0*e+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;return this.x2=this.x1,this.x1=e,this.y2=this.y1,this.y1=t,t}processBlock(e){const t=new Float32Array(e.length);for(let s=0;s<e.length;s++)t[s]=this.processSample(e[s]);return t}reset(){this.x1=this.x2=this.y1=this.y2=0}},G=class{constructor(e=48e3){this.blockSize=.4,this.overlap=.75,this.absoluteThreshold=-70,this.relativeThreshold=-10,this.blocks=[],this.blockLoudness=[],this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.sampleRate=e,this.highShelfFilter=new T("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),this.highPassFilter=new T("high_pass",38.13547087613982,.5003270373253953,0,e),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffer=new Float32Array(this.samplesPerBlock),this.maxBlocks=Math.ceil(60/(this.blockSize*(1-this.overlap)))}applyKWeighting(e){let t=this.highShelfFilter.processSample(e);return t=this.highPassFilter.processSample(t),t}processBlock(e){for(let t=0;t<e.length;t++){const s=this.applyKWeighting(e[t]);if(this.blockBuffer[this.blockBufferIndex]=s,this.blockBufferIndex++,this.samplesSinceLastBlock++,this.blockBufferIndex>=this.samplesPerBlock){const i=this.calculateMeanSquare(this.blockBuffer),n=-.691+10*Math.log10(i);n>=this.absoluteThreshold&&(this.blocks.push(i),this.blockLoudness.push(n),this.blocks.length>this.maxBlocks&&(this.blocks.shift(),this.blockLoudness.shift())),this.samplesSinceLastBlock>=this.stepSamples&&(this.blockBuffer.copyWithin(0,this.stepSamples),this.blockBufferIndex=this.samplesPerBlock-this.stepSamples,this.samplesSinceLastBlock=0)}}}calculateMeanSquare(e){let t=0;for(let s=0;s<e.length;s++)t+=e[s]*e[s];return t/e.length}getIntegratedLoudness(){if(this.blocks.length===0)return NaN;const e=this.blocks.reduce((a,o)=>a+o,0)/this.blocks.length,t=-.691+10*Math.log10(e)+this.relativeThreshold;let s=0,i=0;for(let a=0;a<this.blocks.length;a++){const o=this.blockLoudness[a];o>=this.absoluteThreshold&&o>=t&&(s+=this.blocks[a],i++)}if(i===0)return NaN;const n=s/i;return-.691+10*Math.log10(n)}getMomentaryLoudness(){if(this.blockBufferIndex<this.samplesPerBlock*.5)return NaN;let e=0;for(let s=0;s<this.blockBufferIndex;s++)e+=this.blockBuffer[s]*this.blockBuffer[s];const t=e/this.blockBufferIndex;return t<=0?-1/0:-.691+10*Math.log10(t)}getShortTermLoudness(){const e=Math.ceil(3/(this.blockSize*(1-this.overlap)));if(this.blocks.length<e)return this.getIntegratedLoudness();const t=this.blocks.slice(-e),s=t.reduce((i,n)=>i+n,0)/t.length;return s<=0?-1/0:-.691+10*Math.log10(s)}getIntegrationTime(){return this.blocks.length*this.blockSize*(1-this.overlap)}reset(){this.blocks=[],this.blockLoudness=[],this.blockBuffer.fill(0),this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.highShelfFilter.reset(),this.highPassFilter.reset()}setSampleRate(e){this.sampleRate!==e&&(this.sampleRate=e,this.highShelfFilter=new T("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),this.highPassFilter=new T("high_pass",38.13547087613982,.5003270373253953,0,e),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffer=new Float32Array(this.samplesPerBlock),this.reset())}};function oe(e,t){if(!isFinite(e)||!isFinite(t))return 1;const s=t-e;return Math.pow(10,s/20)}function le(e){return e<=0?-1/0:20*Math.log10(e)-.691}var ce=class{constructor(e,t,s){this.rafId=0,this.processingEnabled=null,this.media=e,this.settings=t,this.meterStateCallback=s,this.originalMeter=new G(48e3),this.outputMeter=new G(48e3),this.lastTickTime=performance.now(),this.pidController=new ae,this.initAudioNodes(),this.bindEventListeners(),this.tick=this.tick.bind(this),this.rafId=requestAnimationFrame(this.tick)}initAudioNodes(){const e=U();this.audioContext=e,this.sourceNode=e.createMediaElementSource(this.media),this.compressor=e.createDynamicsCompressor(),this.gainNode=e.createGain(),this.originalAnalyser=e.createAnalyser(),this.originalAnalyser.fftSize=2048,this.originalBuffer=new Float32Array(this.originalAnalyser.fftSize),this.analyser=e.createAnalyser(),this.analyser.fftSize=2048,this.buffer=new Float32Array(this.analyser.fftSize),this.bassFilter=e.createBiquadFilter(),this.bassFilter.type="lowshelf",this.bassFilter.frequency.value=200,this.bassFilter.gain.value=this.settings.bassBoost,this.originalMeter=new G(e.sampleRate),this.outputMeter=new G(e.sampleRate),this.applyCompressor(),this.setProcessingEnabled(this.settings.enabled)}bindEventListeners(){this.handleEmptied=()=>{w.emit(F.MEDIA_EMPTIED,{media:this.media}),this.resetGain()},this.handleSeeked=()=>{w.emit(F.MEDIA_SEEKED,{media:this.media}),this.resetIntegration()},this.handlePlay=()=>{w.emit(F.MEDIA_PLAY,{media:this.media});try{const e=U();e.state==="suspended"&&e.resume().catch(t=>{console.debug(`${p} AudioContext play resume failed:`,t)})}catch(e){console.debug(`${p} Play event handler error:`,e)}},this.handlePause=()=>{w.emit(F.MEDIA_PAUSE,{media:this.media})},this.media.addEventListener("emptied",this.handleEmptied),this.media.addEventListener("seeked",this.handleSeeked),this.media.addEventListener("play",this.handlePlay),this.media.addEventListener("pause",this.handlePause)}applyCompressor(){this.compressor.threshold.value=this.settings.compressorThreshold,this.compressor.knee.value=this.settings.compressorKnee,this.compressor.ratio.value=this.settings.compressorRatio,this.compressor.attack.value=this.settings.compressorAttack,this.compressor.release.value=this.settings.compressorRelease}setProcessingEnabled(e){this.processingEnabled!==e&&(this.processingEnabled=e,e?this.connectProcessingChain():(this.connectBypassChain(),this.gainNode.gain.value=1))}disconnectNodes(){this.sourceNode.disconnect(),this.compressor.disconnect(),this.originalAnalyser.disconnect(),this.gainNode.disconnect(),this.bassFilter.disconnect(),this.analyser.disconnect()}connectProcessingChain(){this.disconnectNodes(),this.sourceNode.connect(this.compressor),this.compressor.connect(this.originalAnalyser),this.originalAnalyser.connect(this.gainNode),this.gainNode.connect(this.bassFilter),this.bassFilter.connect(this.analyser),this.analyser.connect(this.audioContext.destination)}connectBypassChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.analyser),this.analyser.connect(this.audioContext.destination)}updateSettings(e){const{_changedField:t,...s}=e,i=t==="targetLufs",n=this.settings.enabled;this.settings=s,this.applyCompressor(),this.bassFilter.gain.value=s.bassBoost,n!==s.enabled&&this.setProcessingEnabled(s.enabled),i&&this.resetOutputIntegration()}resetGain(){this.gainNode.gain.value=1,this.resetIntegration()}resetIntegration(){this.originalMeter.reset(),this.outputMeter.reset(),this.lastTickTime=performance.now(),this.pidController.reset()}resetOutputIntegration(){this.outputMeter.reset(),this.lastTickTime=performance.now(),this.pidController.reset();const e=this.measureRms(),t=this.measureOriginalRms();this.updateMeterState(e,t,this.gainNode.gain.value)}measureRms(){this.analyser.getFloatTimeDomainData(this.buffer);let e=0;for(let t=0;t<this.buffer.length;t++){const s=this.buffer[t];e+=s*s}return Math.sqrt(e/this.buffer.length)}measureOriginalRms(){this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);let e=0;for(let t=0;t<this.originalBuffer.length;t++){const s=this.originalBuffer[t];e+=s*s}return Math.sqrt(e/this.originalBuffer.length)}updateLoudnessMeasurement(e,t){const s=K.silenceThreshold;let i=!1,n=!1;for(let a=0;a<e.length;a++)if(Math.abs(e[a])>s){i=!0;break}for(let a=0;a<t.length;a++)if(Math.abs(t[a])>s){n=!0;break}i&&this.originalMeter.processBlock(e),n&&this.outputMeter.processBlock(t)}tick(){if(!document.contains(this.media)){this.destroy();return}const e=performance.now(),t=Math.max(.001,(e-this.lastTickTime)/1e3);this.lastTickTime=e,this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer),this.analyser.getFloatTimeDomainData(this.buffer);const s=this.measureRms(),i=this.measureOriginalRms();if(this.updateLoudnessMeasurement(this.originalBuffer,this.buffer),this.settings.enabled&&!this.media.muted&&!this.media.paused&&!this.media.ended){const n=this.originalMeter.getIntegratedLoudness(),a=this.outputMeter.getIntegratedLoudness(),o=this.originalMeter.getIntegrationTime(),d=this.originalMeter.getMomentaryLoudness(),c=o>=K.minIntegrationSeconds&&isFinite(n);if(c||isFinite(d)){const x=le(this.settings.targetRms),v=oe(c?n:d,x);Math.random()<.01&&console.log(`${p} ITU-R BS.1770-4 测量:`,{targetLufs:x.toFixed(1),originalLufs:c?n.toFixed(1):`${d.toFixed(1)}(M)`,outputLufs:isFinite(a)?a.toFixed(1):"N/A",idealGain:v.toFixed(3),currentGain:this.gainNode.gain.value.toFixed(3),integrationTime:o.toFixed(1)+"s",mode:c?"integrated":"cold-start"});const h=this.gainNode.gain.value,m=v-h,k=h+this.pidController.compute(m),P=this.settings.gainChangePerSec*t,C=c?1:5,_=P*C,$=P*3*C;let r;k>h?r=Math.min(k,h+_):r=Math.max(k,h-$);const u=H(r,this.settings.minGain,this.settings.maxGain);this.gainNode.gain.value=u;const S=c?n:d,f=c?a:this.outputMeter.getMomentaryLoudness();this.updateMeterState(s,i,u,S,f)}else this.updateMeterState(s,i,this.gainNode.gain.value)}else this.settings.enabled?this.updateMeterState(s,i,this.gainNode.gain.value):(this.gainNode.gain.value=1,this.updateMeterState(i,i,1,null,null,!0));this.rafId=requestAnimationFrame(this.tick)}updateMeterState(e,t,s,i=null,n=null,a=!1){i===null&&(i=this.originalMeter.getIntegratedLoudness()),n===null&&(n=this.outputMeter.getIntegratedLoudness());const o=isFinite(n)?Math.pow(10,(n+.691)/20):e,d=isFinite(i)?Math.pow(10,(i+.691)/20):t;this.meterStateCallback({rms:a?t:e,integratedRms:a?d:o,originalRms:t,originalIntegratedRms:d,gain:s,sampleCount:Math.floor(this.originalMeter.getIntegrationTime()*10),originalLufs:i,outputLufs:n,integrationTime:this.originalMeter.getIntegrationTime()})}destroy(){cancelAnimationFrame(this.rafId),this.media.removeEventListener("emptied",this.handleEmptied),this.media.removeEventListener("seeked",this.handleSeeked),this.media.removeEventListener("play",this.handlePlay),this.media.removeEventListener("pause",this.handlePause),this.disconnectNodes(),delete this.media.dataset[O]}},R=!1;function de(e,t){document.querySelectorAll(Z).forEach(s=>{he(s,e)}),t&&t()}function he(e,t){if(e instanceof HTMLMediaElement&&e.dataset.universalVolumeEqAttached!=="1")try{t(e),e.dataset[O]="1"}catch(s){console.warn(`${p} 无法绑定媒体元素`,s)}}function ue(e){R||(R=!0,requestAnimationFrame(()=>{R=!1,e()}))}function pe(e){new MutationObserver(()=>ue(e)).observe(document.documentElement,{childList:!0,subtree:!0})}var l=null,q=null;function ge(e,t,s){if(l&&document.contains(l))return l;const i=document.getElementById(z);if(i)return l=i,l;const n=document.createElement("div");n.id=z,n.style.cssText=`
    position: fixed;
    right: 0;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `,document.documentElement.appendChild(n),l=n;const a=n.attachShadow({mode:"open"}),o=document.createElement("style");o.textContent=me(),a.appendChild(o);const d=document.createElement("div");return d.innerHTML=fe(e),a.appendChild(d.firstElementChild),be(a,e,t),xe(a,s),n}function V(e,t,s){return l&&document.contains(l)?l:(l=null,ge(e,t,s))}function j(e){if(e===0){l&&document.contains(l)&&(l.style.display="none");return}l&&(l.style.display="block")}function me(){return`
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
  `}function fe(e){const t=E(e.targetRms).toFixed(1),s=e.bassBoost>0?"+":"";return`
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
  `}function be(e,t,s){const i=e.querySelector("button.toggle-pill"),n=e.querySelector(".dock-dot"),a=e.querySelectorAll('input[type="range"]'),o=W(e),d=new Map([...a].map(r=>[r.dataset.role,r]));let c=t;const x=()=>{c.enabled?(i.textContent="已开启",i.className="toggle-pill on",n.className="dock-dot"):(i.textContent="已关闭",i.className="toggle-pill off",n.className="dock-dot off")},v=r=>{const u=E(r.targetRms),S=d.get("targetLufs");S&&(S.value=String(u)),A(o,"targetLufs",u);const f=d.get("maxGain");f&&(f.value=String(r.maxGain)),A(o,"maxGain",r.maxGain);const L=d.get("minGain");L&&(L.value=String(r.minGain)),A(o,"minGain",r.minGain);const y=d.get("bassBoost");y&&(y.value=String(r.bassBoost)),A(o,"bassBoost",r.bassBoost),x()};v(c),i.addEventListener("click",()=>{const r={...c,enabled:!c.enabled};c=s(r)||r,x(),i.blur()}),a.forEach(r=>{r.addEventListener("input",u=>{const S=u.target,f=S.dataset.role,L=parseFloat(S.value);if(Number.isNaN(L))return;const y={...c};y._changedField=f,f==="targetLufs"?y.targetRms=ne(L):y[f]=L,c=s(y)||y,A(o,f,L)}),r.addEventListener("change",u=>{u.target.blur()})});let h=null,m=null;const k=l,P=e.querySelector(".dock"),C=e.querySelector(".panel-wrapper"),_=()=>{clearTimeout(m),m=null,k.hasAttribute("data-expanded")||(h=setTimeout(()=>{k.setAttribute("data-expanded","")},80))},$=()=>{clearTimeout(h),h=null,m=setTimeout(()=>{k.removeAttribute("data-expanded")},300)};P.addEventListener("mouseenter",_),C.addEventListener("mouseleave",$),C.addEventListener("mouseenter",()=>{clearTimeout(m),m=null}),q&&q(),q=w.on(F.SETTINGS_CHANGED,r=>{const{settings:u}=r;!l||!document.contains(l)||(c=u,v(c))})}function W(e){return{targetLufs:e.querySelector('[data-field="targetLufs"]'),maxGain:e.querySelector('[data-field="maxGain"]'),minGain:e.querySelector('[data-field="minGain"]'),bassBoost:e.querySelector('[data-field="bassBoost"]'),meterOriginalIntegratedLufs:e.querySelector('[data-field="meterOriginalIntegratedLufs"]'),meterOriginalLufs:e.querySelector('[data-field="meterOriginalLufs"]'),meterIntegratedLufs:e.querySelector('[data-field="meterIntegratedLufs"]'),meterLufs:e.querySelector('[data-field="meterLufs"]'),meterGain:e.querySelector('[data-field="meterGain"]'),sampleCount:e.querySelector('[data-field="sampleCount"]')}}function A(e,t,s){t==="targetLufs"&&e.targetLufs&&(e.targetLufs.textContent=`${s.toFixed(1)} LUFS`),t==="maxGain"&&e.maxGain&&(e.maxGain.textContent=`${s.toFixed(1)}x`),t==="minGain"&&e.minGain&&(e.minGain.textContent=`${s.toFixed(1)}x`),t==="bassBoost"&&e.bassBoost&&(e.bassBoost.textContent=`${s>0?"+":""}${s.toFixed(1)} dB`)}function xe(e,t){const s=W(e);setInterval(()=>{if(!document.contains(l))return;const{rms:i,integratedRms:n,originalRms:a,originalIntegratedRms:o,gain:d,sampleCount:c}=t(),x=E(i),v=E(n||i),h=E(a),m=E(o||a);s.meterOriginalLufs&&(s.meterOriginalLufs.textContent=h>-70?h.toFixed(1):"-∞"),s.meterOriginalIntegratedLufs&&(s.meterOriginalIntegratedLufs.textContent=m>-70?m.toFixed(1):"-∞"),s.meterLufs&&(s.meterLufs.textContent=x>-70?x.toFixed(1):"-∞"),s.meterIntegratedLufs&&(s.meterIntegratedLufs.textContent=v>-70?v.toFixed(1):"-∞"),s.meterGain&&(s.meterGain.textContent=`${d.toFixed(2)}x`),s.sampleCount&&(s.sampleCount.textContent=`${c}s`)},100)}if(!te())throw console.warn(`${p} 当前浏览器不支持 AudioContext, 扩展已停用`),new Error("AudioContext not supported");var g={...I},D={rms:0,gain:1},b=new Map;console.debug(`${p} 初始化: 在任意媒体元素上执行音量均衡`),ee(),se().then(e=>{g={...I,...e},X()}).catch(e=>{console.error(`${p} 设置加载失败`,e),X()});function X(){const e=()=>{de(t=>ve(t),()=>ye())};e(),pe(e)}function ve(e){const t=new ce(e,g,s=>{D=s});b.set(e,t),j(b.size),V(g,Y,J)}function ye(){b.forEach((e,t)=>{t.isConnected||(e.destroy(),b.delete(t))}),j(b.size)}function Y(e){const t=e._changedField||null,s={...e};return delete s._changedField,g=s,ie(g),b.forEach(i=>{i.updateSettings({...g,_changedField:t})}),g.enabled||(b.forEach(i=>{i.gainNode.gain.value=1}),D={rms:0,integratedRms:0,originalRms:0,originalIntegratedRms:0,gain:1,sampleCount:0}),w.emit(F.SETTINGS_CHANGED,{settings:g,changedField:t}),g}function J(){return D}setTimeout(()=>{b.size>0&&V(g,Y,J)},1e3)})();
