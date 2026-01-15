/**
 * 设置管理 - 加载和保存用户设置
 */

import { DEFAULT_SETTINGS } from './config.js';

const storageSupported = typeof chrome !== 'undefined' && chrome?.storage?.local;

/**
 * 从 chrome.storage 加载设置
 * @returns {Promise<Object>} 设置对象
 */
export function loadSettings() {
  if (!storageSupported) {
    return Promise.resolve({ ...DEFAULT_SETTINGS });
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result || { ...DEFAULT_SETTINGS });
    });
  });
}

/**
 * 保存设置到 chrome.storage
 * @param {Object} settings - 要保存的设置
 */
export function persistSettings(settings) {
  if (!storageSupported) return;
  chrome.storage.local.set(settings);
}
