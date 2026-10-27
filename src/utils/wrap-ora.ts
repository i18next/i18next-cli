import yoctoSpinner, { type Spinner } from 'yocto-spinner'

export interface SpinnerLike {
  text: string
  start(): SpinnerLike
  succeed(msg?: string): void
  fail(msg?: string): void
  warn(msg?: string): void
  stop(): void
  progress?(msg: string): void
}

/**
 * Creates a spinner-like object that either:
 * - is fully silent (quiet mode),
 * - logs only start/succeed/fail events to a logger (no animation),
 * - or falls back to an animated yocto-spinner.
 *
 * This avoids flooding structured loggers with spinner frames and ensures clean output in CI, Vite, etc.
 */

export function createSpinnerLike (
  initialText: string,
  options: { quiet?: boolean; logger?: any } = {}
): SpinnerLike {
  const { quiet, logger } = options
  let text = initialText

  // If interactive (no logger and not quiet), create a single real spinner
  let realSpinner: Spinner | null = null
  if (!quiet && !logger) {
    realSpinner = yoctoSpinner({ text }).start()
  }

  const self: SpinnerLike = {
    get text () { return text },
    set text (v: string) {
      text = v
      if (realSpinner) realSpinner.text = v
    },
    start () { return self },
    succeed (msg?: string) {
      const message = msg ?? text
      if (quiet) return
      if (logger) {
        if (typeof logger.info === 'function') logger.info(message)
        else if (typeof logger.log === 'function') logger.log(message)
        else process.stderr.write(message + '\n')
      } else {
        if (!realSpinner) realSpinner = yoctoSpinner({ text }).start()
        realSpinner.success(message)
      }
    },
    fail (msg?: string) {
      const message = msg ?? text
      if (quiet) return
      if (logger) {
        if (typeof logger.error === 'function') logger.error(message)
        else if (typeof logger.log === 'function') logger.log(message)
        else process.stderr.write(message + '\n')
      } else {
        if (!realSpinner) realSpinner = yoctoSpinner({ text }).start()
        realSpinner.error(message)
      }
    },
    warn (msg?: string) {
      const message = msg ?? text
      if (quiet) return
      if (logger) {
        if (typeof logger.warn === 'function') logger.warn(message)
        else if (typeof logger.log === 'function') logger.log(message)
        else process.stderr.write(message + '\n')
      } else {
        if (!realSpinner) realSpinner = yoctoSpinner({ text }).start()
        realSpinner.warning(message)
      }
    },
    stop () { if (realSpinner) realSpinner.stop() },
    progress (msg: string) {
      if (quiet) return
      if (logger) {
        if (typeof logger.info === 'function') logger.info(msg)
        else if (typeof logger.log === 'function') logger.log(msg)
        else process.stderr.write(msg + '\n')
      } else {
        if (!realSpinner) realSpinner = yoctoSpinner({ text }).start()
        realSpinner.text = String(msg)
      }
    }
  }

  return self
}
