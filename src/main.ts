import { installGlobalResumeHandlers, isAudioContextSupported } from './audio-context';
import { DEFAULT_SETTINGS, Settings } from './config';
import { MediaVolumeController } from './controller';
import { errorFailure, warnFailure } from './logger';
import { observeMutations, scanForMedia } from './media-scanner';
import {
  loadSettings,
  normalizeSettings,
  persistSettings,
  subscribeSettings
} from './settings';
import { EMPTY_METER_STATE } from './types';
import { ensurePanel, updatePanelVisibility } from './ui-panel';

if (!isAudioContextSupported()) {
  warnFailure('audio-context-unsupported', '当前浏览器不支持 AudioContext，扩展已停用');
  throw new Error('AudioContext not supported');
}

let settings = { ...DEFAULT_SETTINGS };
let meterState = { ...EMPTY_METER_STATE };
let activeMedia: HTMLMediaElement | null = null;
const controllers = new Map<HTMLMediaElement, MediaVolumeController>();

installGlobalResumeHandlers();
loadSettings().then((loaded) => {
  settings = normalizeSettings(loaded);
  start();
  subscribeSettings(applyExternalSettings);
}).catch((error) => {
  errorFailure('settings-load', '设置加载失败，使用默认设置', error);
  start();
  subscribeSettings(applyExternalSettings);
});

function start(): void {
  const scan = () => {
    scanForMedia(attachController);
    cleanupControllers();
  };
  scan();
  observeMutations(scan);
}

function attachController(media: HTMLMediaElement): void {
  if (controllers.has(media)) return;
  const controller = new MediaVolumeController(
    media,
    settings,
    (state) => {
      if (activeMedia === media || !activeMedia) {
        activeMedia = media;
        meterState = state;
      }
    },
    () => { activeMedia = media; }
  );
  controllers.set(media, controller);
  ensurePanel(settings, updateSettings, () => meterState);
  updatePanelVisibility(controllers.size);
}

function cleanupControllers(): void {
  for (const [media, controller] of controllers) {
    if (media.isConnected) continue;
    controller.destroy();
    controllers.delete(media);
    if (activeMedia === media) activeMedia = null;
  }
  updatePanelVisibility(controllers.size);
}

function updateSettings(next: Settings): Settings {
  applySettings(normalizeSettings(next));
  persistSettings(settings).catch((error) => {
    errorFailure('settings-save', '设置保存失败', error);
  });
  return settings;
}

function applyExternalSettings(next: Settings): void {
  const normalized = normalizeSettings(next);
  if (sameSettings(settings, normalized)) return;
  applySettings(normalized);
}

function applySettings(next: Settings): void {
  settings = next;
  controllers.forEach((controller) => controller.updateSettings(settings));
  if (!settings.enabled) meterState = { ...EMPTY_METER_STATE };
}

function sameSettings(left: Settings, right: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>)
    .every((key) => left[key] === right[key]);
}
