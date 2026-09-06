import { PANEL_ID, Settings } from './config';
import { lufsToRms, rmsToLufs } from './lufs-calculator';
import { AnalysisStatus, MeterState } from './types';

type SliderRole = 'targetLufs' | 'maxGain' | 'minGain' | 'bassBoost';
type ChangeSettings = (settings: Settings) => Settings;

const STATUS_TEXT: Record<AnalysisStatus, string> = {
  realtime: '实时',
  'waiting-metadata': '等待视频元数据',
  'waiting-play': '等待播放后分析',
  'attach-failed': '媒体被页面占用',
  analyzing: '完整音轨分析中',
  'full-track': '完整音轨已锁定',
  incomplete: '音轨不完整 · 实时继续',
  unsupported: '直播不支持完整分析',
  'processor-unavailable': '保护不可用 · 已静音',
  failed: '分析失败 · 实时继续'
};

let host: HTMLElement | null = null;
let meterTimer: number | null = null;
let currentSettings: Settings | null = null;
let renderPanel: (() => void) | null = null;

/**
 * 外部（其他标签页/设置加载）修改设置后刷新面板 UI，
 * 避免开关与滑条停留在旧值直到用户手动交互。
 */
export function refreshPanel(next: Settings): void {
  if (!host?.isConnected || !renderPanel) return;
  currentSettings = next;
  renderPanel();
}

export function ensurePanel(
  settings: Settings,
  changeSettings: ChangeSettings,
  getMeter: () => MeterState
): HTMLElement {
  if (host?.isConnected) return host;
  if (meterTimer !== null) window.clearInterval(meterTimer);
  host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = 'position:fixed;right:0;bottom:120px;z-index:2147483647;display:none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${PANEL_CSS}</style>${panelHtml(settings)}`;
  bindPanel(shadow, settings, changeSettings);
  updateMeter(shadow, getMeter);
  return host;
}

export function updatePanelVisibility(controllerCount: number): void {
  if (host) host.style.display = controllerCount ? 'block' : 'none';
}

function panelHtml(settings: Settings): string {
  const target = rmsToLufs(settings.targetRms);
  return `<div class="wrap">
    <div class="dock"><i></i><b>EQ</b></div>
    <section>
      <header><strong>音量均衡</strong><button data-action="enabled"></button></header>
      <hr>
      <label class="mode">完整音轨预分析<button data-action="fullAudioAnalysis"></button></label>
      ${slider('targetLufs', '目标响度', -23, -10, .5, target)}
      ${slider('maxGain', '增益上限', 1, 3, .1, settings.maxGain)}
      ${slider('minGain', '增益下限', .2, 1, .05, settings.minGain)}
      ${slider('bassBoost', '低频增益', -6, 6, .5, settings.bassBoost)}
      <hr>
      <div class="meter">
        <small>原始</small>
        ${meterRow('积分', 'originalIntegrated', ' LUFS')} ${meterRow('瞬时', 'original', ' LUFS')}
        <small>输出</small>
        ${meterRow('积分', 'outputIntegrated', ' LUFS')} ${meterRow('瞬时', 'output', ' LUFS')}
        ${meterRow('增益', 'gain')} ${meterRow('算法', 'status')}
        ${meterRow('安全衰减', 'safety')}
      </div>
    </section>
  </div>`;
}

function slider(
  role: SliderRole,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number
): string {
  return `<label class="param"><span>${label}<b data-value="${role}"></b></span>
    <input data-role="${role}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
  </label>`;
}

function meterRow(label: string, field: string, suffix = ''): string {
  return `<div><span>${label}</span><b data-meter="${field}">-∞${suffix}</b></div>`;
}

function bindPanel(shadow: ShadowRoot, initial: Settings, change: ChangeSettings): void {
  currentSettings = initial;
  const enabled = query<HTMLButtonElement>(shadow, '[data-action="enabled"]');
  const full = query<HTMLButtonElement>(shadow, '[data-action="fullAudioAnalysis"]');
  const sliders = [...shadow.querySelectorAll<HTMLInputElement>('input[data-role]')];

  const render = () => {
    const settings = currentSettings as Settings;
    enabled.textContent = settings.enabled ? '已开启' : '已关闭';
    enabled.classList.toggle('on', settings.enabled);
    full.textContent = settings.fullAudioAnalysis ? '已开启' : '实时模式';
    full.classList.toggle('on', settings.fullAudioAnalysis);
    query<HTMLElement>(shadow, '.dock i').classList.toggle('off', !settings.enabled);
    for (const input of sliders) {
      const role = input.dataset.role as SliderRole;
      const value = role === 'targetLufs' ? rmsToLufs(settings.targetRms) : settings[role];
      input.value = String(value);
      setText(shadow, `[data-value="${role}"]`, formatValue(role, value));
    }
  };

  enabled.onclick = () => {
    const base = currentSettings as Settings;
    currentSettings = change({ ...base, enabled: !base.enabled });
    render();
  };
  full.onclick = () => {
    const base = currentSettings as Settings;
    currentSettings = change({
      ...base,
      fullAudioAnalysis: !base.fullAudioAnalysis
    });
    render();
  };
  for (const input of sliders) {
    input.oninput = () => {
      const role = input.dataset.role as SliderRole;
      const value = Number(input.value);
      const base = currentSettings as Settings;
      currentSettings = change({
        ...base,
        ...(role === 'targetLufs' ? { targetRms: lufsToRms(value) } : { [role]: value })
      });
      setText(shadow, `[data-value="${role}"]`, formatValue(role, value));
    };
  }
  renderPanel = render;

  const wrapper = query<HTMLElement>(shadow, '.wrap');
  let closeTimer = 0;
  query<HTMLElement>(shadow, '.dock').onmouseenter = () => {
    clearTimeout(closeTimer);
    host?.setAttribute('data-open', '');
  };
  wrapper.onmouseenter = () => clearTimeout(closeTimer);
  wrapper.onmouseleave = () => {
    closeTimer = window.setTimeout(() => host?.removeAttribute('data-open'), 250);
  };
  render();
}

function updateMeter(shadow: ShadowRoot, getMeter: () => MeterState): void {
  const showLufs = (rms: number) => {
    const lufs = rmsToLufs(rms);
    return `${lufs > -70 ? lufs.toFixed(1) : '-∞'} LUFS`;
  };
  const showMomentary = (lufs: number) => Number.isNaN(lufs)
    ? '测量中' : `${Number.isFinite(lufs) ? lufs.toFixed(1) : '-∞'} LUFS`;
  meterTimer = window.setInterval(() => {
    if (!host?.isConnected) return;
    const meter = getMeter();
    setText(shadow, '[data-meter="original"]', showMomentary(meter.originalMomentaryLufs));
    setText(shadow, '[data-meter="originalIntegrated"]', `${showLufs(meter.originalIntegratedRms)} · ${meter.sampleCount}s`);
    setText(shadow, '[data-meter="output"]', showMomentary(meter.momentaryLufs));
    setText(shadow, '[data-meter="safety"]', `${meter.safetyGain.toFixed(2)}x`);
    setText(shadow, '[data-meter="outputIntegrated"]', showLufs(meter.integratedRms || meter.rms));
    setText(shadow, '[data-meter="gain"]', `${meter.gain.toFixed(2)}x`);
    setText(shadow, '[data-meter="status"]', STATUS_TEXT[meter.analysisStatus]);
  }, 100);
}

function formatValue(role: SliderRole, value: number): string {
  if (role === 'targetLufs') return `${value.toFixed(1)} LUFS`;
  if (role === 'bassBoost') return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  return `${value.toFixed(2)}x`;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  return root.querySelector<T>(selector)!;
}

function setText(root: ParentNode, selector: string, value: string): void {
  const node = root.querySelector<HTMLElement>(selector);
  if (node) node.textContent = value;
}

const PANEL_CSS = `
:host{all:initial;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{display:flex;align-items:flex-end;transform:translateX(220px);transition:.25s;pointer-events:none}
:host([data-open]) .wrap{transform:none}
.dock,section{background:rgba(12,12,14,.55);backdrop-filter:blur(18px);border:1px solid #ffffff20;color:#f8fafc;pointer-events:auto}
.dock{width:26px;height:72px;border-radius:10px 0 0 10px;border-right:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;cursor:pointer}
.dock i{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80}.dock i.off{background:#ffffff50;box-shadow:none}
.dock b{font-size:11px;writing-mode:vertical-rl;letter-spacing:.5px}
section{width:220px;box-sizing:border-box;padding:12px;border-radius:14px 0 0 0;border-right:0;opacity:0;transition:.2s}
:host([data-open]) section{opacity:1}
header,.mode,.param span,.meter div{display:flex;align-items:center;justify-content:space-between}
header{font-size:13px}button{border:0;border-radius:99px;padding:3px 9px;background:#ffffff18;color:#ffffff90;cursor:pointer;font-size:10px}button.on{background:#0ea5e9;color:white}
hr{border:0;height:1px;background:#ffffff12;margin:9px 0}.mode,.param{display:block;color:#ffffff90;font-size:11px}.mode{display:flex;margin:9px 0}
.param{margin-top:8px}.param span b{color:#e2e8f0;font-size:12px}input{appearance:none;width:100%;height:3px;background:#ffffff20;border-radius:2px;cursor:pointer}input::-webkit-slider-thumb{appearance:none;width:13px;height:13px;border-radius:50%;background:#38bdf8}
.meter{font-size:11px}.meter small{display:block;color:#ffffff50;font-weight:600;margin-top:6px}.meter div{padding:2px 0}.meter span{color:#ffffff60}.meter b{color:#cbd5e1;font-weight:500;font-variant-numeric:tabular-nums;text-align:right}
`;
