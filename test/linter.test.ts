import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/types'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: '', // Not used by linter
  },
}

describe('linter', () => {
  let exitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])

    // Spy on console and process.exit
    vi.spyOn(console, 'log').mockImplementation(() => {})
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

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✅ No issues found.'))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('should detect a hardcoded string in a JSX element', async () => {
    const sampleCode = '<p>This is a hardcoded string.</p>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "This is a hardcoded string."'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should detect a hardcoded string in a JSX attribute', async () => {
    const sampleCode = '<img alt="A hardcoded alt text" />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found hardcoded string: "A hardcoded alt text"'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should ignore text inside a Trans component', async () => {
    const sampleCode = '<Trans>This text is a key and should be ignored</Trans>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runLinter(mockConfig)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✅ No issues found.'))
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
