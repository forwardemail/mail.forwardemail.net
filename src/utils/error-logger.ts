/**
 * Client-side error logging utility
 * Captures errors, stores them in sessionStorage, and provides them to the feedback system
 */

import { redact } from './redaction';

const MAX_LOG_ENTRIES = 100;
const MAX_LOG_SIZE = 500 * 1024; // 500KB max
const LOG_KEY = 'app_logs';
const DB_ERROR_KEY = 'db_errors';
const API_ERROR_KEY = 'api_errors';
const hasWindow = typeof window !== 'undefined';
const hasStorage = typeof sessionStorage !== 'undefined';

const sanitize = (str: string | undefined): string => redact(str);

export interface LogEntry {
  type: string;
  timestamp: string;
  url?: string;
  userAgent?: string;
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  reason?: string;
  promise?: unknown;
  endpoint?: string;
  method?: string;
  status?: number;
  operation?: string;
  action?: string;
  metric?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface ExportedLogs {
  logs: LogEntry[];
  apiErrors: LogEntry[];
  dbErrors: LogEntry[];
  timestamp: string;
  userAgent: string;
  url: string;
}

class ErrorLogger {
  sessionLogs: LogEntry[];

  constructor() {
    this.sessionLogs = [];
    this.loadLogs();
    if (hasWindow) this.setupGlobalHandlers();
  }

  loadLogs(): void {
    if (!hasStorage) return;
    try {
      const stored = sessionStorage.getItem(LOG_KEY);
      if (stored) {
        this.sessionLogs = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load logs from sessionStorage:', error);
    }
  }

  saveLogs(): void {
    if (!hasStorage) return;
    try {
      // Trim to max entries
      if (this.sessionLogs.length > MAX_LOG_ENTRIES) {
        this.sessionLogs = this.sessionLogs.slice(-MAX_LOG_ENTRIES);
      }

      let logsString = JSON.stringify(this.sessionLogs);

      // Check size
      if (logsString.length > MAX_LOG_SIZE) {
        // Remove oldest entries until under size limit
        while (logsString.length > MAX_LOG_SIZE && this.sessionLogs.length > 10) {
          this.sessionLogs.shift();
          logsString = JSON.stringify(this.sessionLogs);
        }
      }

      sessionStorage.setItem(LOG_KEY, JSON.stringify(this.sessionLogs));
    } catch (error) {
      console.error('Failed to save logs to sessionStorage:', error);
      // If quota exceeded, clear old logs
      this.sessionLogs = this.sessionLogs.slice(-50);
      try {
        sessionStorage.setItem(LOG_KEY, JSON.stringify(this.sessionLogs));
      } catch {
        /** */
      }
    }
  }

  setupGlobalHandlers(): void {
    if (!hasWindow) return;

    // Capture unhandled errors
    window.addEventListener('error', (event: ErrorEvent) => {
      this.logError('unhandled_error', {
        message: sanitize(event.message),
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: sanitize(event.error?.stack),
      });
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      this.logError('unhandled_rejection', {
        reason: sanitize(event.reason?.message || String(event.reason)),
        promise: event.promise,
        stack: sanitize(event.reason?.stack),
      });
    });

    // Capture console errors (optional - can be noisy)
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      this.logError('console_error', {
        message: sanitize(args.map((arg) => String(arg)).join(' ')),
      });
      originalError.apply(console, args);
    };
  }

  /**
   * Log a general error
   */
  logError(type: string, data: Record<string, unknown>): void {
    const entry: LogEntry = {
      type,
      timestamp: new Date().toISOString(),
      url: hasWindow ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ...data,
    };

    this.sessionLogs.push(entry);
    this.saveLogs();
  }

  /**
   * Log API errors
   */
  logApiError(endpoint: string, method: string, status: number, error: Error): void {
    if (!hasStorage) return;
    const entry: LogEntry = {
      type: 'api_error',
      timestamp: new Date().toISOString(),
      endpoint: sanitize(endpoint),
      method,
      status,
      message: sanitize(error.message),
      stack: sanitize(error.stack),
    };

    // Store API errors separately for easier filtering
    try {
      const apiErrors = JSON.parse(sessionStorage.getItem(API_ERROR_KEY) || '[]');
      apiErrors.push(entry);
      sessionStorage.setItem(API_ERROR_KEY, JSON.stringify(apiErrors.slice(-50)));
    } catch {
      /** */
    }

    this.sessionLogs.push(entry);
    this.saveLogs();
  }

  /**
   * Log IndexedDB errors
   */
  logDbError(operation: string, error: Error): void {
    if (!hasStorage) return;
    const entry: LogEntry = {
      type: 'db_error',
      timestamp: new Date().toISOString(),
      operation,
      message: sanitize(error.message),
      stack: sanitize(error.stack),
    };

    // Store DB errors separately
    try {
      const dbErrors = JSON.parse(sessionStorage.getItem(DB_ERROR_KEY) || '[]');
      dbErrors.push(entry);
      sessionStorage.setItem(DB_ERROR_KEY, JSON.stringify(dbErrors.slice(-50)));
    } catch {
      /** */
    }

    this.sessionLogs.push(entry);
    this.saveLogs();
  }

  /**
   * Log user actions for debugging context
   */
  logAction(action: string, data: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      type: 'user_action',
      timestamp: new Date().toISOString(),
      action,
      ...data,
    };

    this.sessionLogs.push(entry);
    this.saveLogs();
  }

  /**
   * Log performance metrics
   */
  logPerformance(metric: string, value: unknown, data: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      type: 'performance',
      timestamp: new Date().toISOString(),
      metric,
      value,
      ...data,
    };

    this.sessionLogs.push(entry);
    this.saveLogs();
  }

  /**
   * Get all logs
   */
  getLogs(): LogEntry[] {
    return this.sessionLogs;
  }

  /**
   * Get logs by type
   */
  getLogsByType(type: string): LogEntry[] {
    return this.sessionLogs.filter((log) => log.type === type);
  }

  /**
   * Get recent logs (last N entries)
   */
  getRecentLogs(count: number = 50): LogEntry[] {
    return this.sessionLogs.slice(-count);
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.sessionLogs = [];
    if (hasStorage) {
      sessionStorage.removeItem(LOG_KEY);
      sessionStorage.removeItem(API_ERROR_KEY);
      sessionStorage.removeItem(DB_ERROR_KEY);
    }
  }

  /**
   * Export logs for download
   */
  exportLogs(): ExportedLogs {
    return {
      logs: this.sessionLogs,
      apiErrors: hasStorage ? JSON.parse(sessionStorage.getItem(API_ERROR_KEY) || '[]') : [],
      dbErrors: hasStorage ? JSON.parse(sessionStorage.getItem(DB_ERROR_KEY) || '[]') : [],
      timestamp: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      url: hasWindow ? window.location.href : '',
    };
  }
}

// Create singleton instance
export const errorLogger = new ErrorLogger();

// Export convenience methods
export const logError = (type: string, data: Record<string, unknown>): void =>
  errorLogger.logError(type, data);
export const logApiError = (endpoint: string, method: string, status: number, error: Error): void =>
  errorLogger.logApiError(endpoint, method, status, error);
export const logDbError = (operation: string, error: Error): void =>
  errorLogger.logDbError(operation, error);
export const logAction = (action: string, data?: Record<string, unknown>): void =>
  errorLogger.logAction(action, data);
export const logPerformance = (
  metric: string,
  value: unknown,
  data?: Record<string, unknown>,
): void => errorLogger.logPerformance(metric, value, data);
