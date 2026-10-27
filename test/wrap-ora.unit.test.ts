import yoctoSpinner from 'yocto-spinner'
import { describe, it, expect, vi } from 'vitest'
import { createSpinnerLike } from '../src/utils/wrap-ora'

vi.mock('yocto-spinner', () => {
  // Mock yocto-spinner to track calls and return a fake spinner object
  const spinnerMock = {
    text: 'initial',
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    stop: vi.fn(),
    // @ts-ignore
    start: vi.fn(function () { return this }) // .start() returns itself
  }
  const spinnerFn = vi.fn(() => spinnerMock)
  return { default: spinnerFn }
})

describe('createSpinnerLike', () => {
  it('should do nothing in quiet mode', () => {
    const spinner = createSpinnerLike('quiet', { quiet: true })
    expect(spinner.text).toBe('quiet')
    spinner.text = 'changed'
    expect(spinner.text).toBe('changed')
    expect(() => spinner.succeed('done')).not.toThrow()
    expect(() => spinner.fail('fail')).not.toThrow()
    expect(() => spinner.warn('warn')).not.toThrow()
    expect(() => spinner.stop()).not.toThrow()
    expect(spinner.start()).toBe(spinner)
  })

  it('should log succeed/fail/warn via custom logger', () => {
    const logs: string[] = []
    const logger = {
      info: (msg: string) => logs.push('info:' + msg),
      error: (msg: string) => logs.push('error:' + msg),
      warn: (msg: string) => logs.push('warn:' + msg),
      log: (msg: string) => logs.push('log:' + msg)
    }
    const spinner = createSpinnerLike('work', { logger })
    spinner.start()
    spinner.succeed('done')
    spinner.fail('fail')
    spinner.warn('warn')
    spinner.progress && spinner.progress('progress')
    expect(logs).toContain('info:done')
    expect(logs).toContain('error:fail')
    expect(logs).toContain('warn:warn')
    expect(logs).toContain('info:progress')
    expect(spinner.start()).toBe(spinner)
  })

  it('should use the animated spinner in interactive mode', () => {
    // We can't easily test ora's animation, but we can check that no error is thrown
    const spinner = createSpinnerLike('interactive')
    expect(() => spinner.succeed('done')).not.toThrow()
    expect(() => spinner.fail('fail')).not.toThrow()
    expect(() => spinner.warn('warn')).not.toThrow()
    expect(() => spinner.stop()).not.toThrow()
    expect(spinner.start()).toBe(spinner)
  })

  it('creates and uses a real spinner when no logger and not quiet', () => {
    const spinner = createSpinnerLike('my spinner')
    // The spinner mock should have been called once to create the spinner
    expect((yoctoSpinner as any).mock.calls.length).toBeGreaterThan(0)
    // The returned spinner should update the real spinner's text
    spinner.text = 'updated'
    expect((yoctoSpinner as any).mock.results[0].value.text).toBe('updated')
    // Calling succeed/fail/warn should call the real spinner's methods
    spinner.succeed('done')
    spinner.fail('fail')
    spinner.warn('warn')
    expect((yoctoSpinner as any).mock.results[0].value.success).toHaveBeenCalledWith('done')
    expect((yoctoSpinner as any).mock.results[0].value.error).toHaveBeenCalledWith('fail')
    expect((yoctoSpinner as any).mock.results[0].value.warning).toHaveBeenCalledWith('warn')
  })
})
