(() => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const BRAND = '[Universal Volume EQ]';
  const PANEL_ID = 'universal-volume-eq-panel';
  const DATASET_FLAG = 'universalVolumeEqAttached';
  const TARGET_SELECTOR = 'video, audio';

  if (!AudioContextClass) {
    console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
    return;
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetRms: 0.1924,  // 对应 -15 LUFS (YouTube标准, 实际计算: 10^((-15+0.691)/20))
    minGain: 0.5,      // 最小增益 (避免过度压缩)
    maxGain: 2.0,      // 最大增益 (避免失真)
    compressorThreshold: -20,  // 压缩器阈值 (dB)
    compressorKnee: 20,        // 压缩器拐点柔和度
    compressorRatio: 3,        // 压缩比 (3:1)
    compressorAttack: 0.003,   // 压缩器启动时间 (秒)
    compressorRelease: 0.3,    // 压缩器释放时间 (秒)
    bassBoost: 0               // 低频增益 (dB: -6 ~ +6)
  };

  let settings = { ...DEFAULT_SETTINGS };
  let meterState = { rms: 0, gain: 1 };
  let audioCtx = null;
  const controllers = new Map();
  let scanScheduled = false;
  let panelHost = null;
  const storageSupported = typeof chrome !== 'undefined' && chrome?.storage?.local;

  describeGoal();
  installGlobalResumeHandlers();

  loadSettings()
    .then((loaded) => {
      settings = { ...DEFAULT_SETTINGS, ...loaded };
      scanForMedia();
      observeMutations();
    })
    .catch((err) => {
      console.error(`${BRAND} 设置加载失败`, err);
      scanForMedia();
      observeMutations();
    });

  function describeGoal() {
    console.debug(`${BRAND} 初始化: 在任意媒体元素上执行音量均衡`);
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    return audioCtx;
  }

  function loadSettings() {
    if (!storageSupported) {
      return Promise.resolve({ ...DEFAULT_SETTINGS });
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
        resolve(result || { ...DEFAULT_SETTINGS });
      });
    });
  }

  function persistSettings() {
    if (!storageSupported) return;
    chrome.storage.local.set(settings);
  }

  function installGlobalResumeHandlers() {
    const resume = () => {
      try {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch((err) => {
            console.debug('[BiliVolume] AudioContext resume failed:', err);
          });
        }
      } catch (err) {
        console.debug('[BiliVolume] Resume handler error:', err);
      }
    };
    ['pointerdown', 'keydown', 'click', 'touchstart'].forEach((evt) => {
      document.addEventListener(evt, resume, { capture: true, once: false, passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resume();
    });
  }
 
  function observeMutations() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanForMedia();
    });
  }

  function scanForMedia() {
    document.querySelectorAll(TARGET_SELECTOR).forEach((media) => {
      tryAttachController(media);
    });

    controllers.forEach((controller, media) => {
      if (!media.isConnected) {
        controller.destroy();
        controllers.delete(media);
      }
    });

    updatePanelVisibility();
  }


  function tryAttachController(media) {
    if (!(media instanceof HTMLMediaElement)) return;
    if (media.dataset[DATASET_FLAG] === '1') return;
    try {
      const controller = new MediaVolumeController(media);
      controllers.set(media, controller);
      media.dataset[DATASET_FLAG] = '1';
    } catch (error) {
      console.warn(`${BRAND} 无法绑定媒体元素`, error);
    }
  }

  function ensurePanel() {
    if (panelHost && document.contains(panelHost)) {
      return panelHost;
    }
    panelHost = null;
    return createPanel();
  }

  function updatePanelVisibility() {
    if (controllers.size === 0) {
      if (panelHost && document.contains(panelHost)) {
        panelHost.style.display = 'none';
      }
      return;
    }
    const host = ensurePanel();
    if (host) {
      host.style.display = 'block';
    }
  }

  class MediaVolumeController {
    constructor(media) {
      this.media = media;
      this.buffer = null;
      this.rafId = 0;
      this.settings = settings;

      // 积分响度计算
      this.rmsHistory = [];  // 存储输出RMS样本
      this.originalRmsHistory = [];  // 存储原始RMS样本
      this.maxHistorySize = 600;  // 最多保留600个样本 (约10秒@60fps)
      this.integratedRms = null;  // 输出积分平均RMS
      this.originalIntegratedRms = null;  // 原始积分平均RMS
      
      // PID控制器状态
      this.pidIntegral = 0;
      this.pidLastError = 0;

      const ctx = ensureAudioContext();
      this.sourceNode = ctx.createMediaElementSource(media);
      this.compressor = ctx.createDynamicsCompressor();
      this.gainNode = ctx.createGain();
      
      // 原始音频分析器 (测量输入)
      this.originalAnalyser = ctx.createAnalyser();
      this.originalAnalyser.fftSize = 2048;
      this.originalBuffer = new Float32Array(this.originalAnalyser.fftSize);
      
      // 输出音频分析器 (测量输出)
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.buffer = new Float32Array(this.analyser.fftSize);

      // 低频保护滤波器 (Biquad Filter)
      this.bassFilter = ctx.createBiquadFilter();
      this.bassFilter.type = 'lowshelf';
      this.bassFilter.frequency.value = 200; // 200Hz以下为低频
      this.bassFilter.gain.value = settings.bassBoost;

      this.applyCompressor();

      // 信号链: source → compressor → originalAnalyser (测压缩后原始) → gain → bassFilter → analyser (测输出) → destination
      // 原理: compressor固定处理,gain是我们要调整的,所以测量compressor之后/gain之前的响度作为"原始"
      this.sourceNode.connect(this.compressor);
      this.compressor.connect(this.originalAnalyser);
      this.originalAnalyser.connect(this.gainNode);
      this.gainNode.connect(this.bassFilter);
      this.bassFilter.connect(this.analyser);
      this.analyser.connect(ctx.destination);

      this.handleEmptied = () => this.resetGain();
      this.handleSeeked = () => this.resetIntegration();
      media.addEventListener('emptied', this.handleEmptied);
      media.addEventListener('seeked', this.handleSeeked);
      media.addEventListener('play', () => {
        try {
          if (ctx.state === 'suspended') {
            ctx.resume().catch((err) => {
              console.debug('[BiliVolume] AudioContext play resume failed:', err);
            });
          }
        } catch (err) {
          console.debug('[BiliVolume] Play event handler error:', err);
        }
      });

      this.tick = this.tick.bind(this);
      this.rafId = requestAnimationFrame(this.tick);
    }

    applyCompressor() {
      this.compressor.threshold.value = this.settings.compressorThreshold;
      this.compressor.knee.value = this.settings.compressorKnee;
      this.compressor.ratio.value = this.settings.compressorRatio;
      this.compressor.attack.value = this.settings.compressorAttack;
      this.compressor.release.value = this.settings.compressorRelease;
    }

    updateSettings(newSettings) {
      this.settings = newSettings;
      this.applyCompressor();
      this.bassFilter.gain.value = newSettings.bassBoost;
    }

    resetGain() {
      this.gainNode.gain.value = 1;
      this.resetIntegration();
    }

    resetIntegration() {
      // 用户跳转时重置积分历史和PID状态
      this.rmsHistory = [];
      this.originalRmsHistory = [];
      this.integratedRms = null;
      this.originalIntegratedRms = null;
      this.pidIntegral = 0;
      this.pidLastError = 0;
    }

    measureRms() {
      this.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i += 1) {
        const sample = this.buffer[i];
        sum += sample * sample;
      }
      return Math.sqrt(sum / this.buffer.length);
    }

    measureOriginalRms() {
      this.originalAnalyser.getFloatTimeDomainData(this.originalBuffer);
      let sum = 0;
      for (let i = 0; i < this.originalBuffer.length; i += 1) {
        const sample = this.originalBuffer[i];
        sum += sample * sample;
      }
      return Math.sqrt(sum / this.originalBuffer.length);
    }

    updateIntegratedRms(currentRms, originalRms) {
      // 过滤静音片段 (低于-60dB)
      if (currentRms > 0.001) {
        this.rmsHistory.push(currentRms);
        
        // 限制历史记录大小(滑动窗口)
        if (this.rmsHistory.length > this.maxHistorySize) {
          this.rmsHistory.shift();
        }
      }

      if (originalRms > 0.001) {
        this.originalRmsHistory.push(originalRms);
        
        if (this.originalRmsHistory.length > this.maxHistorySize) {
          this.originalRmsHistory.shift();
        }
      }

      // 计算积分RMS (能量平均后开方)
      if (this.rmsHistory.length > 0) {
        const sumSquares = this.rmsHistory.reduce((acc, rms) => acc + rms * rms, 0);
        this.integratedRms = Math.sqrt(sumSquares / this.rmsHistory.length);
      }

      if (this.originalRmsHistory.length > 0) {
        const sumSquares = this.originalRmsHistory.reduce((acc, rms) => acc + rms * rms, 0);
        this.originalIntegratedRms = Math.sqrt(sumSquares / this.originalRmsHistory.length);
      }
    }

    tick() {
      if (!document.contains(this.media)) {
        this.destroy();
        return;
      }

      // 始终测量原始和输出响度
      const currentRms = this.measureRms();
      const originalRms = this.measureOriginalRms();
      
      // 更新积分RMS
      this.updateIntegratedRms(currentRms, originalRms);

      if (settings.enabled && !this.media.muted && !this.media.paused && !this.media.ended) {
        // 等待足够样本后再启用PID控制
        if (this.originalRmsHistory.length >= 30 && this.originalIntegratedRms > 0.001) {
          // ===== PID控制器 =====
          // 基于原始积分响度计算所需增益
          const targetRms = settings.targetRms;
          const currentOriginalRms = this.originalIntegratedRms;
          
          // 计算理想增益 (不考虑限制)
          const idealGain = targetRms / currentOriginalRms;
          
          // 当前增益
          const currentGain = this.gainNode.gain.value;
          
          // 误差 = 理想增益 - 当前增益
          const error = idealGain - currentGain;
          
          // PID参数 (保守调参，避免震荡)
          const Kp = 0.15;  // 比例系数：响应速度
          const Ki = 0.005; // 积分系数：消除稳态误差
          const Kd = 0.08;  // 微分系数：抑制震荡
          
          // 积分项累积 (带抗饱和)
          this.pidIntegral += error;
          this.pidIntegral = clamp(this.pidIntegral, -5, 5); // 限制积分累积
          
          // 微分项 (误差变化率)
          const derivative = error - this.pidLastError;
          this.pidLastError = error;
          
          // PID输出
          const correction = Kp * error + Ki * this.pidIntegral + Kd * derivative;
          
          // 应用增益调整
          const nextGain = clamp(currentGain + correction, settings.minGain, settings.maxGain);
          this.gainNode.gain.value = nextGain;
          
          // 显示所有响度信息
          meterState = { 
            rms: currentRms, 
            integratedRms: this.integratedRms || currentRms,
            originalRms: originalRms,
            originalIntegratedRms: this.originalIntegratedRms || originalRms,
            gain: nextGain,
            sampleCount: this.rmsHistory.length
          };
        } else {
          // 样本不足，暂时不调整增益
          meterState = { 
            rms: currentRms, 
            integratedRms: this.integratedRms || currentRms,
            originalRms: originalRms,
            originalIntegratedRms: this.originalIntegratedRms || originalRms,
            gain: this.gainNode.gain.value,
            sampleCount: this.rmsHistory.length
          };
        }
      } else if (!settings.enabled) {
        this.gainNode.gain.value = 1.0;
        // 关闭时仍显示原始响度
        meterState = { 
          rms: originalRms,  // 关闭时输出=原始
          integratedRms: this.originalIntegratedRms || originalRms,
          originalRms: originalRms,
          originalIntegratedRms: this.originalIntegratedRms || originalRms,
          gain: 1,
          sampleCount: this.originalRmsHistory.length
        };
      }

      this.rafId = requestAnimationFrame(this.tick);
    }

    destroy() {
      cancelAnimationFrame(this.rafId);
      this.media.removeEventListener('emptied', this.handleEmptied);
      this.media.removeEventListener('seeked', this.handleSeeked);
      this.sourceNode.disconnect();
      this.originalAnalyser.disconnect();
      this.compressor.disconnect();
      this.gainNode.disconnect();
      this.bassFilter.disconnect();
      this.analyser.disconnect();
      delete this.media.dataset[DATASET_FLAG];
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // RMS 转 LUFS 近似计算 (用于显示)
  function rmsToLufs(rms) {
    if (rms <= 0.00001) return -70;
    return 20 * Math.log10(rms) - 0.691;
  }

  // LUFS 转 RMS (用于设置目标值)
  function lufsToRms(lufs) {
    return Math.pow(10, (lufs + 0.691) / 20);
  }

  function createPanel() {
    if (panelHost && document.contains(panelHost)) return panelHost;
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      panelHost = existing;
      return panelHost;
    }

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '120px';
    host.style.zIndex = '2147483647';
    host.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    host.style.display = 'none';
    document.documentElement.appendChild(host);

    panelHost = host;

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
      }
      .panel {
        min-width: 220px;
        background: rgba(15, 15, 15, 0.9);
        color: #f5f5f5;
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(8px);
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      button.toggle {
        border: none;
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 12px;
        cursor: pointer;
        color: #fff;
      }
      button.toggle.on {
        background: #00b2ff;
      }
      button.toggle.off {
        background: #555;
      }
      label {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-top: 10px;
      }
      input[type='range'] {
        width: 100%;
      }
      .meter {
        margin-top: 10px;
        font-size: 12px;
        color: #c8c8c8;
      }
      .meter-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,0.1);
      }
      .meter-title {
        font-weight: 600;
        color: #fff;
        margin-bottom: 4px;
      }
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'panel';
    wrapper.innerHTML = `
      <div class="header">
        <span>音量均衡</span>
        <button class="toggle">···</button>
      </div>
      <label>
        <span>目标响度 (LUFS)</span>
        <span data-field="targetLufs">${rmsToLufs(settings.targetRms).toFixed(1)}</span>
      </label>
      <input type="range" min="-23" max="-10" step="0.5" data-role="targetLufs" value="${rmsToLufs(settings.targetRms).toFixed(1)}">
      <label>
        <span>增益上限</span>
        <span data-field="maxGain">${settings.maxGain.toFixed(1)}x</span>
      </label>
      <input type="range" min="1" max="3" step="0.1" data-role="maxGain" value="${settings.maxGain}">
      <label>
        <span>增益下限</span>
        <span data-field="minGain">${settings.minGain.toFixed(1)}x</span>
      </label>
      <input type="range" min="0.2" max="1" step="0.05" data-role="minGain" value="${settings.minGain}">
      <label>
        <span>低频增益</span>
        <span data-field="bassBoost">${settings.bassBoost > 0 ? '+' : ''}${settings.bassBoost.toFixed(1)} dB</span>
      </label>
      <input type="range" min="-6" max="6" step="0.5" data-role="bassBoost" value="${settings.bassBoost}">
      <div class="meter">
        <div class="meter-title">原始响度 (压缩后)</div>
        <div>积分: <span data-field="meterOriginalIntegratedLufs">-∞</span> LUFS <span style="color:#888;" data-field="sampleCount">(0样本)</span></div>
        <div>瞬时: <span data-field="meterOriginalLufs">-∞</span> LUFS</div>
        
        <div class="meter-section">
          <div class="meter-title">输出响度</div>
          <div>积分: <span data-field="meterIntegratedLufs">-∞</span> LUFS</div>
          <div>瞬时: <span data-field="meterLufs">-∞</span> LUFS</div>
          <div>增益: <span data-field="meterGain">1.00x</span></div>
        </div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(wrapper);

    const toggleBtn = shadow.querySelector('button.toggle');
    const sliders = shadow.querySelectorAll('input[type="range"]');
    const fieldNodes = {
      targetLufs: shadow.querySelector('[data-field="targetLufs"]'),
      maxGain: shadow.querySelector('[data-field="maxGain"]'),
      minGain: shadow.querySelector('[data-field="minGain"]'),
      bassBoost: shadow.querySelector('[data-field="bassBoost"]'),
      meterOriginalIntegratedLufs: shadow.querySelector('[data-field="meterOriginalIntegratedLufs"]'),
      meterOriginalLufs: shadow.querySelector('[data-field="meterOriginalLufs"]'),
      meterIntegratedLufs: shadow.querySelector('[data-field="meterIntegratedLufs"]'),
      meterLufs: shadow.querySelector('[data-field="meterLufs"]'),
      meterGain: shadow.querySelector('[data-field="meterGain"]'),
      sampleCount: shadow.querySelector('[data-field="sampleCount"]')
    };

    const renderToggle = () => {
      if (settings.enabled) {
        toggleBtn.textContent = '已开启';
        toggleBtn.classList.add('on');
        toggleBtn.classList.remove('off');
      } else {
        toggleBtn.textContent = '已关闭';
        toggleBtn.classList.add('off');
        toggleBtn.classList.remove('on');
      }
    };

    toggleBtn.addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      persistSettings();
      renderToggle();
      if (!settings.enabled) {
        controllers.forEach((controller) => {
          controller.gainNode.gain.value = 1.0;
        });
        meterState = { 
          rms: 0, 
          integratedRms: 0, 
          originalRms: 0,
          originalIntegratedRms: 0,
          gain: 1, 
          sampleCount: 0 
        };
      }
    });

    sliders.forEach((slider) => {
      slider.addEventListener('input', (event) => {
        const { role } = event.target.dataset;
        const value = parseFloat(event.target.value);
        if (Number.isNaN(value)) return;
        
        // 如果是LUFS滑块,转换为RMS存储
        if (role === 'targetLufs') {
          settings.targetRms = lufsToRms(value);
        } else {
          settings[role] = value;
        }
        
        persistSettings();
        updateFieldText(role, value);
        controllers.forEach((controller) => controller.updateSettings(settings));
      });
    });

    function updateFieldText(role, value) {
      if (role === 'targetLufs') fieldNodes.targetLufs.textContent = value.toFixed(1);
      if (role === 'maxGain') fieldNodes.maxGain.textContent = `${value.toFixed(1)}x`;
      if (role === 'minGain') fieldNodes.minGain.textContent = `${value.toFixed(1)}x`;
      if (role === 'bassBoost') fieldNodes.bassBoost.textContent = `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
    }

    renderToggle();

    setInterval(() => {
      if (!document.contains(host)) return;
      const { rms, integratedRms, originalRms, originalIntegratedRms, gain, sampleCount } = meterState;
      
      const instantLufs = rmsToLufs(rms);
      const integratedLufs = rmsToLufs(integratedRms || rms);
      const originalInstantLufs = rmsToLufs(originalRms);
      const originalIntegratedLufs = rmsToLufs(originalIntegratedRms || originalRms);
      
      fieldNodes.meterOriginalLufs.textContent = originalInstantLufs > -70 ? originalInstantLufs.toFixed(1) : '-∞';
      fieldNodes.meterOriginalIntegratedLufs.textContent = originalIntegratedLufs > -70 ? originalIntegratedLufs.toFixed(1) : '-∞';
      fieldNodes.meterLufs.textContent = instantLufs > -70 ? instantLufs.toFixed(1) : '-∞';
      fieldNodes.meterIntegratedLufs.textContent = integratedLufs > -70 ? integratedLufs.toFixed(1) : '-∞';
      fieldNodes.meterGain.textContent = `${gain.toFixed(2)}x`;
      fieldNodes.sampleCount.textContent = `(${sampleCount || 0}样本)`;
    }, 400);

    return host;
  }
})();

