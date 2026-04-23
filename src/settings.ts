/**
 * 设置管理 - 加载和保存用户设置
 */

import { DEFAULT_SETTINGS, Settings } from './config';

const storageSupported = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

/**
 * 从 chrome.storage 加载设置
 */
export function loadSettings(): Promise<Settings> {
  if (!storageSupported) {
    return Promise.resolve({ ...DEFAULT_SETTINGS });
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve((result as Settings) || { ...DEFAULT_SETTINGS });
    });
  });
}

/**
 * 保存设置到 chrome.storage
 */
export function persistSettings(settings: Settings): void {
  if (!storageSupported) return;
  chrome.storage.local.set(settings);
}
