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

  it('should handle defaultNS: false correctly', async () => {
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

    expect(content).toContain('defaultNS: false;')
    expect(content).not.toContain("defaultNS: 'translation';")
  })
})
