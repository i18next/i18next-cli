import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Linter, runLinter } from '../src/linter'
import type { I18nextToolkitConfig, Plugin, LintPluginContext } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: '',
    transComponents: ['Trans'],
  },
}

describe('plugin system: linter', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should run lintSetup once and provide LintPluginContext', async () => {
    let setupCalls = 0
    let receivedContext: LintPluginContext | undefined
    const plugin: Plugin = {
      name: 'lint-setup-and-transform',
      lintSetup: async (context) => {
        setupCalls += 1
        receivedContext = context
      },
      lintOnLoad: async (code, filePath) => {
        if (filePath.endsWith('.tsx')) {
          return '<p>Text from transformed tsx</p>'
        }
        return code
      }
    }

    vol.fromJSON({ '/src/App.tsx': '<Trans>This should be ignored</Trans>' })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [plugin]
    }

    const result = await runLinter(config)

    expect(setupCalls).toBe(1)
    expect(receivedContext).toBeDefined()
    expect(receivedContext?.config.locales).toEqual(['en'])
    expect(typeof receivedContext?.logger.info).toBe('function')
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Text from transformed tsx')
  })

  it('should use provided logger in lintSetup context', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const plugin: Plugin = {
      name: 'lint-context-logger',
      lintSetup: async (context) => {
        context.logger.info('from setup logger')
      }
    }

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [plugin]
    }
    vol.fromJSON({ '/src/App.tsx': '<Trans>ignored</Trans>' })

    const linter = new Linter(config, logger)
    await linter.run()

    expect(logger.info).toHaveBeenCalledWith('from setup logger')
  })

  it('should skip a file when lintOnLoad returns null', async () => {
    const plugin: Plugin = {
      name: 'lint-skip-file',
      lintOnLoad: async () => null
    }

    vol.fromJSON({ '/src/App.tsx': '<p>This should be skipped</p>' })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [plugin]
    }

    const result = await runLinter(config)
    expect(result.success).toBe(true)
    expect(Object.keys(result.files)).toHaveLength(0)
  })

  it('should apply lintExtensions as a skip hint', async () => {
    const tsOnlyPlugin: Plugin = {
      name: 'ts-only-lint-plugin',
      lintExtensions: ['.ts'],
      lintOnLoad: async () => 'const msg = "from ts plugin"'
    }

    vol.fromJSON({ '/src/App.tsx': '<p>Text in jsx</p>' })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [tsOnlyPlugin]
    }

    const result = await runLinter(config)
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Text in jsx')
  })

  it('should support lintExtensions without dot prefix', async () => {
    const plugin: Plugin = {
      name: 'tsx-extension-without-dot',
      lintExtensions: ['tsx'],
      lintOnLoad: async () => '<p>from extension hint</p>'
    }

    vol.fromJSON({ '/src/App.tsx': '<Trans>ignored</Trans>' })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [plugin]
    }

    const result = await runLinter(config)
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx'][0].text).toBe('from extension hint')
  })

  it('should run lintOnLoad hooks in sequence', async () => {
    const first: Plugin = {
      name: 'first',
      lintOnLoad: async () => '<p>first</p>'
    }
    const second: Plugin = {
      name: 'second',
      lintOnLoad: async (code) => code.replace('first', 'second')
    }

    vol.fromJSON({ '/src/App.tsx': '<Trans>ignored</Trans>' })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [first, second]
    }

    const result = await runLinter(config)
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx'][0].text).toBe('second')
  })

  it('should allow lintOnResult to filter and augment issues', async () => {
    const plugin: Plugin = {
      name: 'lint-filter-and-append',
      lintOnResult: async (_file, issues) => {
        const interpolation = issues.filter(issue => issue.type === 'interpolation')
        interpolation.push({ text: 'Synthetic lint issue', line: 1, type: 'hardcoded' })
        return interpolation
      }
    }

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.tsx'],
        functions: ['t']
      },
      plugins: [plugin]
    }

    const sampleCode = [
      '<p>Hardcoded jsx text</p>',
      't("Hello {{name}}")'
    ].join('\n')

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const result = await runLinter(config)
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx'].some(issue => issue.type === 'interpolation')).toBe(true)
    expect(result.files['/src/App.tsx'].some(issue => issue.text === 'Synthetic lint issue')).toBe(true)
  })

  it('should emit errors and continue when lint plugin throws in hooks', async () => {
    const plugin: Plugin = {
      name: 'lint-throws',
      lintSetup: async () => {
        throw new Error('setup boom')
      },
      lintOnLoad: async () => {
        throw new Error('load boom')
      },
      lintOnResult: async () => {
        throw new Error('result boom')
      }
    }

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [plugin]
    }
    vol.fromJSON({ '/src/App.tsx': '<p>Still lint this text</p>' })

    const linter = new Linter(config)
    const errorSpy = vi.fn()
    linter.on('error', errorSpy)

    const result = await linter.run()

    expect(errorSpy).toHaveBeenCalledTimes(3)
    expect((errorSpy.mock.calls[0][0] as Error).message).toContain('setup boom')
    expect((errorSpy.mock.calls[1][0] as Error).message).toContain('load boom')
    expect((errorSpy.mock.calls[2][0] as Error).message).toContain('result boom')
    expect(result.success).toBe(false)
    expect(result.files['/src/App.tsx']).toHaveLength(1)
    expect(result.files['/src/App.tsx'][0].text).toBe('Still lint this text')
  })

  it('exports Linter from the package root, reporting progress through .on as the README shows', async () => {
    const { Linter: ExportedLinter } = await import('../src/index')
    vol.fromJSON({ '/src/App.tsx': '<p>Text</p>' })
    const messages: string[] = []

    const linter = new ExportedLinter(mockConfig)
    linter.on('progress', ({ message }) => messages.push(message))
    await linter.run()

    expect(ExportedLinter).toBe(Linter)
    expect(messages).toContain('Analyzing 1 source files...')
  })

  it('parses what lintOnLoad made of a non-native file as TSX, as extract does', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/page.astro'])
    vol.fromJSON({ '/src/page.astro': '---\nconst title: string = "x"\n---\n<h1>Hardcoded title</h1>' })
    const plugin: Plugin = {
      name: 'astro-like',
      lintOnLoad: async () => 'const title: string = "x"\n;<><h1>Hardcoded title</h1></>'
    }

    const linter = new Linter({ ...mockConfig, plugins: [plugin] })
    const errorSpy = vi.fn()
    linter.on('error', errorSpy)
    const result = await linter.run()

    expect(errorSpy).not.toHaveBeenCalled()
    expect(result.files['/src/page.astro'].map(issue => issue.text)).toEqual(['Hardcoded title'])
  })

  it('skips a non-native file no plugin handles, as extract does, instead of failing to parse it', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/page.astro'])
    vol.fromJSON({ '/src/page.astro': '---\nconst title = "x"\n---\n<h1>Hardcoded title</h1>' })
    const warn = vi.fn()

    const linter = new Linter({ ...mockConfig, extract: { ...mockConfig.extract, input: ['src/**/*.{tsx,astro}'] } }, { warn, info: vi.fn(), error: vi.fn() })
    const errorSpy = vi.fn()
    linter.on('error', errorSpy)
    const result = await linter.run()

    expect(errorSpy).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm install -D i18next-cli-plugin-astro'))
  })
})
