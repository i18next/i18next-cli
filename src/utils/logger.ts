import type { Logger } from '../types.js'

/**
 * Default console-based logger implementation for the i18next toolkit.
 * Provides basic logging functionality with different severity levels.
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger()
 * logger.info('Extraction started')
 * logger.warn('Deprecated configuration option used')
 * logger.error('Failed to parse file')
 * ```
 */
export class ConsoleLogger implements Logger {
  /**
   * Logs an informational message to the console.
   *
   * @param message - The message to log
   */
  info (message: string): void { console.log(message) }

  /**
   * Logs a warning message to the console.
   *
   * @param message - The warning message to log
   * @param more - Optional additional detail (e.g. a caught error). Forwarded to
   *   `console.warn` so thrown errors surfaced by plugin hooks are not swallowed.
   */
  warn (message: string, more?: unknown): void {
    if (more === undefined) { console.warn(message) } else { console.warn(message, more) }
  }

  /**
   * Logs an error message to the console.
   *
   * @param message - The error message to log
   * @param more - Optional additional detail (e.g. a caught error).
   */
  error (message: unknown, more?: unknown): void {
    if (more === undefined) { console.error(message) } else { console.error(message, more) }
  }
}
