/**
 * 主入口文件 - 协调各模块
 */

import { BRAND, DEFAULT_SETTINGS } from './config.js';
import { isAudioContextSupported, installGlobalResumeHandlers } from './audio-context.js';
import { loadSettings, persistSettings } from './settings.js';
import { MediaVolumeController } from './controller.js';
import { scanForMedia, observeMutations } from './media-scanner.js';
import { ensurePanel, updatePanelVisibility } from './ui-panel.js';

import { eventBus, EVENTS } from './events/index.js';


// 检查浏览器支持
if (!isAudioContextSupported()) {
  console.warn(`${BRAND} 当前浏览器不支持 AudioContext, 扩展已停用`);
  throw new Error('AudioContext not supported');
}

// 全局状态
let settings = { ...DEFAULT_SETTINGS };
let meterState = { rms: 0, gain: 1 };
const controllers = new Map();

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
function startScanning() {
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
 * @param {HTMLMediaElement} media - 媒体元素
 */
function attachController(media) {
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
function cleanupControllers() {
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
 * @param {Object} newSettings - 新的设置
 * @returns {Object} 更新后的设置
 */
function handleSettingsChange(newSettings) {
  const changedField = newSettings._changedField || null;
  const cleanedSettings = { ...newSettings };
  delete cleanedSettings._changedField;

  settings = cleanedSettings;
  persistSettings(settings);
  
  controllers.forEach((controller) => {
    controller.updateSettings({ ...settings, _changedField: changedField });
  });

  // 如果关闭功能，重置所有增益
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
 * @returns {Object} meter 状态
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
