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
})
