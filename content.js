(() => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    console.warn('[Bili Volume EQ] 当前浏览器不支持 AudioContext, 扩展已停用');
    return;
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetRms: 0.18,
    minGain: 0.4,
    maxGain: 3.0,
    adaptationRate: 0.35,
    compressorThreshold: -28,
    compressorKnee: 24,
    compressorRatio: 4,
    compressorAttack: 0.002,
    compressorRelease: 0.25
  };

  let settings = { ...DEFAULT_SETTINGS };
  let meterState = { rms: 0, gain: 1 };
  const audioCtx = new AudioContextClass();
  const controllers = new Map();
  let panelElements = null;
  let scanScheduled = false;

  const storageSupported = typeof chrome !== 'undefined' && chrome?.storage?.local;

  loadSettings()
    .then((loaded) => {
      settings = { ...DEFAULT_SETTINGS, ...loaded };
      createPanel();
      installGlobalResumeHandlers();
      scanForVideos();
      observeMutations();
    })
    .catch((err) => {
      console.error('[Bili Volume EQ] 设置加载失败', err);
      createPanel();
      installGlobalResumeHandlers();
      scanForVideos();
      observeMutations();
    });

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
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    };
    ['pointerdown', 'keydown'].forEach((evt) => {
      document.addEventListener(evt, resume, { capture: true });
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
      scanForVideos();
    });
  }

  function scanForVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      if (!controllers.has(video) && video.readyState >= 1) {
        tryAttachController(video);
      }
    });

    controllers.forEach((controller, video) => {
      if (!video.isConnected) {
        controller.destroy();
        controllers.delete(video);
      }
    });
  }

  function tryAttachController(video) {
    if (video.dataset.biliVolumeEqAttached === '1') return;
    try {
      const controller = new VolumeController(video);
      controllers.set(video, controller);
      video.dataset.biliVolumeEqAttached = '1';
    } catch (error) {
      console.warn('[Bili Volume EQ] 无法绑定 video 元素', error);
    }
  }

  class VolumeController {
    constructor(video) {
      this.video = video;
      this.buffer = null;
      this.rafId = 0;
      this.settings = settings;

      this.sourceNode = audioCtx.createMediaElementSource(video);
      this.compressor = audioCtx.createDynamicsCompressor();
      this.gainNode = audioCtx.createGain();
      this.analyser = audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.buffer = new Float32Array(this.analyser.fftSize);

      this.applyCompressor();

      this.sourceNode.connect(this.compressor);
      this.compressor.connect(this.gainNode);
      this.gainNode.connect(this.analyser);
      this.analyser.connect(audioCtx.destination);

      this.handleEmptied = () => this.resetGain();
      video.addEventListener('emptied', this.handleEmptied);
      video.addEventListener('play', () => audioCtx.resume());

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
    }

    resetGain() {
      this.gainNode.gain.value = 1;
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

    tick() {
      if (!document.contains(this.video)) {
        this.destroy();
        return;
      }

      if (settings.enabled && !this.video.muted && !this.video.paused && !this.video.ended) {
        const rms = this.measureRms();
        const error = settings.targetRms - rms;
        const delta = error * settings.adaptationRate;
        const nextGain = clamp(this.gainNode.gain.value + delta, settings.minGain, settings.maxGain);
        this.gainNode.gain.value = nextGain;
        meterState = { rms, gain: nextGain };
      }

      this.rafId = requestAnimationFrame(this.tick);
    }

    destroy() {
      cancelAnimationFrame(this.rafId);
      this.video.removeEventListener('emptied', this.handleEmptied);
      this.sourceNode.disconnect();
      this.compressor.disconnect();
      this.gainNode.disconnect();
      this.analyser.disconnect();
      delete this.video.dataset.biliVolumeEqAttached;
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createPanel() {
    if (document.getElementById('bili-volume-eq-panel')) return;
    const host = document.createElement('div');
    host.id = 'bili-volume-eq-panel';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '120px';
    host.style.zIndex = '2147483647';
    host.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    document.documentElement.appendChild(host);

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
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'panel';
    wrapper.innerHTML = `
      <div class="header">
        <span>音量均衡</span>
        <button class="toggle">···</button>
      </div>
      <label>
        <span>目标响度</span>
        <span data-field="targetRms">${settings.targetRms.toFixed(2)}</span>
      </label>
      <input type="range" min="0.05" max="0.35" step="0.01" data-role="targetRms" value="${settings.targetRms}">
      <label>
        <span>增益上限</span>
        <span data-field="maxGain">${settings.maxGain.toFixed(1)}x</span>
      </label>
      <input type="range" min="1" max="5" step="0.1" data-role="maxGain" value="${settings.maxGain}">
      <label>
        <span>增益下限</span>
        <span data-field="minGain">${settings.minGain.toFixed(1)}x</span>
      </label>
      <input type="range" min="0.2" max="1" step="0.05" data-role="minGain" value="${settings.minGain}">
      <label>
        <span>响应速度</span>
        <span data-field="adaptationRate">${settings.adaptationRate.toFixed(2)}</span>
      </label>
      <input type="range" min="0.05" max="0.6" step="0.01" data-role="adaptationRate" value="${settings.adaptationRate}">
      <div class="meter">
        <div>RMS: <span data-field="meterRms">0.00</span></div>
        <div>Gain: <span data-field="meterGain">1.00x</span></div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(wrapper);

    const toggleBtn = shadow.querySelector('button.toggle');
    const sliders = shadow.querySelectorAll('input[type="range"]');
    const fieldNodes = {
      targetRms: shadow.querySelector('[data-field="targetRms"]'),
      maxGain: shadow.querySelector('[data-field="maxGain"]'),
      minGain: shadow.querySelector('[data-field="minGain"]'),
      adaptationRate: shadow.querySelector('[data-field="adaptationRate"]'),
      meterRms: shadow.querySelector('[data-field="meterRms"]'),
      meterGain: shadow.querySelector('[data-field="meterGain"]')
    };

    const renderToggle = () => {
      if (settings.enabled) {
        toggleBtn.textContent = '开启';
        toggleBtn.classList.add('on');
        toggleBtn.classList.remove('off');
      } else {
        toggleBtn.textContent = '关闭';
        toggleBtn.classList.add('off');
        toggleBtn.classList.remove('on');
      }
    };

    toggleBtn.addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      persistSettings();
      renderToggle();
    });

    sliders.forEach((slider) => {
      slider.addEventListener('input', (event) => {
        const { role } = event.target.dataset;
        const value = parseFloat(event.target.value);
        if (Number.isNaN(value)) return;
        settings[role] = value;
        persistSettings();
        updateFieldText(role, value);
        controllers.forEach((controller) => controller.updateSettings(settings));
      });
    });

    function updateFieldText(role, value) {
      if (role === 'targetRms') fieldNodes.targetRms.textContent = value.toFixed(2);
      if (role === 'maxGain') fieldNodes.maxGain.textContent = `${value.toFixed(1)}x`;
      if (role === 'minGain') fieldNodes.minGain.textContent = `${value.toFixed(1)}x`;
      if (role === 'adaptationRate') fieldNodes.adaptationRate.textContent = value.toFixed(2);
    }

    renderToggle();

    panelElements = { fieldNodes };

    setInterval(() => {
      const { rms, gain } = meterState;
      fieldNodes.meterRms.textContent = rms.toFixed(2);
      fieldNodes.meterGain.textContent = `${gain.toFixed(2)}x`;
    }, 400);
  }
})();
