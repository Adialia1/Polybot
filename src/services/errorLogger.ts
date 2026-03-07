import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const LOG_DIR = join(process.cwd(), 'data', 'logs');
const ERROR_LOG = join(LOG_DIR, 'errors.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB — rotate when exceeded

/**
 * Thread-safe error logger that appends to a file.
 * Uses appendFileSync which is atomic for small writes on most OS/filesystems,
 * so concurrent calls won't corrupt each other.
 */
class ErrorLogger {
  private initialized = false;

  private ensureDir(): void {
    if (this.initialized) return;
    try {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
      }
      this.initialized = true;
    } catch {
      // If we can't create the dir, we'll just skip logging
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(ERROR_LOG)) {
        const stats = statSync(ERROR_LOG);
        if (stats.size > MAX_LOG_SIZE) {
          const rotated = ERROR_LOG + '.old';
          renameSync(ERROR_LOG, rotated);
        }
      }
    } catch {
      // Non-critical — skip rotation
    }
  }

  /**
   * Log an error with source, message, and optional context.
   * Each write is a single appendFileSync call — safe for concurrent access.
   */
  log(source: string, message: string, context?: Record<string, any>): void {
    this.ensureDir();
    this.rotateIfNeeded();

    const timestamp = new Date().toISOString();
    const contextStr = context ? ' | ' + JSON.stringify(context) : '';
    const line = `[${timestamp}] [${source}] ${message}${contextStr}\n`;

    try {
      appendFileSync(ERROR_LOG, line);
    } catch {
      // Last resort — don't crash the bot over logging
    }
  }

  /**
   * Log an error from a caught exception.
   */
  logError(source: string, error: any, context?: Record<string, any>): void {
    const message = error?.message || String(error);
    const stack = error?.stack?.split('\n').slice(0, 3).join(' <- ') || '';
    this.log(source, message, { ...context, stack: stack || undefined });
  }
}

// Singleton — safe to import from anywhere
export const errorLogger = new ErrorLogger();
