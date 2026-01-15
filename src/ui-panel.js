/**
 * UI 面板 - 创建和管理设置面板
 */

import { PANEL_ID, BRAND } from './config.js';
import { rmsToLufs, lufsToRms } from './lufs-calculator.js';

let panelHost = null;

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
    right: 16px;
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
  wrapper.className = 'panel';
  wrapper.innerHTML = getPanelHTML(settings);
  shadow.appendChild(wrapper);

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
}

/**
 * 获取面板 HTML
 * @param {Object} settings - 当前设置
 * @returns {string} HTML 字符串
 */
function getPanelHTML(settings) {
  return `
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
      <div class="meter-title">原始响度</div>
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
}

/**
 * 绑定面板事件
 * @param {ShadowRoot} shadow - Shadow DOM 根节点
 * @param {Object} settings - 当前设置
 * @param {Function} onSettingsChange - 设置改变回调
 */
function bindPanelEvents(shadow, settings, onSettingsChange) {
  const toggleBtn = shadow.querySelector('button.toggle');
  const sliders = shadow.querySelectorAll('input[type="range"]');
  const fieldNodes = getFieldNodes(shadow);

  // 渲染开关状态
  const renderToggle = () => {
    if (settings.enabled) {
      toggleBtn.textContent = '已开启';
      toggleBtn.className = 'toggle on';
    } else {
      toggleBtn.textContent = '已关闭';
      toggleBtn.className = 'toggle off';
    }
  };
  renderToggle();

  // 开关按钮
  toggleBtn.addEventListener('click', () => {
    settings.enabled = !settings.enabled;
    onSettingsChange(settings);
    renderToggle();
  });

  // 滑块事件
  sliders.forEach((slider) => {
    slider.addEventListener('input', (event) => {
      const { role } = event.target.dataset;
      const value = parseFloat(event.target.value);
      if (Number.isNaN(value)) return;

      // 如果是 LUFS 滑块，转换为 RMS 存储
      if (role === 'targetLufs') {
        settings.targetRms = lufsToRms(value);
      } else {
        settings[role] = value;
      }

      onSettingsChange(settings);
      updateFieldText(fieldNodes, role, value);
    });
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
  if (role === 'targetLufs') fieldNodes.targetLufs.textContent = value.toFixed(1);
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
    fieldNodes.sampleCount.textContent = `(${sampleCount}样本)`;
  }, 100);
}
