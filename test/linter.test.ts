import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runLinter } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

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

  it('should report correct line numbers for issues', async () => {
    // Define the code as an array of strings and join with newlines.
    // This creates a "clean" string without ambiguous leading/trailing whitespace
    // from a template literal, ensuring the parser's byte offsets are accurate.
    const sampleCode = [
      '// Line 1',
      'function MyComponent() {', // Line 2
      '  return (', // Line 3
      '    <div>A string on line 4</div>', // Line 4
      '  );', // Line 5
      '}', // Line 6
      'const el = <p title="An attribute on line 7"></p>;', // Line 7
    ].join('\n')

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 2 potential issues'))

    const loggedMessages = consoleLogSpy.mock.calls.flat().join('\n')

    // Assert that the line numbers are now correct
    expect(loggedMessages).toContain('4: Error: Found hardcoded string: "A string on line 4"')
    expect(loggedMessages).toContain('7: Error: Found hardcoded string: "An attribute on line 7"')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should respect custom ignoredTags from config', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoredTags: ['blockquote'], // Tell the linter to ignore content inside <blockquote>
      },
    }

    const sampleCode = `
      <div>
        <p>This should be flagged.</p>
        <blockquote>This text should be ignored.</blockquote>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(customConfig)

    // It should find exactly 1 issue
    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))

    // It should report the text from the <p> tag
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "This should be flagged."'))

    // It should NOT report the text from the <blockquote> tag
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('This text should be ignored.'))

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should not crash on TypeScript code with decorators', async () => {
    const sampleCodeWithDecorators = `
      import { InjectManager, MedusaContext, MedusaService } from "@medusajs/framework/utils"
      
      export default class WishlistModuleService extends MedusaService({
        Wishlist: {},
        WishlistItem: {}
      }) {
        @InjectManager()
        async getWishlistsOfVariants(
          variantIds: string[],
          @MedusaContext() context: any = {}
        ): Promise<number> {
          // This code contains no hardcoded strings
          return 123;
        }
      }
    `

    const { glob } = await import('glob');
    // Override the default glob mock to return our specific test file.
    (glob as any).mockResolvedValue(['/src/decorator-service.ts'])

    vol.fromJSON({ '/src/decorator-service.ts': sampleCodeWithDecorators })

    await runLinter(mockConfig)

    // Assert that the linter completes successfully and does not fail.
    // This proves the parser did not crash.
    expect(oraSpies.mockSucceed).toHaveBeenCalledWith(expect.stringContaining('No issues found.'))
    expect(oraSpies.mockFail).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('should ignore files specified in the "ignore" option during linting', async () => {
  // Setup: Create two files with hardcoded strings. One should be ignored.
    vol.fromJSON({
      '/src/App.tsx': '<p>A valid hardcoded string</p>',
      '/src/legacy/ignored.tsx': '<h1>An ignored hardcoded string</h1>',
    })

    // Mock glob to respect the ignore pattern
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern, options) => {
      if ((options?.ignore as string[]).includes('src/legacy/**')) {
        return ['/src/App.tsx'] // Simulate glob filtering
      }
      return ['/src/App.tsx', '/src/legacy/ignored.tsx']
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.{ts,tsx}'],
        // Ignore all files in the 'legacy' directory
        ignore: ['src/legacy/**'],
      },
    }

    // Action: Run the linter
    await runLinter(config)

    // Assertions
    // It should only find 1 issue (from App.tsx), not 2.
    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))

    // It should report the string from the non-ignored file
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "A valid hardcoded string"'))
    // It should NOT report the string from the ignored file
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('An ignored hardcoded string'))
  })

  it('should not flag spread operators in regular JavaScript code', async () => {
    const sampleCode = `
      const varovani = [1, 2, 3];
      const sorted = [...varovani]
        .sort((a, b) => a - b);
      
      const obj = { ...someObject };
      const combined = [...array1, ...array2];
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    // The linter should not find any issues with spread operators in JS code
    expect(oraSpies.mockSucceed).toHaveBeenCalledWith(expect.stringContaining('No issues found.'))
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('...'))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('should not flag three dots when used as JSX text or attributes, but flag other strings', async () => {
    // This code contains "..." which should be ignored, and "Loading" which should be flagged.
    const sampleCode = `
      function Component() {
        return (
          <div>
            <button>...</button>
            <span title="...">Loading</span> 
          </div>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    // 1. Expect the linter to FAIL because "Loading" is found.
    expect(oraSpies.mockFail).toHaveBeenCalledWith(expect.stringContaining('Linter found 1 potential issues'))

    // 2. Expect the log message for "Loading".
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('6: Error: Found hardcoded string: "Loading"'))

    // 3. Expect that "..." was NOT logged.
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('...'))

    // 4. Expect the process to exit with an error code.
    expect(exitSpy).toHaveBeenCalledWith(1)

    // 5. Ensure mockSucceed was NOT called.
    expect(oraSpies.mockSucceed).not.toHaveBeenCalled()
  })
})
