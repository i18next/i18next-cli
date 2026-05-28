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

describe('types-generator with yaml/json5 input', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases = [
    { ext: '.yaml', content: 'title: Upload\nnested:\n  hello: world\n' },
    { ext: '.yml', content: 'title: Upload\nnested:\n  hello: world\n' },
    { ext: '.json5', content: "{\n  // a comment\n  title: 'Upload',\n  nested: { hello: 'world' },\n}" },
  ]

  cases.forEach(({ ext, content }) => {
    it(`should support ${ext} input files`, async () => {
      const { glob } = await import('glob')
      const filename = `/locales/en/translation${ext}`
      ;(glob as any).mockResolvedValue([filename])

      vol.fromJSON({
        [filename]: content,
      })

      const config = {
        locales: ['en'],
        extract: {
          defaultNS: 'translation',
        },
        types: {
          input: [`locales/en/*${ext}`],
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await runTypesGenerator(config as any)

      expect(consoleErrorSpy).not.toHaveBeenCalled()

      const resourcesPath = resolve(process.cwd(), config.types.resourcesFile)
      expect(vol.existsSync(resourcesPath)).toBe(true)

      const resourcesFileContent = await vol.promises.readFile(resourcesPath, 'utf-8')
      expect(resourcesFileContent).toContain('"title": "Upload"')
      expect(resourcesFileContent).toContain('"hello": "world"')

      consoleErrorSpy.mockRestore()
    })
  })
})
