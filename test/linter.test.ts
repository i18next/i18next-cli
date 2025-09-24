import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/types'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

vi.mock('ora', () => {
  const mockSucceed = vi.fn()
  const mockFail = vi.fn()
  const mockStart = vi.fn(() => ({
    succeed: mockSucceed,
    fail: mockFail,
  }))
  const mockOra = vi.fn(() => ({
    start: mockStart,
  }))

  return {
    default: mockOra,
    __spies: { mockSucceed, mockFail },
  }
})
// --- END MOCKS ---

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: '', // Not used by linter
    transComponents: ['Trans'],
  },
}

describe('linter', () => {
  let exitSpy: any
  let consoleLogSpy: any
  let oraSpies: any

  beforeEach(async () => {
    // CORRECTED LINE: Use a standard dynamic import() to get the mocked module
    oraSpies = (await import('ora') as any).__spies

    vol.reset()
    vi.clearAllMocks()
    oraSpies.mockSucceed.mockClear()
    oraSpies.mockFail.mockClear()

    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should find no issues in a clean file', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';
      const text = t('myKey');
      const el = <Trans>No hardcoded text here</Trans>;
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(oraSpies.mockSucceed).toHaveBeenCalledWith(expect.stringContaining('No issues found.'))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('should detect a hardcoded string in a JSX element', async () => {
    const sampleCode = '<p>This is a hardcoded string.</p>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "This is a hardcoded string."'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should detect a hardcoded string in a JSX attribute', async () => {
    const sampleCode = '<img alt="A hardcoded alt text" />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "A hardcoded alt text"'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should ignore text inside a Trans component', async () => {
    const sampleCode = '<Trans>This text is a key and should be ignored</Trans>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(oraSpies.mockSucceed).toHaveBeenCalledWith(expect.stringContaining('No issues found.'))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('should respect custom ignoredAttributes from config', async () => {
    // This config tells the linter to also ignore the 'data-testid' attribute
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoredAttributes: ['data-testid'],
      },
    }

    const sampleCode = `
      <div>
        <p title="A hardcoded title" />
        <span data-testid="a-test-id" />
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(customConfig)

    // It should fail because "A hardcoded title" is still found
    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))

    // It should report the title attribute
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "A hardcoded title"'))

    // It should NOT report the data-testid attribute
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('a-test-id'))

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should handle a complex component with mixed valid and invalid strings', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoredAttributes: ['data-testid'], // Add custom rule for this test
      },
    }

    const sampleCode = `
      import { Trans } from 'react-i18next';
      function ComplexComponent() {
        return (
          <div className="container">
            <h1>A hardcoded title</h1>
            <input
              type="text"
              placeholder="Your placeholder here"
              data-testid="user-input"
            />
            <p>123</p>
            <Trans i18nKey="trans.key">
              This text is <strong>valid</strong> and should be ignored.
            </Trans>
          </div>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(customConfig)

    // It should find exactly 2 issues
    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 2 potential issues'))

    // It should report the hardcoded text in the <h1>
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "A hardcoded title"'))

    // It should report the hardcoded text in the placeholder attribute
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "Your placeholder here"'))

    // It should NOT report strings from ignored attributes or components
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('container')) // className
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('text')) // type
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('user-input')) // data-testid
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('123')) // numeric
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('This text is')) // inside Trans

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
