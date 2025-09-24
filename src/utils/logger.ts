import type { Logger } from '../types'

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
   */
  warn (message: string): void { console.warn(message) }

  /**
   * Logs an error message to the console.
   *
   * @param message - The error message to log
   */
  error (message: string): void { console.error(message) }
}
