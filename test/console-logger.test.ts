import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConsoleLogger } from '../src/utils/logger'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConsoleLogger', () => {
  it('forwards the optional second argument to console.warn (so plugin errors are not swallowed)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = new ConsoleLogger()
    const err = new Error('boom')

    logger.warn('Plugin my-plugin failed:', err)

    expect(spy).toHaveBeenCalledWith('Plugin my-plugin failed:', err)
  })

  it('does not pass a second argument to console.warn when none is provided', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = new ConsoleLogger()

    logger.warn('just a message')

    expect(spy).toHaveBeenCalledWith('just a message')
    expect(spy.mock.calls[0]).toHaveLength(1)
  })

  it('forwards the optional second argument to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = new ConsoleLogger()
    const err = new Error('boom')

    logger.error('something failed:', err)

    expect(spy).toHaveBeenCalledWith('something failed:', err)
  })
})
