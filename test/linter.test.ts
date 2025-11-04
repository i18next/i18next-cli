import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Linter, runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))
// --- END MOCKS ---

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: '', // Not used by linter
    transComponents: ['Trans'],
  },
}

describe('Linter (core logic)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
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

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should detect a hardcoded string in a JSX element', async () => {
    const sampleCode = '<p>This is a hardcoded string.</p>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('This is a hardcoded string.')
  })

  it('should detect a hardcoded string in a JSX attribute', async () => {
    const sampleCode = '<img alt="A hardcoded alt text" />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('A hardcoded alt text')
  })

  it('should ignore text inside a Trans component', async () => {
    const sampleCode = '<Trans>This text is a key and should be ignored</Trans>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
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

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('A hardcoded title')
    // Should NOT include data-testid
    expect(result.files['/src/App.tsx'].some(issue => issue.text.includes('a-test-id'))).toBe(false)
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

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 2 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(2)

    const texts = result.files['/src/App.tsx'].map(issue => issue.text)
    expect(texts).toContain('A hardcoded title')
    expect(texts).toContain('Your placeholder here')

    // Should NOT include these
    expect(texts.some(text => text.includes('container'))).toBe(false)
    expect(texts.some(text => text.includes('user-input'))).toBe(false)
    expect(texts.some(text => text === '123')).toBe(false)
    expect(texts.some(text => text.includes('This text is'))).toBe(false)
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

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 2 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(2)

    const issues = result.files['/src/App.tsx']
    expect(issues[0].line).toBe(4)
    expect(issues[0].text).toBe('A string on line 4')
    expect(issues[1].line).toBe(7)
    expect(issues[1].text).toBe('An attribute on line 7')
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

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('This should be flagged.')
    // Should NOT include blockquote text
    expect(result.files['/src/App.tsx'].some(issue => issue.text.includes('This text should be ignored'))).toBe(false)
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

    const result = await runLinter(mockConfig)

    // Assert that the linter completes successfully and does not fail.
    // This proves the parser did not crash.
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
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

    const result = await runLinter(config)

    // It should only find 1 issue (from App.tsx), not 2.
    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('A valid hardcoded string')
    // The ignored file should not be in the results
    expect(result.files['/src/legacy/ignored.tsx']).toBeUndefined()
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

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
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

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Loading')
    expect(result.files['/src/App.tsx'][0].line).toBe(6)
    // Should NOT include "..."
    expect(result.files['/src/App.tsx'].some(issue => issue.text === '...')).toBe(false)
  })

  it('should ignore self-closing tags listed in ignoredTags (e.g. <path />)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoredTags: ['svg', 'path'],
      },
    }

    const sampleCode = `
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="block"
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2 12C2 6.47715 6.47715 2 12 2"
          fill="currentColor"
        />
      </svg>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should emit progress events during linting', async () => {
    const sampleCode = '<p>Test string</p>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const linter = new Linter(mockConfig)
    const progressEvents: string[] = []

    linter.on('progress', (event) => {
      progressEvents.push(event.message)
    })

    await linter.run()

    expect(progressEvents).toContain('Finding source files to analyze...')
    expect(progressEvents.some(msg => msg.includes('Analyzing'))).toBe(true)
  })

  it('should emit done event with results', async () => {
    const sampleCode = '<p>Hardcoded text</p>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const linter = new Linter(mockConfig)
    let doneEvent: any = null

    linter.on('done', (event) => {
      doneEvent = event
    })

    await linter.run()

    expect(doneEvent).not.toBeNull()
    expect(doneEvent.success).toBe(false)
    expect(doneEvent.message).toContain('Linter found 1 potential issues')
    expect(doneEvent.files['/src/App.tsx']).toHaveLength(1)
  })

  it('should emit error event and throw on failures', async () => {
    const { glob } = await import('glob')
    // Simulate glob throwing an error
    vi.mocked(glob).mockRejectedValue(new Error('Glob failed'))

    const linter = new Linter(mockConfig)
    let errorEvent: Error | null = null

    linter.on('error', (error) => {
      errorEvent = error
    })

    await expect(linter.run()).rejects.toThrow('Linter failed to run: Glob failed')
    expect(errorEvent).not.toBeNull()
    expect((errorEvent as unknown as Error).message).toContain('Linter failed to run: Glob failed')
  })

  it('should not crash on TypeScript angle-bracket assertions in .ts files', async () => {
    const { glob } = await import('glob')
    // Return a .ts file to ensure parser picks non-TSX mode
    ;(glob as any).mockResolvedValue(['/src/angle-assertions.ts'])

    const sampleWithAngleAssertions = `
      type ExampleType = { key: string }

      function getValues(): ExampleType[] {
        return [{ key: 'value' }]
      }

      function getValue(): ExampleType {
        return { key: 'value' }
      }

      // Angle-bracket type assertions that used to break parsing when treated as TSX
      const multipleValues = <ExampleType[]>getValues()
      const singleValue = <ExampleType>getValue()

      // Ensure linter still completes (no hardcoded strings to flag)
    `

    vol.fromJSON({ '/src/angle-assertions.ts': sampleWithAngleAssertions })

    const result = await runLinter(mockConfig)

    // Should complete successfully and not throw due to parsing error
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
  })

  it('should parse JSX in .ts files via TSX fallback and report issues (no throw)', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/tsx-in-ts.ts'])

    const sampleWithJsxInTs = `
      import { QueryClientProvider } from '@tanstack/react-query'
      const queryClient = {}

      function App() {
        return (
          // Managing server side data FetchTokenConfig, caching and mutations via React Query.
          <QueryClientProvider client={queryClient}>
            {/* Intentionally simple JSX inside a .ts file to reproduce previous parser error */}
            <div>Should not crash</div>
          </QueryClientProvider>
        )
      }
    `

    vol.fromJSON({ '/src/tsx-in-ts.ts': sampleWithJsxInTs })

    const linter = new Linter(mockConfig)
    let errorEvent: Error | null = null
    const progressEvents: string[] = []
    linter.on('error', (err) => { errorEvent = err })
    linter.on('progress', (e) => { progressEvents.push(e.message) })

    const result = await linter.run()

    // No global error should be emitted (fallback handled parsing)
    expect(errorEvent).toBeNull()
    // Fallback parse should have been announced
    expect(progressEvents.some(msg => msg.includes('TSX fallback') || msg.includes('Parsed /src/tsx-in-ts.ts using TSX fallback'))).toBe(true)

    // Linter should return results and report the hardcoded string found inside the .ts file
    expect(result).toBeDefined()
    expect(result.success).toBe(false)
    expect(result.files['/src/tsx-in-ts.ts']).toBeDefined()
    expect(result.files['/src/tsx-in-ts.ts'][0].text).toBe('Should not crash')
  })

  it('should handle identical JSX fine when file extension is .tsx', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])

    const sampleTsx = `
      import { QueryClientProvider } from '@tanstack/react-query'
      const queryClient = {}

      export default function App() {
        return (
          <QueryClientProvider client={queryClient}>
            <div>Hardcoded string in TSX</div>
          </QueryClientProvider>
        )
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleTsx })

    const result = await runLinter(mockConfig)

    // Linter should complete (may flag the hardcoded string), but should not crash.
    expect(result).toBeDefined()
    // If it flags the hardcoded string the run is considered a successful run with findings (success=false).
    expect(typeof result.success).toBe('boolean')
  })
})
