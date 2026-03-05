export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function debug(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.DEBUG) {
    console.log(`[${formatTimestamp()}] [DEBUG]`, ...args);
  }
}

export function info(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.INFO) {
    console.log(`[${formatTimestamp()}] [INFO]`, ...args);
  }
}

export function warn(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.WARN) {
    console.warn(`[${formatTimestamp()}] [WARN]`, ...args);
  }
}

export function error(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.ERROR) {
    console.error(`[${formatTimestamp()}] [ERROR]`, ...args);
  }
}

export const logger = {
  debug,
  info,
  warn,
  error,
  setLogLevel,
};
