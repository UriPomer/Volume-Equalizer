/**
 * 事件总线 - 统一管理模块间事件
 */

type EventHandler = (payload?: unknown) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  on(eventName: string, handler: EventHandler): () => void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(handler);
    return () => this.off(eventName, handler);
  }

  once(eventName: string, handler: EventHandler): () => void {
    const off = this.on(eventName, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(eventName: string, handler: EventHandler): void {
    const set = this.listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(eventName);
  }

  emit(eventName: string, payload?: unknown): void {
    const set = this.listeners.get(eventName);
    if (!set) return;
    [...set].forEach((handler) => {
      try {
        handler(payload);
      } catch {
        // 防止单个监听器影响其它监听
      }
    });
  }
}

export const eventBus = new EventBus();
