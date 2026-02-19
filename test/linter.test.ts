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

  it('should not flag parameters as unused when t() is called with a translation key', async () => {
    // This test reproduces issue #165
    const sampleCode = `
      // Should NOT be flagged: translation key, not a string literal
      t("greeting", { name: "hello" })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)
    console.log(JSON.stringify(result, null, 2))
    // Should not report any issues
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
      },
      lint: {
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
      },
      lint: {
        acceptedTags: [],
        acceptedAttributes: [],
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
      },
      lint: {
        ignoredTags: ['blockquote'], // Tell the linter to ignore content inside <blockquote>
      }
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
      },
      lint: {
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

  it('should respect acceptedAttributes from config (opt-in attribute linting)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
      },
      lint: {
        acceptedTags: [],
        // Only these attributes should be linted; everything else ignored.
        acceptedAttributes: ['alt', 'title'],
      },
    }

    const sampleCode = `
      <div>
        <img alt="An accepted alt text" title="Should also be accepted" data-testid="x" />
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 2 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(2)

    const texts = result.files['/src/App.tsx'].map(i => i.text)
    expect(texts).toContain('An accepted alt text')
    expect(texts).toContain('Should also be accepted')
    // data-testid should NOT be flagged (assert exact value absence)
    expect(texts.some(t => t === 'x')).toBe(false)
  })

  it('should respect acceptedTags from config (opt-in tag linting)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
      },
      lint: {
        // Only content inside <p> should be linted; other tags ignored.
        acceptedTags: ['p'],
      },
    }

    const sampleCode = `
      <div>
        <p>This should be flagged.</p>
        <span>This should NOT be flagged.</span>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 1 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('This should be flagged.')
    // Ensure span text was not reported
    expect(result.files['/src/App.tsx'].some(issue => issue.text.includes('NOT be flagged'))).toBe(false)
  })

  it('acceptedAttributes should override ignoredAttributes (opt-in wins over ignore for attrs)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedTags: [],
        acceptedAttributes: ['alt'],
        ignoredAttributes: ['alt', 'data-testid'],
      },
    }

    const sampleCode = '<img alt="Explicitly accepted even though ignored" data-testid="should-not-flag" />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    // alt should be reported because acceptedAttributes takes precedence for attributes
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Explicitly accepted even though ignored')
  })

  it('ignoredTags should override acceptedTags (explicit ignore wins for tags)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedTags: ['p'],
        ignoredTags: ['p'],
      },
    }

    const sampleCode = `
      <div>
        <p>This should NOT be flagged because it is explicitly ignored</p>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    // p was both accepted and ignored; ignoredTags should cause it to be skipped
    expect(result.success).toBe(true)
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('acceptedTags + ignoredTags: accept a set of tags but ignore nested technical tags (ignored wins)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedTags: ['div', 'p'],
        ignoredTags: ['code'], // content inside <code> must always be ignored
      },
    }

    const sampleCode = `
      <div>
        <p>Should be flagged</p>
        <code>
          <p>Should NOT be flagged (inside ignored tag)</p>
          Should also not be flagged.
        </code>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Should be flagged')
  })

  it('acceptedTags + acceptedAttributes: only lint attributes on accepted tags and only the accepted attributes', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedTags: ['p'],
        acceptedAttributes: ['title'],
      },
    }

    const sampleCode = `
      <div>
        <p title="Flagged title">Text</p>
        <span title="Also flagged title">Span</span>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    // Only the p@title and the p text should be reported; span title is outside acceptedTags
    expect(result.files['/src/App.tsx']).toHaveLength(2)
    expect(result.files['/src/App.tsx'][0].text).toBe('Flagged title')
    expect(result.files['/src/App.tsx'][1].text).toBe('Text')
  })

  it('ignoredTags should override acceptedAttributes (being inside an ignored tag prevents reporting even for accepted attrs)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedAttributes: ['title'],
        ignoredTags: ['button'],
      },
    }

    const sampleCode = `
      <div>
        <button title="Ignored because parent tag is ignored">
          <div title="Also ignored because ancestor is an ignored tag"></div>
        </button>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    // Nothing should be reported because the attributes are inside an ignored tag
    expect(result.success).toBe(true)
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('acceptedTags should allow inner accepted tags to be linted even when outer wrappers are not accepted (nearest ancestor rule)', async () => {
    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract },
      lint: {
        acceptedTags: ['p'],
      },
    }

    const sampleCode = `
      <section>
        <div>
          <p>This inner paragraph should be flagged despite outer wrappers</p>
        </div>
      </section>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(customConfig)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('This inner paragraph should be flagged despite outer wrappers')
  })

  it('defaults: recommendedAcceptedAttributes are applied when no acceptedAttributes provided', async () => {
    const sampleCode = `
      <div>
        <img alt="Alt default text" title="Default title text" />
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    // Both alt and title are in the recommended attribute whitelist and should be reported
    expect(result.files['/src/App.tsx']).toHaveLength(2)
    const texts = result.files['/src/App.tsx'].map(i => i.text)
    expect(texts).toContain('Alt default text')
    expect(texts).toContain('Default title text')
  })

  it('defaults: recommendedAcceptedTags are respected but default ignoredTags still win (code is ignored)', async () => {
    const sampleCode = `
      <div>
        <p>Flagged by default list</p>
        <code>Should NOT be flagged even if in recommended list</code>
      </div>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Flagged by default list')
    // Ensure code content was not reported
    expect(result.files['/src/App.tsx'].some(issue => issue.text.includes('Should NOT be flagged'))).toBe(false)
  })

  it('complex scenario: recommended defaults flag correct texts and attributes, while ignored tags/components are skipped', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      export default function App () {
        return (
          <>
            <main>Welcome to My App</main>

            <img alt="Site logo" title="Logo" data-testid="img1" />

            <p>
              <span>Nested text</span> and more
            </p>

            <code>
              <p>Code snippet</p>
              Some internal code comment
            </code>

            <button aria-label="Submit form">Sbm</button>

            <div className="container" title="Div title">
              Inner div
            </div>

            <Trans>
              Don't flag this <strong>either</strong>
            </Trans>
          </>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(mockConfig)
    // Expect findings from recommended tag/attribute defaults; Trans and code should be ignored.
    expect(result.success).toBe(false)
    const issues = result.files['/src/App.tsx']
    expect(issues).toHaveLength(9)

    const texts = issues.map(i => i.text)
    expect(texts).toContain('Welcome to My App')
    expect(texts).toContain('Site logo')       // img@alt
    expect(texts).toContain('Logo')            // img@title
    expect(texts).toContain('Nested text')     // span text
    expect(texts).toContain('and more')        // tail text in p
    expect(texts).toContain('Submit form')     // button@aria-label
    expect(texts).toContain('Sbm')             // button inner text
    expect(texts).toContain('Div title')       // div@title
    expect(texts).toContain('Inner div')       // div inner text

    // Ensure ignored content is not reported
    expect(texts.some(t => t.includes('Code snippet'))).toBe(false)
    expect(texts.some(t => t.includes("Don't flag this"))).toBe(false)
  })

  it('should detect hardcoded strings in JSX inside .js files', async () => {
    const sampleCode = `
      import React from 'react';
      export default function App() {
        return (
          <div>
            <h1>This is a hardcoded heading</h1>
            <p title="Hardcoded attribute">Some paragraph</p>
          </div>
        );
      }
    `
    vol.fromJSON({ '/src/App.js': sampleCode })

    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.js'])

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.js'],
        output: '',
        transComponents: ['Trans'],
      },
    }

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 3 potential issues')
    expect(result.files['/src/App.js']).toHaveLength(3)
    const texts = result.files['/src/App.js'].map(issue => issue.text)
    expect(texts).toContain('This is a hardcoded heading')
    expect(texts).toContain('Hardcoded attribute')
    expect(texts).toContain('Some paragraph')
  })

  it('should ignore files specified in lint.ignore (in addition to extract.ignore)', async () => {
    // Setup: Create three files, two should be ignored by linter.
    vol.fromJSON({
      '/src/App.tsx': '<p>Should be flagged</p>',
      '/src/admin/ignored.tsx': '<h1>Should NOT be flagged (admin)</h1>',
      '/src/legacy/ignored.tsx': '<h2>Should NOT be flagged (legacy)</h2>',
    })

    // Mock glob to return all files, but simulate ignore filtering
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern, options) => {
      const ignore = options?.ignore ?? []
      // Normalize ignore to an array of strings for consistent processing
      const ignoreList = Array.isArray(ignore) ? ignore : (typeof ignore === 'string' ? [ignore] : [])
      // Simulate glob filtering by removing ignored files
      const files = ['/src/App.tsx', '/src/admin/ignored.tsx', '/src/legacy/ignored.tsx']
      return files.filter(f =>
        !ignoreList.some((pattern: string) =>
          (pattern === 'src/admin/**' && f.startsWith('/src/admin/')) ||
          (pattern === 'src/legacy/**' && f.startsWith('/src/legacy/'))
        )
      )
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: '',
        ignore: ['src/legacy/**'],
        transComponents: ['Trans'],
      },
      lint: {
        ignore: ['src/admin/**'],
      },
    }

    const result = await runLinter(config)

    // Only /src/App.tsx should be linted
    expect(result.success).toBe(false)
    expect(Object.keys(result.files)).toEqual(['/src/App.tsx'])
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Should be flagged')
    // Ignored files should not appear in results
    expect(result.files['/src/admin/ignored.tsx']).toBeUndefined()
    expect(result.files['/src/legacy/ignored.tsx']).toBeUndefined()
  })

  it('should detect interpolation parameter errors in t() calls', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {
        // checkInterpolationParams: true,
      },
    }
    const sampleCode = `
      // Missing parameter 'name', extra parameter 'name2'
      const msg = t("Hello {{name}}!", { name2: "Seven" })
      // Correct usage
      const msg2 = t("Hello {{name}}!", { name: "Seven" })
      // Extra parameter 'unused'
      const msg3 = t("Hi!", { unused: "foo" })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Linter found 2 potential issues')
    expect(result.files['/src/App.tsx']).toHaveLength(2)
    const texts = result.files['/src/App.tsx'].map(issue => issue.text)
    expect(texts).toContain('Interpolation parameter "name" was not provided')
    expect(texts).toContain('Parameter "name2" is not used in translation string')
  })

  it('should not produce false positives for shorthand properties in t() calls (issue #178)', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // Shorthand properties like { hours, minutes } should be recognized as provided params
    const sampleCode = [
      'import { useMemo } from "react"',
      'import { useTranslation } from "react-i18next"',
      '',
      'const DaySegment = () => {',
      '  const { t } = useTranslation()',
      '',
      '  const summedBreakTimeInMinutes = 10',
      '',
      '  const formattedBreakHours = useMemo(() => {',
      '    const hours = Math.floor(summedBreakTimeInMinutes / 60)',
      '    const minutes = summedBreakTimeInMinutes % 60',
      '',
      '    return t("{{hours}}H {{minutes}}M", { hours, minutes })',
      '  }, [summedBreakTimeInMinutes])',
      '',
      '  return <section>{formattedBreakHours}</section>',
      '}',
      '',
      'export default DaySegment',
    ].join('\n')
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    // Should NOT report any interpolation errors - hours and minutes are provided via shorthand
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should report correct line numbers for interpolation parameter errors (issue #178)', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    const sampleCode = [
      '// Line 1',
      'const a = "foo"',
      'const msg = t("Hello {{name}}!", { name2: "Seven" })',
      'const b = "bar"',
    ].join('\n')
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(2)
    const issues = result.files['/src/App.tsx']
    // Both issues originate from the t() call on line 3, not the last line
    expect(issues[0].line).toBe(3)
    expect(issues[1].line).toBe(3)
  })

  it('should distinguish interpolation errors from hardcoded string issues (issue #178)', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    const sampleCode = [
      'const msg = t("Hello {{name}}!", { name2: "Seven" })',
      'const el = <p>Hardcoded text</p>',
    ].join('\n')
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(3)
    const issues = result.files['/src/App.tsx']
    // Interpolation issues should have type 'interpolation'
    const interpolationIssues = issues.filter(i => i.type === 'interpolation')
    const hardcodedIssues = issues.filter(i => !i.type || i.type === 'hardcoded')
    expect(interpolationIssues).toHaveLength(2)
    expect(hardcodedIssues).toHaveLength(1)
    expect(hardcodedIssues[0].text).toBe('Hardcoded text')
  })

  it('should handle mixed shorthand and key-value properties in t() calls', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    const sampleCode = `
      const name = "World"
      const msg = t("{{greeting}}, {{name}}!", { greeting: "Hello", name })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    // Both params are provided (greeting via key-value, name via shorthand)
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
  })

  it('should not produce false positives for nested object interpolation like {{obj.prop}}', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // i18next supports passing objects and accessing nested properties via dot notation
    const sampleCode = `
      const fieldDef = { maxDecimals: 2 }
      const msg = t("{{fieldName}} cannot have more than {{fieldDef.maxDecimals}} decimal places", {
        fieldName,
        fieldDef,
      })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    // Should NOT report any interpolation errors
    // fieldName is provided via shorthand, fieldDef.maxDecimals is satisfied by the fieldDef object
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should not produce false positives for nested object interpolation with key-value syntax', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // Same pattern but with key-value syntax: { author: authorObj }
    const sampleCode = `
      const authorObj = { name: 'Jan', github: 'jamuhl' }
      const msg = t("I am {{author.name}}", { author: authorObj })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should still report errors for genuinely missing root-level interpolation params with nested keys', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // author.name is used in the string but 'author' is NOT provided as a parameter
    const sampleCode = `
      const msg = t("I am {{author.name}}", { user: someObj })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(2)
    const texts = result.files['/src/App.tsx'].map(issue => issue.text)
    expect(texts).toContain('Interpolation parameter "author.name" was not provided')
    expect(texts).toContain('Parameter "user" is not used in translation string')
  })

  it('should handle mix of simple and nested interpolation keys correctly', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // Mix: {{name}} (simple) + {{config.timeout}} (nested) + missing {{missing}}
    const sampleCode = `
      const msg = t("Hello {{name}}, timeout is {{config.timeout}}, and {{missing}}", { name: "World", config: opts })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    const texts = result.files['/src/App.tsx'].map(issue => issue.text)
    // 'name' is provided, 'config.timeout' is satisfied by 'config', but 'missing' is not provided
    expect(texts).toContain('Interpolation parameter "missing" was not provided')
    // 'name' and 'config' should NOT be flagged as unused
    expect(texts).not.toContain('Parameter "name" is not used in translation string')
    expect(texts).not.toContain('Parameter "config" is not used in translation string')
  })

  it('should not flag i18next reserved option keys (defaultValue, count, context, etc.) as unused parameters', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    // Natural language key with {{count}} plus defaultValue plural variants
    const sampleCode = `
      t("Delete {{count}} observations?", {
        count: observations.length,
        defaultValue: "Delete {{count}} observations?",
        defaultValue_one: "Delete {{count}} observation?",
        defaultValue_many: "Delete {{count}} observations?",
        defaultValue_other: "Delete {{count}} observations?",
      })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    // count is used in the string, and defaultValue/defaultValue_* are i18next options — nothing to flag
    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should not flag context, ns, lng, ordinal, and other i18next t() options as unused', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    const sampleCode = `
      t("You have {{count}} items", {
        count: 5,
        context: "cart",
        ns: "shop",
        lng: "en",
        ordinal: true,
        returnObjects: false,
        defaultValue: "You have {{count}} items",
      })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No issues found.')
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should still flag genuinely unused params even when i18next options are present', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }
    const sampleCode = `
      t("Hello {{name}}", {
        name: "World",
        defaultValue: "Hello {{name}}",
        bogus: "should be flagged",
      })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Parameter "bogus" is not used in translation string')
  })

  it('should detect interpolation errors when key and JSON value differ (value has interpolation, key does not)', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
        output: 'locales/{{language}}.json',
      },
      lint: {},
    }

    // The translation key is "ABC" (no interpolation markers),
    // but the JSON value is "hello {{name}}" (requires {{name}}).
    // The linter must resolve the key against the translation file and
    // check the *value*, not the key string.
    vol.fromJSON({
      '/src/App.tsx': [
        'import { useTranslation } from "react-i18next"',
        'function MyComponent() {',
        '  const { t } = useTranslation()',
        '  t("ABC", { A: "abc" })',  // line 4: wrong param, missing {{name}}
        '  t("ABC")',                 // line 5: missing {{name}}
        '}',
      ].join('\n'),
      '/locales/en.json': JSON.stringify({ ABC: 'hello {{name}}' }),
    })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    const issues = result.files['/src/App.tsx']
    expect(issues).toBeDefined()

    const texts = issues.map(i => i.text)

    // Line 4: "name" is missing, "A" is unused
    expect(texts).toContain('Interpolation parameter "name" was not provided')
    expect(texts).toContain('Parameter "A" is not used in translation string')

    // Line 5: "name" is missing (no params passed at all)
    // There should be two separate "name was not provided" errors (one per call site)
    expect(issues.filter(i => i.text === 'Interpolation parameter "name" was not provided')).toHaveLength(2)
  })

  it('should report correct line numbers for duplicate t() calls with interpolation errors', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t'],
      },
      lint: {},
    }

    // Three identical t() calls, each on its own line.
    // Each should report its own correct line number, not all pointing to line 5.
    const sampleCode = [
      'import { useTranslation } from "react-i18next"',  // line 1
      'function MyComponent() {',                          // line 2
      '  const { t } = useTranslation()',                 // line 3
      '  t("Hello {{name}}")',                            // line 4
      '  t("Hello {{name}}")',                            // line 5
      '  t("Hello {{name}}")',                            // line 6
      '}',                                                // line 7
    ].join('\n')

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)

    expect(result.success).toBe(false)
    const issues = result.files['/src/App.tsx']
    expect(issues).toBeDefined()
    expect(issues).toHaveLength(3)

    const lines = issues.map(i => i.line).sort((a, b) => a - b)

    // Each call site must have its own distinct line number
    expect(lines).toEqual([4, 5, 6])
  })
})
