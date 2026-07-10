/**
 * UI 面板 - 创建和管理设置面板
 */

import { PANEL_ID, Settings } from './config';
import { rmsToLufs, lufsToRms } from './lufs-calculator';
import { eventBus, EVENTS } from './events/index';

interface FieldNodes {
  targetLufs: HTMLElement | null;
  maxGain: HTMLElement | null;
  minGain: HTMLElement | null;
  bassBoost: HTMLElement | null;
  meterOriginalIntegratedLufs: HTMLElement | null;
  meterOriginalLufs: HTMLElement | null;
  meterIntegratedLufs: HTMLElement | null;
  meterLufs: HTMLElement | null;
  meterGain: HTMLElement | null;
  sampleCount: HTMLElement | null;
  analysisStatus: HTMLElement | null;
}

interface MeterState {
  rms: number;
  integratedRms: number;
  originalRms: number;
  originalIntegratedRms: number;
  gain: number;
  sampleCount: number;
  analysisStatus: 'realtime' | 'analyzing' | 'full-track' | 'fallback';
}

let panelHost: HTMLElement | null = null;
let settingsChangedOff: (() => void) | null = null;

/**
 * 创建设置面板
 */
export function createPanel(
  settings: Settings,
  onSettingsChange: (s: Settings) => Settings,
  getMeterState: () => MeterState
): HTMLElement {
  if (panelHost && document.contains(panelHost)) return panelHost;

  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    panelHost = existing;
    return panelHost;
  }

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

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = getPanelStyles();
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = getPanelHTML(settings);
  shadow.appendChild(wrapper.firstElementChild!);

  bindPanelEvents(shadow, settings, onSettingsChange);
  startMeterUpdateLoop(shadow, getMeterState);

  return host;
}

/**
 * 确保面板存在
 */
export function ensurePanel(
  settings: Settings,
  onSettingsChange: (s: Settings) => Settings,
  getMeterState: () => MeterState
): HTMLElement {
  if (panelHost && document.contains(panelHost)) {
    return panelHost;
  }
  panelHost = null;
  return createPanel(settings, onSettingsChange, getMeterState);
}

/**
 * 更新面板可见性
 */
export function updatePanelVisibility(controllerCount: number): void {
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
 */
function getPanelStyles(): string {
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
  `;
}

/**
 * 获取面板 HTML
 */
function getPanelHTML(settings: Settings): string {
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

        <div class="mode-row">
          <span>完整音轨预分析</span>
          <button class="mode-button" data-role="fullAudioAnalysis"></button>
        </div>

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
          <div class="meter-row">
            <span class="label">算法</span>
            <span class="val" data-field="analysisStatus">实时</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * 绑定面板事件
 */
function bindPanelEvents(
  shadow: ShadowRoot,
  initialSettings: Settings,
  onSettingsChange: (s: Settings) => Settings
): void {
  const toggleBtn = shadow.querySelector<HTMLButtonElement>('button.toggle-pill')!;
  const dockDot = shadow.querySelector<HTMLElement>('.dock-dot')!;
  const sliders = shadow.querySelectorAll<HTMLInputElement>('input[type="range"]');
  const fieldNodes = getFieldNodes(shadow);
  const sliderMap = new Map([...sliders].map((slider) => [slider.dataset.role, slider]));
  const analysisModeButton = shadow.querySelector<HTMLButtonElement>('[data-role="fullAudioAnalysis"]')!;

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

  const renderAnalysisMode = () => {
    analysisModeButton.textContent = currentSettings.fullAudioAnalysis ? '已开启' : '实时模式';
    analysisModeButton.className = currentSettings.fullAudioAnalysis ? 'mode-button on' : 'mode-button';
  };

  const applySettingsToUI = (settings: Settings) => {
    const targetLufs = rmsToLufs(settings.targetRms);
    const targetSlider = sliderMap.get('targetLufs');
    if (targetSlider) targetSlider.value = String(targetLufs);
    updateFieldText(fieldNodes, 'targetLufs', targetLufs);

    const maxGainSlider = sliderMap.get('maxGain');
    if (maxGainSlider) maxGainSlider.value = String(settings.maxGain);
    updateFieldText(fieldNodes, 'maxGain', settings.maxGain);

    const minGainSlider = sliderMap.get('minGain');
    if (minGainSlider) minGainSlider.value = String(settings.minGain);
    updateFieldText(fieldNodes, 'minGain', settings.minGain);

    const bassBoostSlider = sliderMap.get('bassBoost');
    if (bassBoostSlider) bassBoostSlider.value = String(settings.bassBoost);
    updateFieldText(fieldNodes, 'bassBoost', settings.bassBoost);

    renderToggle();
    renderAnalysisMode();
  };

  applySettingsToUI(currentSettings);

  toggleBtn.addEventListener('click', () => {
    const newSettings = { ...currentSettings, enabled: !currentSettings.enabled };
    currentSettings = onSettingsChange(newSettings) || newSettings;
    renderToggle();
    toggleBtn.blur();
  });

  analysisModeButton.addEventListener('click', () => {
    const newSettings = {
      ...currentSettings,
      fullAudioAnalysis: !currentSettings.fullAudioAnalysis,
      _changedField: 'fullAudioAnalysis'
    };
    currentSettings = onSettingsChange(newSettings) || newSettings;
    renderAnalysisMode();
    analysisModeButton.blur();
  });

  sliders.forEach((slider) => {
    slider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const role = target.dataset.role!;
      const value = parseFloat(target.value);
      if (Number.isNaN(value)) return;

      const newSettings = { ...currentSettings } as Settings;
      newSettings._changedField = role;

      if (role === 'targetLufs') {
        newSettings.targetRms = lufsToRms(value);
      } else {
        (newSettings as any)[role] = value;
      }

      currentSettings = onSettingsChange(newSettings) || newSettings;
      updateFieldText(fieldNodes, role, value);
    });
    slider.addEventListener('change', (event) => {
      (event.target as HTMLInputElement).blur();
    });
  });

  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  const host = panelHost!;
  const dock = shadow.querySelector<HTMLElement>('.dock')!;
  const panelWrapper = shadow.querySelector<HTMLElement>('.panel-wrapper')!;

  const startExpand = () => {
    clearTimeout(collapseTimer!);
    collapseTimer = null;
    if (!host.hasAttribute('data-expanded')) {
      expandTimer = setTimeout(() => {
        host.setAttribute('data-expanded', '');
      }, 80);
    }
  };

  const startCollapse = () => {
    clearTimeout(expandTimer!);
    expandTimer = null;
    collapseTimer = setTimeout(() => {
      host.removeAttribute('data-expanded');
    }, 300);
  };

  dock.addEventListener('mouseenter', startExpand);
  panelWrapper.addEventListener('mouseleave', startCollapse);
  panelWrapper.addEventListener('mouseenter', () => {
    clearTimeout(collapseTimer!);
    collapseTimer = null;
  });

  if (settingsChangedOff) settingsChangedOff();
  settingsChangedOff = eventBus.on(EVENTS.SETTINGS_CHANGED, (payload) => {
    const { settings: nextSettings } = payload as { settings: Settings };
    if (!panelHost || !document.contains(panelHost)) return;
    currentSettings = nextSettings;
    applySettingsToUI(currentSettings);
  });
}

/**
 * 获取字段节点
 */
function getFieldNodes(shadow: ShadowRoot): FieldNodes {
  return {
    targetLufs: shadow.querySelector<HTMLElement>('[data-field="targetLufs"]'),
    maxGain: shadow.querySelector<HTMLElement>('[data-field="maxGain"]'),
    minGain: shadow.querySelector<HTMLElement>('[data-field="minGain"]'),
    bassBoost: shadow.querySelector<HTMLElement>('[data-field="bassBoost"]'),
    meterOriginalIntegratedLufs: shadow.querySelector<HTMLElement>('[data-field="meterOriginalIntegratedLufs"]'),
    meterOriginalLufs: shadow.querySelector<HTMLElement>('[data-field="meterOriginalLufs"]'),
    meterIntegratedLufs: shadow.querySelector<HTMLElement>('[data-field="meterIntegratedLufs"]'),
    meterLufs: shadow.querySelector<HTMLElement>('[data-field="meterLufs"]'),
    meterGain: shadow.querySelector<HTMLElement>('[data-field="meterGain"]'),
    sampleCount: shadow.querySelector<HTMLElement>('[data-field="sampleCount"]'),
    analysisStatus: shadow.querySelector<HTMLElement>('[data-field="analysisStatus"]')
  };
}

/**
 * 更新字段文本
 */
function updateFieldText(fieldNodes: FieldNodes, role: string, value: number): void {
  if (role === 'targetLufs' && fieldNodes.targetLufs) fieldNodes.targetLufs.textContent = `${value.toFixed(1)} LUFS`;
  if (role === 'maxGain' && fieldNodes.maxGain) fieldNodes.maxGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'minGain' && fieldNodes.minGain) fieldNodes.minGain.textContent = `${value.toFixed(1)}x`;
  if (role === 'bassBoost' && fieldNodes.bassBoost) fieldNodes.bassBoost.textContent = `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

/**
 * 启动 meter 更新循环
 */
function startMeterUpdateLoop(shadow: ShadowRoot, getMeterState: () => MeterState): void {
  const fieldNodes = getFieldNodes(shadow);

  setInterval(() => {
    if (!document.contains(panelHost)) return;

    const meterState = getMeterState();
    const { rms, integratedRms, originalRms, originalIntegratedRms, gain, sampleCount, analysisStatus } = meterState;

    const instantLufs = rmsToLufs(rms);
    const integratedLufs = rmsToLufs(integratedRms || rms);
    const originalInstantLufs = rmsToLufs(originalRms);
    const originalIntegratedLufs = rmsToLufs(originalIntegratedRms || originalRms);

    if (fieldNodes.meterOriginalLufs) fieldNodes.meterOriginalLufs.textContent = originalInstantLufs > -70 ? originalInstantLufs.toFixed(1) : '-∞';
    if (fieldNodes.meterOriginalIntegratedLufs) fieldNodes.meterOriginalIntegratedLufs.textContent = originalIntegratedLufs > -70 ? originalIntegratedLufs.toFixed(1) : '-∞';
    if (fieldNodes.meterLufs) fieldNodes.meterLufs.textContent = instantLufs > -70 ? instantLufs.toFixed(1) : '-∞';
    if (fieldNodes.meterIntegratedLufs) fieldNodes.meterIntegratedLufs.textContent = integratedLufs > -70 ? integratedLufs.toFixed(1) : '-∞';
    if (fieldNodes.meterGain) fieldNodes.meterGain.textContent = `${gain.toFixed(2)}x`;
    if (fieldNodes.sampleCount) fieldNodes.sampleCount.textContent = `${sampleCount}s`;
    if (fieldNodes.analysisStatus) {
      fieldNodes.analysisStatus.textContent = {
        realtime: '实时',
        analyzing: '分析中',
        'full-track': '整段锁定',
        fallback: '实时回退'
      }[analysisStatus];
    }
  }, 100);
}
