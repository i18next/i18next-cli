import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runTypesGenerator } from '../src/types-generator'
import { resolve } from 'path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))
vi.mock('i18next-resources-for-ts', () => ({
  mergeResourcesAsInterface: vi.fn().mockReturnValue('export default interface Resources {}'),
}))

describe('types-generator with typescript input', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const extensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']

  extensions.forEach(ext => {
    it(`should support ${ext} input files`, async () => {
      const { glob } = await import('glob')
      const filename = `/locales/en${ext}`

      // Mock glob to return the file
      ;(glob as any).mockResolvedValue([filename])

      // Create file content based on extension
      let content = "export default { hello: 'world' };"
      if (ext === '.cjs') {
        content = "module.exports = { hello: 'world' };"
      } else if (['.ts', '.mts', '.cts'].includes(ext)) {
        content = "const resource: Record<string, string> = { hello: 'world' }; export default resource;"
      }

      // Create file content
      vol.fromJSON({
        [filename]: content,
      })

      const config = {
        locales: ['en'],
        extract: {
          defaultNS: 'translation',
        },
        types: {
          input: [`locales/*${ext}`],
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await runTypesGenerator(config as any)

      expect(consoleErrorSpy).not.toHaveBeenCalled()

      const resourcesPath = resolve(process.cwd(), config.types.resourcesFile)
      expect(vol.existsSync(resourcesPath)).toBe(true)

      consoleErrorSpy.mockRestore()
    })
  })

  it('should correctly handle typescript files with "as const" assertion', async () => {
    const { glob } = await import('glob')
    const { mergeResourcesAsInterface } = await import('i18next-resources-for-ts')
    const filename = '/locales/en.ts'

    // Mock glob to return the file
    ;(glob as any).mockResolvedValue([filename])

    // Create file content with "as const"
    const content = `
export default {
  helloThere: '',
  stacks: {
    titles: {
      home: '',
      login: '',
    },
  },
} as const;
`
    // Create file content
    vol.fromJSON({
      [filename]: content,
    })

    const config = {
      locales: ['en'],
      extract: {
        defaultNS: 'translation',
      },
      types: {
        input: ['locales/*.ts'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    expect(mergeResourcesAsInterface).toHaveBeenCalled()
    const calls = (mergeResourcesAsInterface as any).mock.calls
    const resourcesArg = calls[calls.length - 1][0]

    expect(resourcesArg).toHaveLength(1)
    expect(resourcesArg[0].name).toBe('en')
    expect(resourcesArg[0].resources).toEqual({
      helloThere: '',
      stacks: {
        titles: {
          home: '',
          login: '',
        },
      },
    })
  })

  it('should derive defaultNS from the resource namespace when defaultNS is false', async () => {
    const { glob } = await import('glob')
    const filename = '/locales/en.ts'
    ;(glob as any).mockResolvedValue([filename])

    vol.fromJSON({
      [filename]: "export default { hello: 'world' };",
    })

    const config = {
      locales: ['en'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/*.ts'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    const outputPath = resolve(process.cwd(), config.types.output)
    const content = await vol.promises.readFile(outputPath, 'utf-8')

    expect(content).toContain("defaultNS: 'en';")
    expect(content).not.toContain("defaultNS: 'translation';")
  })

  it('should dedupe and sort namespaces derived from multiple resource files', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([
      '/locales/en/common.json',
      '/locales/de/common.json',
      '/locales/en/app.json',
    ])

    vol.fromJSON({
      '/locales/en/common.json': JSON.stringify({ hello: 'world' }),
      '/locales/de/common.json': JSON.stringify({ hello: 'welt' }),
      '/locales/en/app.json': JSON.stringify({ title: 'App' }),
    })

    const config = {
      locales: ['en', 'de'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/**/*.json'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    const outputPath = resolve(process.cwd(), config.types.output)
    const content = await vol.promises.readFile(outputPath, 'utf-8')

    expect(content).toContain("defaultNS: 'app';")
  })

  it('should derive a single namespace from a namespaced layout', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/locales/en/common.json'])

    vol.fromJSON({
      '/locales/en/common.json': JSON.stringify({ hello: 'world' }),
    })

    const config = {
      locales: ['en'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/en/*.json'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    const outputPath = resolve(process.cwd(), config.types.output)
    const content = await vol.promises.readFile(outputPath, 'utf-8')

    expect(content).toContain("defaultNS: 'common';")
  })

  it('should keep defaultNS: false when resources are keyed per language file', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/locales/de.json', '/locales/en.json'])

    vol.fromJSON({
      '/locales/de.json': JSON.stringify({ hello: 'welt' }),
      '/locales/en.json': JSON.stringify({ hello: 'world' }),
    })

    const config = {
      locales: ['en', 'de'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/*.json'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    const outputPath = resolve(process.cwd(), config.types.output)
    const content = await vol.promises.readFile(outputPath, 'utf-8')

    expect(content).toContain('defaultNS: false;')
  })

  it('should warn about the derived defaultNS only when the output file is created', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/locales/en/common.json'])

    const outputPath = resolve(process.cwd(), 'src/types/i18next.d.ts')
    vol.fromJSON({
      '/locales/en/common.json': JSON.stringify({ hello: 'world' }),
      [outputPath]: '// user-adjusted\ndefaultNS: false;',
    })

    const config = {
      locales: ['en'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/en/*.json'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    await runTypesGenerator(config as any, { logger } as any)

    // An existing output file is left untouched, so no derivation happens
    const content = await vol.promises.readFile(outputPath, 'utf-8')
    expect(content).toContain('// user-adjusted')
    expect(logger.warn).not.toHaveBeenCalled()

    await vol.promises.rm(outputPath)
    await runTypesGenerator(config as any, { logger } as any)

    const regenerated = await vol.promises.readFile(outputPath, 'utf-8')
    expect(regenerated).toContain("defaultNS: 'common';")
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('extract.defaultNS is disabled'))
  })

  it('should keep defaultNS: false when no resource files are found', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([])

    const config = {
      locales: ['en'],
      extract: {
        defaultNS: false,
      },
      types: {
        input: ['locales/*.ts'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    const outputPath = resolve(process.cwd(), config.types.output)
    const content = await vol.promises.readFile(outputPath, 'utf-8')

    expect(content).toContain('defaultNS: false;')
  })

  it('should treat top-level keys as namespaces when mergeNamespaces: true and file matches locale', async () => {
    const { glob } = await import('glob')
    const { mergeResourcesAsInterface } = await import('i18next-resources-for-ts')

    // Use actual implementation to verify the generated output
    const { mergeResourcesAsInterface: realMerge } = await vi.importActual<typeof import('i18next-resources-for-ts')>('i18next-resources-for-ts')
    ;(mergeResourcesAsInterface as any).mockImplementation(realMerge)

    const filename = '/locales/en.ts'
    ;(glob as any).mockResolvedValue([filename])

    const content = `
export default {
  hello: {
    there: 'en#helloThere'
  },
  stacks: {
    titles: {
      home: 'en#stacks.titles.home',
      login: 'en#stacks.titles.login',
    },
  },
  flat: 'flat stuff',
} as const;
`
    vol.fromJSON({
      [filename]: content,
    })

    const config = {
      locales: ['en'],
      extract: {
        mergeNamespaces: true,
        defaultNS: false,
      },
      types: {
        input: ['locales/*.ts'],
        output: 'src/types/i18next.d.ts',
        resourcesFile: 'src/types/resources.d.ts',
      },
    }

    await runTypesGenerator(config as any)

    expect(mergeResourcesAsInterface).toHaveBeenCalled()
    const calls = (mergeResourcesAsInterface as any).mock.calls
    const resourcesArg = calls[calls.length - 1][0]

    // Expect resources to be split by top-level keys
    const namespaces = resourcesArg.map((r: any) => r.name).sort()
    expect(namespaces).toEqual(['hello', 'stacks'])

    const helloNs = resourcesArg.find((r: any) => r.name === 'hello')
    expect(helloNs.resources).toEqual({ there: 'en#helloThere' })

    const stacksNs = resourcesArg.find((r: any) => r.name === 'stacks')
    expect(stacksNs.resources).toEqual({
      titles: {
        home: 'en#stacks.titles.home',
        login: 'en#stacks.titles.login',
      },
    })

    const resourcesOutputPath = resolve(process.cwd(), config.types.resourcesFile)
    const resourcesFileContent = await vol.promises.readFile(resourcesOutputPath, 'utf-8')

    expect(resourcesFileContent).toContain('interface Resources {')
    expect(resourcesFileContent).toContain('"hello": {')
    expect(resourcesFileContent).toContain('"there": "en#helloThere"')
    expect(resourcesFileContent).toContain('"stacks": {')
    expect(resourcesFileContent).toContain('"titles": {')
    expect(resourcesFileContent).toContain('"home": "en#stacks.titles.home"')
    expect(resourcesFileContent).toContain('"login": "en#stacks.titles.login"')

    // `defaultNS: false` would leave `t()` untyped, so the derived namespaces
    // are emitted instead to keep the generated types self-consistent.
    const outputPath2 = resolve(process.cwd(), config.types.output)
    const outputContent = await vol.promises.readFile(outputPath2, 'utf-8')
    expect(outputContent).toContain("defaultNS: 'hello';")
  })
})
