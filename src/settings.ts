/**
 * 设置管理 - 加载和保存用户设置
 */

import { DEFAULT_SETTINGS, Settings } from './config';
import { lufsToRms } from './lufs-calculator';

const storageSupported = typeof chrome !== 'undefined' && !!chrome?.storage?.local;
const TARGET_RMS_MIN = lufsToRms(-23);
const TARGET_RMS_MAX = lufsToRms(-10);

export function normalizeSettings(value: unknown): Settings {
  const input = value && typeof value === 'object'
    ? value as Partial<Record<keyof Settings, unknown>>
    : {};
  return {
    enabled: booleanValue(input.enabled, DEFAULT_SETTINGS.enabled),
    fullAudioAnalysis: booleanValue(
      input.fullAudioAnalysis,
      DEFAULT_SETTINGS.fullAudioAnalysis
    ),
    targetRms: numberValue(
      input.targetRms,
      TARGET_RMS_MIN,
      TARGET_RMS_MAX,
      DEFAULT_SETTINGS.targetRms
    ),
    minGain: numberValue(input.minGain, 0.2, 1, DEFAULT_SETTINGS.minGain),
    maxGain: numberValue(input.maxGain, 1, 3, DEFAULT_SETTINGS.maxGain),
    bassBoost: numberValue(input.bassBoost, -6, 6, DEFAULT_SETTINGS.bassBoost),
    gainChangePerSec: numberValue(
      input.gainChangePerSec,
      0.01,
      1,
      DEFAULT_SETTINGS.gainChangePerSec
    )
  };
}

/**
 * 从 chrome.storage 加载设置
 */
export function loadSettings(): Promise<Settings> {
  if (!storageSupported) {
    return Promise.resolve({ ...DEFAULT_SETTINGS });
  }
  const defaultSettings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaultSettings, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(normalizeSettings(result));
    });
  });
}

/**
 * 保存设置到 chrome.storage
 */
export function persistSettings(settings: Settings): Promise<void> {
  if (!storageSupported) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(normalizeSettings(settings), () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  if (!storageSupported || !chrome.storage.onChanged) return () => {};
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'local') return;
    const next: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (changes[key]) next[key] = changes[key].newValue;
    }
    loadSettings().then(listener).catch(() => {
      listener(normalizeSettings(next));
    });
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}
