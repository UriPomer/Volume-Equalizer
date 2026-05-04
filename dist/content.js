(function(){var h="[Universal Volume EQ]",R="universal-volume-eq-panel",q="universalVolumeEqAttached",j="video, audio",E={enabled:!0,targetRms:.1363,minGain:.5,maxGain:2,compressorThreshold:-20,compressorKnee:20,compressorRatio:3,compressorAttack:.003,compressorRelease:.3,bassBoost:0,gainChangePerSec:.2},D={minIntegrationSeconds:1,silenceThreshold:.001},C=window.AudioContext||window.webkitAudioContext;C||console.warn(`${h} 当前浏览器不支持 AudioContext, 扩展已停用`);var v=null;function _(){return v||(v=new C),v}function W(){const e=()=>{try{v&&v.state==="suspended"&&v.resume().catch(t=>{console.debug(`${h} AudioContext resume failed:`,t)})}catch(t){console.debug(`${h} Resume handler error:`,t)}};["pointerdown","keydown","click","touchstart"].forEach(t=>{document.addEventListener(t,e,{capture:!0,passive:!0})}),document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&e()})}function X(){return!!C}var z=typeof chrome<"u"&&!!chrome?.storage?.local;function Y(){return z?new Promise(e=>{chrome.storage.local.get(E,t=>{e(t||{...E})})}):Promise.resolve({...E})}function J(e){z&&chrome.storage.local.set(e)}function y(e){return e<=1e-5?-70:20*Math.log10(e)-.691}function Z(e){return Math.pow(10,(e+.691)/20)}function ee(e,t,s){return Math.min(Math.max(e,t),s)}var te=class{constructor(){this.listeners=new Map}on(e,t){return this.listeners.has(e)||this.listeners.set(e,new Set),this.listeners.get(e).add(t),()=>this.off(e,t)}once(e,t){const s=this.on(e,i=>{s(),t(i)});return s}off(e,t){const s=this.listeners.get(e);s&&(s.delete(t),s.size===0&&this.listeners.delete(e))}emit(e,t){const s=this.listeners.get(e);s&&[...s].forEach(i=>{try{i(t)}catch{}})}},k=new te,S={SETTINGS_CHANGED:"settings:changed",MEDIA_PLAY:"media:play",MEDIA_PAUSE:"media:pause",MEDIA_SEEKED:"media:seeked",MEDIA_EMPTIED:"media:emptied"},I=class{constructor(e,t,s,i,a){this.x1=0,this.x2=0,this.y1=0,this.y2=0,this.b0=0,this.b1=0,this.b2=0,this.a1=0,this.a2=0,this.type=e,this.fc=t,this.Q=s,this.gain=i,this.sampleRate=a,this.calculateCoefficients()}calculateCoefficients(){const e=Math.tan(Math.PI*this.fc/this.sampleRate);if(this.type==="high_shelf"){const t=Math.pow(10,this.gain/20),s=Math.pow(t,.499666774155),i=1+e/this.Q+e*e;this.b0=(t+s*e/this.Q+e*e)/i,this.b1=2*(e*e-t)/i,this.b2=(t-s*e/this.Q+e*e)/i,this.a1=2*(e*e-1)/i,this.a2=(1-e/this.Q+e*e)/i}else if(this.type==="high_pass"){const t=1+e/this.Q+e*e;this.b0=1/t,this.b1=-2/t,this.b2=1/t,this.a1=2*(e*e-1)/t,this.a2=(1-e/this.Q+e*e)/t}}processSample(e){const t=this.b0*e+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;return this.x2=this.x1,this.x1=e,this.y2=this.y1,this.y1=t,t}processBlock(e){const t=new Float32Array(e.length);for(let s=0;s<e.length;s++)t[s]=this.processSample(e[s]);return t}reset(){this.x1=this.x2=this.y1=this.y2=0}},B=class{constructor(e=48e3){this.blockSize=.4,this.overlap=.75,this.absoluteThreshold=-70,this.relativeThreshold=-10,this.blocks=[],this.blockLoudness=[],this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.sampleRate=e,this.highShelfFilter=new I("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),this.highPassFilter=new I("high_pass",38.13547087613982,.5003270373253953,0,e),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffer=new Float32Array(this.samplesPerBlock),this.maxBlocks=Math.ceil(600/(this.blockSize*(1-this.overlap)))}applyKWeighting(e){let t=this.highShelfFilter.processSample(e);return t=this.highPassFilter.processSample(t),t}processBlock(e){for(let t=0;t<e.length;t++){const s=this.applyKWeighting(e[t]);if(this.blockBuffer[this.blockBufferIndex]=s,this.blockBufferIndex++,this.samplesSinceLastBlock++,this.blockBufferIndex>=this.samplesPerBlock){const i=this.calculateMeanSquare(this.blockBuffer),a=-.691+10*Math.log10(i);a>=this.absoluteThreshold&&(this.blocks.push(i),this.blockLoudness.push(a),this.blocks.length>this.maxBlocks&&(this.blocks.shift(),this.blockLoudness.shift())),this.samplesSinceLastBlock>=this.stepSamples&&(this.blockBuffer.copyWithin(0,this.stepSamples),this.blockBufferIndex=this.samplesPerBlock-this.stepSamples,this.samplesSinceLastBlock=0)}}}calculateMeanSquare(e){let t=0;for(let s=0;s<e.length;s++)t+=e[s]*e[s];return t/e.length}getIntegratedLoudness(){if(this.blocks.length===0)return NaN;const e=this.blocks.reduce((n,r)=>n+r,0)/this.blocks.length,t=-.691+10*Math.log10(e)+this.relativeThreshold;let s=0,i=0;for(let n=0;n<this.blocks.length;n++){const r=this.blockLoudness[n];r>=this.absoluteThreshold&&r>=t&&(s+=this.blocks[n],i++)}if(i===0)return NaN;const a=s/i;return-.691+10*Math.log10(a)}getMomentaryLoudness(){if(this.blockBufferIndex<this.samplesPerBlock*.5)return NaN;let e=0;for(let s=0;s<this.blockBufferIndex;s++)e+=this.blockBuffer[s]*this.blockBuffer[s];const t=e/this.blockBufferIndex;return t<=0?-1/0:-.691+10*Math.log10(t)}getShortTermLoudness(){const e=Math.ceil(3/(this.blockSize*(1-this.overlap)));if(this.blocks.length<e)return this.getIntegratedLoudness();const t=this.blocks.slice(-e),s=t.reduce((i,a)=>i+a,0)/t.length;return s<=0?-1/0:-.691+10*Math.log10(s)}getIntegrationTime(){return this.blocks.length*this.blockSize*(1-this.overlap)}reset(){this.blocks=[],this.blockLoudness=[],this.blockBuffer.fill(0),this.blockBufferIndex=0,this.samplesSinceLastBlock=0,this.highShelfFilter.reset(),this.highPassFilter.reset()}setSampleRate(e){this.sampleRate!==e&&(this.sampleRate=e,this.highShelfFilter=new I("high_shelf",1681.974450955532,.7071752369554193,3.99984385397,e),this.highPassFilter=new I("high_pass",38.13547087613982,.5003270373253953,0,e),this.samplesPerBlock=Math.ceil(this.blockSize*e),this.stepSamples=Math.ceil(this.samplesPerBlock*(1-this.overlap)),this.blockBuffer=new Float32Array(this.samplesPerBlock),this.reset())}};function se(e,t){if(!isFinite(e)||!isFinite(t))return 1;const s=t-e;return Math.pow(10,s/20)}var ie=class{constructor(e,t,s){this.rafId=0,this.processingEnabled=null,this.media=e,this.settings=t,this.meterStateCallback=s,this.originalMeter=new B(48e3),this.outputMeter=new B(48e3),this.initAudioNodes(),this.bindEventListeners(),this.tick=this.tick.bind(this),this.rafId=requestAnimationFrame(this.tick)}initAudioNodes(){const e=_();this.audioContext=e,this.sourceNode=e.createMediaElementSource(this.media),this.compressor=e.createDynamicsCompressor(),this.gainNode=e.createGain(),this.originalAnalyser=e.createAnalyser(),this.originalAnalyser.fftSize=2048,this.originalBuffer=new Float32Array(this.originalAnalyser.fftSize),this.analyser=e.createAnalyser(),this.analyser.fftSize=2048,this.buffer=new Float32Array(this.analyser.fftSize),this.bassFilter=e.createBiquadFilter(),this.bassFilter.type="lowshelf",this.bassFilter.frequency.value=200,this.bassFilter.gain.value=this.settings.bassBoost,this.originalMeter=new B(e.sampleRate),this.outputMeter=new B(e.sampleRate),this.applyCompressor(),this.setProcessingEnabled(this.settings.enabled)}bindEventListeners(){this.handleEmptied=()=>{k.emit(S.MEDIA_EMPTIED,{media:this.media}),this.resetGain()},this.handleSeeked=()=>{k.emit(S.MEDIA_SEEKED,{media:this.media}),this.resetIntegration()},this.handlePlay=()=>{k.emit(S.MEDIA_PLAY,{media:this.media});try{const e=_();e.state==="suspended"&&e.resume().catch(t=>{console.debug(`${h} AudioContext play resume failed:`,t)})}catch(e){console.debug(`${h} Play event handler error:`,e)}},this.handlePause=()=>{k.emit(S.MEDIA_PAUSE,{media:this.media})},this.media.addEventListener("emptied",this.handleEmptied),this.media.addEventListener("seeked",this.handleSeeked),this.media.addEventListener("play",this.handlePlay),this.media.addEventListener("pause",this.handlePause)}applyCompressor(){this.compressor.threshold.value=this.settings.compressorThreshold,this.compressor.knee.value=this.settings.compressorKnee,this.compressor.ratio.value=this.settings.compressorRatio,this.compressor.attack.value=this.settings.compressorAttack,this.compressor.release.value=this.settings.compressorRelease}setProcessingEnabled(e){this.processingEnabled!==e&&(this.processingEnabled=e,e?this.connectProcessingChain():(this.connectBypassChain(),this.gainNode.gain.value=1))}disconnectNodes(){this.sourceNode.disconnect(),this.compressor.disconnect(),this.originalAnalyser.disconnect(),this.gainNode.disconnect(),this.bassFilter.disconnect(),this.analyser.disconnect()}connectProcessingChain(){this.disconnectNodes(),this.sourceNode.connect(this.compressor),this.compressor.connect(this.originalAnalyser),this.originalAnalyser.connect(this.gainNode),this.gainNode.connect(this.bassFilter),this.bassFilter.connect(this.analyser),this.analyser.connect(this.audioContext.destination)}connectBypassChain(){this.disconnectNodes(),this.sourceNode.connect(this.originalAnalyser),this.originalAnalyser.connect(this.analyser),this.analyser.connect(this.audioContext.destination)}updateSettings(e){const{_changedField:t,...s}=e,i=t==="targetLufs",a=this.settings.enabled;this.settings=s,this.applyCompressor(),this.bassFilter.gain.value=s.bassBoost,a!==s.enabled&&this.setProcessingEnabled(s.enabled),i&&this.resetOutputIntegration()}resetGain(){this.gainNode.gain.value=1,this.resetIntegration()}resetIntegration(){this.originalMeter.reset(),this.outputMeter.reset()}resetOutputIntegration(){this.outputMeter.reset();const e=this.measureRms(),t=this.measureOriginalRms();this.updateMeterState(e,t,this.gainNode.gain.value)}measureRms(){this.analyser.getFloatTimeDomainData(this.buffer);let e=0;for(let t=0;t<this.buffer.length;t++){const s=this.buffer[t];e+=s*s}return Math.sqrt(e/this.buffer.length)}measureOriginalRms(){this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);let e=0;for(let t=0;t<this.originalBuffer.length;t++){const s=this.originalBuffer[t];e+=s*s}return Math.sqrt(e/this.originalBuffer.length)}updateLoudnessMeasurement(e,t){const s=D.silenceThreshold;let i=!1,a=!1;for(let n=0;n<e.length;n++)if(Math.abs(e[n])>s){i=!0;break}for(let n=0;n<t.length;n++)if(Math.abs(t[n])>s){a=!0;break}i&&this.originalMeter.processBlock(e),a&&this.outputMeter.processBlock(t)}tick(){if(!document.contains(this.media)){this.destroy();return}this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer),this.analyser.getFloatTimeDomainData(this.buffer);const e=this.measureRms(),t=this.measureOriginalRms();if(this.updateLoudnessMeasurement(this.originalBuffer,this.buffer),this.settings.enabled&&!this.media.muted&&!this.media.paused&&!this.media.ended){const s=this.originalMeter.getIntegratedLoudness(),i=this.outputMeter.getIntegratedLoudness(),a=this.originalMeter.getIntegrationTime();if(isFinite(s)&&a>=D.minIntegrationSeconds){const n=20*Math.log10(this.settings.targetRms)-.691,r=ee(se(s,n),this.settings.minGain,this.settings.maxGain);this.gainNode.gain.setTargetAtTime(r,this.audioContext.currentTime,5),Math.random()<.01&&console.log(`${h} 测量:`,{targetLufs:n.toFixed(1),originalLufs:s.toFixed(1),outputLufs:isFinite(i)?i.toFixed(1):"N/A",targetGain:r.toFixed(3),currentGain:this.gainNode.gain.value.toFixed(3),integrationTime:a.toFixed(1)+"s"}),this.updateMeterState(e,t,this.gainNode.gain.value,s,i)}else this.updateMeterState(e,t,this.gainNode.gain.value)}else this.settings.enabled?this.updateMeterState(e,t,this.gainNode.gain.value):(this.gainNode.gain.value=1,this.updateMeterState(t,t,1,null,null,!0));this.rafId=requestAnimationFrame(this.tick)}updateMeterState(e,t,s,i=null,a=null,n=!1){i===null&&(i=this.originalMeter.getIntegratedLoudness()),a===null&&(a=this.outputMeter.getIntegratedLoudness());const r=isFinite(a)?Math.pow(10,(a+.691)/20):e,c=isFinite(i)?Math.pow(10,(i+.691)/20):t;this.meterStateCallback({rms:n?t:e,integratedRms:n?c:r,originalRms:t,originalIntegratedRms:c,gain:s,sampleCount:Math.floor(this.originalMeter.getIntegrationTime()*10),originalLufs:i,outputLufs:a,integrationTime:this.originalMeter.getIntegrationTime()})}destroy(){cancelAnimationFrame(this.rafId),this.media.removeEventListener("emptied",this.handleEmptied),this.media.removeEventListener("seeked",this.handleSeeked),this.media.removeEventListener("play",this.handlePlay),this.media.removeEventListener("pause",this.handlePause),this.disconnectNodes(),delete this.media.dataset[q]}},T=!1;function ae(e,t){document.querySelectorAll(j).forEach(s=>{ne(s,e)}),t&&t()}function ne(e,t){if(e instanceof HTMLMediaElement&&e.dataset.universalVolumeEqAttached!=="1")try{t(e),e.dataset[q]="1"}catch(s){console.warn(`${h} 无法绑定媒体元素`,s)}}function re(e){T||(T=!0,requestAnimationFrame(()=>{T=!1,e()}))}function oe(e){new MutationObserver(()=>re(e)).observe(document.documentElement,{childList:!0,subtree:!0})}var o=null,G=null;function le(e,t,s){if(o&&document.contains(o))return o;const i=document.getElementById(R);if(i)return o=i,o;const a=document.createElement("div");a.id=R,a.style.cssText=`
    position: fixed;
    right: 0;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `,document.documentElement.appendChild(a),o=a;const n=a.attachShadow({mode:"open"}),r=document.createElement("style");r.textContent=ce(),n.appendChild(r);const c=document.createElement("div");return c.innerHTML=de(e),n.appendChild(c.firstElementChild),he(n,e,t),ue(n,s),a}function $(e,t,s){return o&&document.contains(o)?o:(o=null,le(e,t,s))}function O(e){if(e===0){o&&document.contains(o)&&(o.style.display="none");return}o&&(o.style.display="block")}function ce(){return`
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
  `}function de(e){const t=y(e.targetRms).toFixed(1),s=e.bassBoost>0?"+":"";return`
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
  `}function he(e,t,s){const i=e.querySelector("button.toggle-pill"),a=e.querySelector(".dock-dot"),n=e.querySelectorAll('input[type="range"]'),r=U(e),c=new Map([...n].map(l=>[l.dataset.role,l]));let d=t;const w=()=>{d.enabled?(i.textContent="已开启",i.className="toggle-pill on",a.className="dock-dot"):(i.textContent="已关闭",i.className="toggle-pill off",a.className="dock-dot off")},F=l=>{const m=y(l.targetRms),A=c.get("targetLufs");A&&(A.value=String(m)),M(r,"targetLufs",m);const b=c.get("maxGain");b&&(b.value=String(l.maxGain)),M(r,"maxGain",l.maxGain);const x=c.get("minGain");x&&(x.value=String(l.minGain)),M(r,"minGain",l.minGain);const f=c.get("bassBoost");f&&(f.value=String(l.bassBoost)),M(r,"bassBoost",l.bassBoost),w()};F(d),i.addEventListener("click",()=>{const l={...d,enabled:!d.enabled};d=s(l)||l,w(),i.blur()}),n.forEach(l=>{l.addEventListener("input",m=>{const A=m.target,b=A.dataset.role,x=parseFloat(A.value);if(Number.isNaN(x))return;const f={...d};f._changedField=b,b==="targetLufs"?f.targetRms=Z(x):f[b]=x,d=s(f)||f,M(r,b,x)}),l.addEventListener("change",m=>{m.target.blur()})});let L=null,g=null;const N=o,me=e.querySelector(".dock"),K=e.querySelector(".panel-wrapper"),fe=()=>{clearTimeout(g),g=null,N.hasAttribute("data-expanded")||(L=setTimeout(()=>{N.setAttribute("data-expanded","")},80))},be=()=>{clearTimeout(L),L=null,g=setTimeout(()=>{N.removeAttribute("data-expanded")},300)};me.addEventListener("mouseenter",fe),K.addEventListener("mouseleave",be),K.addEventListener("mouseenter",()=>{clearTimeout(g),g=null}),G&&G(),G=k.on(S.SETTINGS_CHANGED,l=>{const{settings:m}=l;!o||!document.contains(o)||(d=m,F(d))})}function U(e){return{targetLufs:e.querySelector('[data-field="targetLufs"]'),maxGain:e.querySelector('[data-field="maxGain"]'),minGain:e.querySelector('[data-field="minGain"]'),bassBoost:e.querySelector('[data-field="bassBoost"]'),meterOriginalIntegratedLufs:e.querySelector('[data-field="meterOriginalIntegratedLufs"]'),meterOriginalLufs:e.querySelector('[data-field="meterOriginalLufs"]'),meterIntegratedLufs:e.querySelector('[data-field="meterIntegratedLufs"]'),meterLufs:e.querySelector('[data-field="meterLufs"]'),meterGain:e.querySelector('[data-field="meterGain"]'),sampleCount:e.querySelector('[data-field="sampleCount"]')}}function M(e,t,s){t==="targetLufs"&&e.targetLufs&&(e.targetLufs.textContent=`${s.toFixed(1)} LUFS`),t==="maxGain"&&e.maxGain&&(e.maxGain.textContent=`${s.toFixed(1)}x`),t==="minGain"&&e.minGain&&(e.minGain.textContent=`${s.toFixed(1)}x`),t==="bassBoost"&&e.bassBoost&&(e.bassBoost.textContent=`${s>0?"+":""}${s.toFixed(1)} dB`)}function ue(e,t){const s=U(e);setInterval(()=>{if(!document.contains(o))return;const{rms:i,integratedRms:a,originalRms:n,originalIntegratedRms:r,gain:c,sampleCount:d}=t(),w=y(i),F=y(a||i),L=y(n),g=y(r||n);s.meterOriginalLufs&&(s.meterOriginalLufs.textContent=L>-70?L.toFixed(1):"-∞"),s.meterOriginalIntegratedLufs&&(s.meterOriginalIntegratedLufs.textContent=g>-70?g.toFixed(1):"-∞"),s.meterLufs&&(s.meterLufs.textContent=w>-70?w.toFixed(1):"-∞"),s.meterIntegratedLufs&&(s.meterIntegratedLufs.textContent=F>-70?F.toFixed(1):"-∞"),s.meterGain&&(s.meterGain.textContent=`${c.toFixed(2)}x`),s.sampleCount&&(s.sampleCount.textContent=`${d}s`)},100)}if(!X())throw console.warn(`${h} 当前浏览器不支持 AudioContext, 扩展已停用`),new Error("AudioContext not supported");var u={...E},P={rms:0,gain:1},p=new Map;console.debug(`${h} 初始化: 在任意媒体元素上执行音量均衡`),W(),Y().then(e=>{u={...E,...e},Q()}).catch(e=>{console.error(`${h} 设置加载失败`,e),Q()});function Q(){const e=()=>{ae(t=>pe(t),()=>ge())};e(),oe(e)}function pe(e){const t=new ie(e,u,s=>{P=s});p.set(e,t),O(p.size),$(u,H,V)}function ge(){p.forEach((e,t)=>{t.isConnected||(e.destroy(),p.delete(t))}),O(p.size)}function H(e){const t=e._changedField||null,s={...e};return delete s._changedField,u=s,J(u),p.forEach(i=>{i.updateSettings({...u,_changedField:t})}),u.enabled||(p.forEach(i=>{i.gainNode.gain.value=1}),P={rms:0,integratedRms:0,originalRms:0,originalIntegratedRms:0,gain:1,sampleCount:0}),k.emit(S.SETTINGS_CHANGED,{settings:u,changedField:t}),u}function V(){return P}setTimeout(()=>{p.size>0&&$(u,H,V)},1e3)})();
