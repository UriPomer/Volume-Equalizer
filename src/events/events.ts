/**
 * 事件定义 - 集中管理事件名称
 */

export const EVENTS = {
  SETTINGS_CHANGED: 'settings:changed',
  MEDIA_PLAY: 'media:play',
  MEDIA_PAUSE: 'media:pause',
  MEDIA_SEEKED: 'media:seeked',
  MEDIA_EMPTIED: 'media:emptied'
} as const;
