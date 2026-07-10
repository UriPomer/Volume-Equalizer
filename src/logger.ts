import { BRAND } from './config';

const LOG_INTERVAL_MS = 30000;
const lastLogAt = new Map<string, number>();

function shouldLog(key: string): boolean {
  const now = Date.now();
  const last = lastLogAt.get(key) || 0;
  if (now - last < LOG_INTERVAL_MS) return false;
  lastLogAt.set(key, now);
  return true;
}

export function warnFailure(key: string, message: string, error?: unknown): void {
  if (!shouldLog(`warn:${key}`)) return;
  if (error !== undefined) {
    console.warn(`${BRAND} ${message}`, error);
  } else {
    console.warn(`${BRAND} ${message}`);
  }
}

export function errorFailure(key: string, message: string, error?: unknown): void {
  if (!shouldLog(`error:${key}`)) return;
  if (error !== undefined) {
    console.error(`${BRAND} ${message}`, error);
  } else {
    console.error(`${BRAND} ${message}`);
  }
}

export function logDiagnostic(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.info(`${BRAND} ${message}`, details);
  } else {
    console.info(`${BRAND} ${message}`);
  }
}
