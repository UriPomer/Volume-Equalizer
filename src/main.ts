/**
 * 主入口文件 - 协调各模块
 */

import { BRAND, DEFAULT_SETTINGS, Settings } from './config';
import { isAudioContextSupported, installGlobalResumeHandlers } from './audio-context';
import { loadSettings, persistSettings } from './settings';
import { MediaVolumeController } from './controller';
import { scanForMedia, observeMutations } from './media-scanner';
import { ensurePanel, updatePanelVisibility } from './ui-panel';
import { eventBus, EVENTS } from './events/index';

// 检查浏览器支持
if (!isAudioContextSupported()) {
  console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
  throw new Error('AudioContext not supported');
}

// 全局状态
let settings: Settings = { ...DEFAULT_SETTINGS };
let meterState = { rms: 0, gain: 1 };
const controllers = new Map<HTMLMediaElement, MediaVolumeController>();

// 初始化
console.debug(`${BRAND} 初始化: 在任意媒体元素上执行音量均衡`);
installGlobalResumeHandlers();

// 加载设置并启动
loadSettings()
  .then((loaded) => {
    settings = { ...DEFAULT_SETTINGS, ...loaded };
    startScanning();
  })
  .catch((err) => {
    console.error(`${BRAND} 设置加载失败`, err);
    startScanning();
  });

/**
 * 启动媒体元素扫描
 */
function startScanning(): void {
  const scanCallback = () => {
    scanForMedia(
      (media) => attachController(media),
      () => cleanupControllers()
    );
  };

  scanCallback();
  observeMutations(scanCallback);
}

/**
 * 为媒体元素附加控制器
 */
function attachController(media: HTMLMediaElement): void {
  const controller = new MediaVolumeController(
    media,
    settings,
    (state) => {
      meterState = state;
    }
  );
  controllers.set(media, controller);
  updatePanelVisibility(controllers.size);
  ensurePanel(settings, handleSettingsChange, getMeterState);
}

/**
 * 清理已断开的控制器
 */
function cleanupControllers(): void {
  controllers.forEach((controller, media) => {
    if (!media.isConnected) {
      controller.destroy();
      controllers.delete(media);
    }
  });
  updatePanelVisibility(controllers.size);
}

/**
 * 设置改变处理
 */
function handleSettingsChange(newSettings: Settings): Settings {
  const changedField = newSettings._changedField || null;
  const cleanedSettings = { ...newSettings };
  delete cleanedSettings._changedField;

  settings = cleanedSettings;
  persistSettings(settings);

  controllers.forEach((controller) => {
    controller.updateSettings({ ...settings, _changedField: changedField });
  });

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

  eventBus.emit(EVENTS.SETTINGS_CHANGED, { settings, changedField });

  return settings;
}

/**
 * 获取当前 meter 状态
 */
function getMeterState() {
  return meterState;
}

// 创建 UI 面板（延迟创建，等待第一个媒体元素出现）
setTimeout(() => {
  if (controllers.size > 0) {
    ensurePanel(settings, handleSettingsChange, getMeterState);
  }
}, 1000);
