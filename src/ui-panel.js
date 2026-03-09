/**
 * UI 面板 - 创建和管理设置面板
 */

import { PANEL_ID } from './config.js';

import { rmsToLufs, lufsToRms } from './lufs-calculator.js';
import { eventBus, EVENTS } from './events/index.js';


let panelHost = null;
let settingsChangedOff = null;


/**
 * 创建设置面板
 * @param {Object} settings - 当前设置
 * @param {Function} onSettingsChange - 设置改变回调
 * @param {Function} getMeterState - 获取 meter 状态的回调
 * @returns {HTMLElement} 面板元素
 */
export function createPanel(settings, onSettingsChange, getMeterState) {
  if (panelHost && document.contains(panelHost)) return panelHost;
  
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    panelHost = existing;
    return panelHost;
  }

  // 创建主容器
  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = `
    position: fixed;
    right: 0;
    bottom: 120px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: none;
  `;
  document.documentElement.appendChild(host);
  panelHost = host;

  // 创建 Shadow DOM
  const shadow = host.attachShadow({ mode: 'open' });
  
  // 添加样式
  const style = document.createElement('style');
  style.textContent = getPanelStyles();
  shadow.appendChild(style);

  // 创建面板内容
  const wrapper = document.createElement('div');
  wrapper.innerHTML = getPanelHTML(settings);
  shadow.appendChild(wrapper.firstElementChild);

  // 绑定事件监听器
  bindPanelEvents(shadow, settings, onSettingsChange);

  // 启动 meter 更新循环
  startMeterUpdateLoop(shadow, getMeterState);

  return host;
}

/**
 * 确保面板存在
 * @param {Object} settings - 当前设置
 * @param {Function} onSettingsChange - 设置改变回调
 * @param {Function} getMeterState - 获取 meter 状态的回调
 * @returns {HTMLElement} 面板元素
 */
export function ensurePanel(settings, onSettingsChange, getMeterState) {
  if (panelHost && document.contains(panelHost)) {
    return panelHost;
  }
  panelHost = null;
  return createPanel(settings, onSettingsChange, getMeterState);
}

/**
 * 更新面板可见性
 * @param {number} controllerCount - 控制器数量
 */
export function updatePanelVisibility(controllerCount) {
  if (controllerCount === 0) {
    if (panelHost && document.contains(panelHost)) {
      panelHost.style.display = 'none';
    }
    return;
  }
  if (panelHost) {
    panelHost.style.display = 'block';
  }
}

/**
 * 获取面板样式
 * @returns {string} CSS 样式
 */
function getPanelStyles() {
  return `
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
  `;
}

/**
 * 获取面板 HTML
 * @param {Object} settings - 当前设置
 * @returns {string} HTML 字符串
 */
function getPanelHTML(settings) {
  const targetLufs = rmsToLufs(settings.targetRms).toFixed(1);
  const bassSign = settings.bassBoost > 0 ? '+' : '';
  return `
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
            <span data-field="targetLufs">${targetLufs} LUFS</span>
          </div>
          <input type="range" min="-23" max="-10" step="0.5" data-role="targetLufs" value="${targetLufs}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>增益上限</span>
            <span data-field="maxGain">${settings.maxGain.toFixed(1)}x</span>
          </div>
          <input type="range" min="1" max="3" step="0.1" data-role="maxGain" value="${settings.maxGain}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>增益下限</span>
            <span data-field="minGain">${settings.minGain.toFixed(1)}x</span>
          </div>
          <input type="range" min="0.2" max="1" step="0.05" data-role="minGain" value="${settings.minGain}">
        </div>

        <div class="param-row">
          <div class="param-label">
            <span>低频增益</span>
            <span data-field="bassBoost">${bassSign}${settings.bassBoost.toFixed(1)} dB</span>
          </div>
          <input type="range" min="-6" max="6" step="0.5" data-role="bassBoost" value="${settings.bassBoost}">
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
  `;
}

/**
 * 绑定面板事件
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @param {Object} initialSettings - 初始设置（会被更新）
 * @param {Function} onSettingsChange - 设置改变回调，返回更新后的设置
 */
function bindPanelEvents(shadow, initialSettings, onSettingsChange) {
  const toggleBtn = shadow.querySelector('button.toggle-pill');
  const dockDot = shadow.querySelector('.dock-dot');
  const sliders = shadow.querySelectorAll('input[type="range"]');
  const fieldNodes = getFieldNodes(shadow);
  const sliderMap = new Map([...sliders].map((slider) => [slider.dataset.role, slider]));

  let currentSettings = initialSettings;

  const renderToggle = () => {
    if (currentSettings.enabled) {
      toggleBtn.textContent = '已开启';
      toggleBtn.className = 'toggle-pill on';
      dockDot.className = 'dock-dot';
    } else {
      toggleBtn.textContent = '已关闭';
      toggleBtn.className = 'toggle-pill off';
      dockDot.className = 'dock-dot off';
    }
  };

  const applySettingsToUI = (settings) => {
    const targetLufs = rmsToLufs(settings.targetRms);
    const targetSlider = sliderMap.get('targetLufs');
    if (targetSlider) targetSlider.value = targetLufs;
    updateFieldText(fieldNodes, 'targetLufs', targetLufs);

    const maxGainSlider = sliderMap.get('maxGain');
    if (maxGainSlider) maxGainSlider.value = settings.maxGain;
    updateFieldText(fieldNodes, 'maxGain', settings.maxGain);

    const minGainSlider = sliderMap.get('minGain');
    if (minGainSlider) minGainSlider.value = settings.minGain;
    updateFieldText(fieldNodes, 'minGain', settings.minGain);

    const bassBoostSlider = sliderMap.get('bassBoost');
    if (bassBoostSlider) bassBoostSlider.value = settings.bassBoost;
    updateFieldText(fieldNodes, 'bassBoost', settings.bassBoost);

    renderToggle();
  };

  applySettingsToUI(currentSettings);


  // 开关按钮
  toggleBtn.addEventListener('click', () => {
    const newSettings = { ...currentSettings, enabled: !currentSettings.enabled };
    currentSettings = onSettingsChange(newSettings) || newSettings;
    renderToggle();
    toggleBtn.blur();
  });

  // 滑块事件
  sliders.forEach((slider) => {
    slider.addEventListener('input', (event) => {
      const { role } = event.target.dataset;
      const value = parseFloat(event.target.value);
      if (Number.isNaN(value)) return;

      // 基于当前最新设置创建新对象
      const newSettings = { ...currentSettings };
      newSettings._changedField = role;  // 标记是哪个字段改变了
      
      // 如果是 LUFS 滑块，转换为 RMS 存储
      if (role === 'targetLufs') {
        newSettings.targetRms = lufsToRms(value);
      } else {
        newSettings[role] = value;
      }

      currentSettings = onSettingsChange(newSettings) || newSettings;
      updateFieldText(fieldNodes, role, value);
    });
    slider.addEventListener('change', (event) => {
      event.target.blur();
    });
  });

  // Hover 展开/收起逻辑，带延迟防止误触
  let expandTimer = null;
  let collapseTimer = null;
  const host = panelHost;
  const dock = shadow.querySelector('.dock');
  const panelWrapper = shadow.querySelector('.panel-wrapper');

  const startExpand = () => {
    clearTimeout(collapseTimer);
    collapseTimer = null;
    if (!host.hasAttribute('data-expanded')) {
      expandTimer = setTimeout(() => {
        host.setAttribute('data-expanded', '');
      }, 80);
    }
  };

  const startCollapse = () => {
    clearTimeout(expandTimer);
    expandTimer = null;
    collapseTimer = setTimeout(() => {
      host.removeAttribute('data-expanded');
    }, 300);
  };

  // dock 触发展开
  dock.addEventListener('mouseenter', startExpand);

  // 整个 wrapper（卡片+dock）离开才收起
  panelWrapper.addEventListener('mouseleave', startCollapse);
  // 进入 wrapper 任何子元素都取消收起
  panelWrapper.addEventListener('mouseenter', () => {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  });

  if (settingsChangedOff) settingsChangedOff();
  settingsChangedOff = eventBus.on(EVENTS.SETTINGS_CHANGED, ({ settings: nextSettings }) => {
    if (!panelHost || !document.contains(panelHost)) return;
    currentSettings = nextSettings;
    applySettingsToUI(currentSettings);
  });
}



/**
 * 获取字段节点
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @returns {Object} 字段节点映射
 */
function getFieldNodes(shadow) {
  return {
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
}

/**
 * 更新字段文本
 * @param {Object} fieldNodes - 字段节点映射
 * @param {string} role - 字段角色
 * @param {number} value - 值
 */
function updateFieldText(fieldNodes, role, value) {
  if (role === 'targetLufs') fieldNodes.targetLufs.textContent = `${value.toFixed(1)} LUFS`;
  if (role === 'maxGain') fieldNodes.maxGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'minGain') fieldNodes.minGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'bassBoost') fieldNodes.bassBoost.textContent = `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

/**
 * 启动 meter 更新循环
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @param {Function} getMeterState - 获取 meter 状态的回调
 */
function startMeterUpdateLoop(shadow, getMeterState) {
  const fieldNodes = getFieldNodes(shadow);

  setInterval(() => {
    if (!document.contains(panelHost)) return;
    
    const meterState = getMeterState();
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
    fieldNodes.sampleCount.textContent = `${sampleCount}s`;
  }, 100);
}
