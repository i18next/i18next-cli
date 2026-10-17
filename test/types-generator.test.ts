import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runTypesGenerator } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))
vi.mock('i18next-resources-for-ts', () => ({
  mergeResourcesAsInterface: vi.fn(),
}))

// Updated config to test the new `resourcesFile` feature
const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
  types: {
    input: ['locales/en/*.json'],
    output: 'src/types/i18next.d.ts',
    resourcesFile: 'src/types/resources.d.ts', // Explicitly define the resources file
  },
}

describe('types-generator', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    const { mergeResourcesAsInterface } = await import('i18next-resources-for-ts')

    ;(glob as any).mockResolvedValue(['/locales/en/translation.json'])
    ;(mergeResourcesAsInterface as any).mockReturnValue('export default interface Resources { /* ... */ }')
  })

  it('should generate a main definition file and a separate resources file', async () => {
    // 1. Setup
    vol.fromJSON({
      '/locales/en/translation.json': JSON.stringify({ key: 'value' }),
    })

    // 2. Action
    await runTypesGenerator(mockConfig)

    // 3. Assertions
    const mainOutputPath = resolve(process.cwd(), mockConfig.types!.output)
    const resourcesOutputPath = resolve(process.cwd(), mockConfig.types!.resourcesFile!)

    const mainOutputFileContent = await vol.promises.readFile(mainOutputPath, 'utf-8')
    const resourcesFileContent = await vol.promises.readFile(resourcesOutputPath, 'utf-8')

    // Check the resources file
    expect(resourcesFileContent).toContain('export default interface Resources')

    // Check the main definition file
    expect(mainOutputFileContent).toContain("import type Resources from './resources';")
    expect(mainOutputFileContent).toContain("declare module 'i18next'")
    expect(mainOutputFileContent).toContain('interface CustomTypeOptions')
    expect(mainOutputFileContent).toContain('resources: Resources;')
  })

  it('should use default paths when types configuration is minimal', async () => {
    const { mergeResourcesAsInterface } = await import('i18next-resources-for-ts')

    // Provide a config where the `types` object is empty
    const minimalConfig: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      types: {
      // Intentionally leave input and output undefined to test fallbacks
      } as any,
    }

    vol.fromJSON({
    // Create a file at the location the default fallback logic should find
      '/locales/en/translation.json': JSON.stringify({ key: 'value' }),
    })
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/locales/en/translation.json'])

    await runTypesGenerator(minimalConfig)

    // Assert that the function still called the core logic
    expect(mergeResourcesAsInterface).toHaveBeenCalled()

  // You can also assert that files were created at the default output paths,
  // for example: `expect(vol.existsSync('src/@types/i18next.d.ts')).toBe(true)`
  })

  describe('messageFormat icu / mf2', () => {
    const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

    const withI18next = (version: string) => ({ [resolve(process.cwd(), 'node_modules/i18next/package.json')]: JSON.stringify({ version }) })

    it.each(['icu', 'mf2'] as const)('sets parseInterpolation: \'%s\' when i18next is 26.5.0 or later', async (messageFormat) => {
      vol.fromJSON({ '/locales/en/translation.json': JSON.stringify({ rows: '{count, plural, one {{count} row} other {{count} rows}}' }), ...withI18next('26.5.0') })

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat } }, { logger: silentLogger() })

      const content = await vol.promises.readFile(resolve(process.cwd(), mockConfig.types!.output), 'utf-8')
      expect(content).toContain(`parseInterpolation: '${messageFormat}';`)
    })

    it('finds a hoisted i18next in a parent directory', async () => {
      vol.fromJSON({ '/locales/en/translation.json': JSON.stringify({ key: 'value' }), [resolve(process.cwd(), '..', 'node_modules/i18next/package.json')]: JSON.stringify({ version: '27.0.0' }) })

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'icu' } }, { logger: silentLogger() })

      expect(await vol.promises.readFile(resolve(process.cwd(), mockConfig.types!.output), 'utf-8')).toContain("parseInterpolation: 'icu';")
    })

    it.each([['26.4.7'], [undefined]])('sets parseInterpolation: false for i18next %s', async (version) => {
      vol.fromJSON({ '/locales/en/translation.json': JSON.stringify({ key: 'value' }), ...(version ? withI18next(version) : {}) })

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'mf2' } }, { logger: silentLogger() })

      expect(await vol.promises.readFile(resolve(process.cwd(), mockConfig.types!.output), 'utf-8')).toContain('parseInterpolation: false;')
    })

    it('does not set parseInterpolation for the i18next format', async () => {
      vol.fromJSON({ '/locales/en/translation.json': JSON.stringify({ key: 'value' }) })

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'i18next' } }, { logger: silentLogger() })

      const content = await vol.promises.readFile(resolve(process.cwd(), mockConfig.types!.output), 'utf-8')
      expect(content).not.toContain('parseInterpolation')
    })

    it('warns when an existing i18next.d.ts does not set parseInterpolation, and leaves it unchanged', async () => {
      const outputPath = resolve(process.cwd(), mockConfig.types!.output)
      const existing = "declare module 'i18next' { interface CustomTypeOptions { defaultNS: 'translation' } }"
      vol.fromJSON({
        '/locales/en/translation.json': JSON.stringify({ key: 'value' }),
        [outputPath]: existing,
      })
      const logger = silentLogger()

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'icu' } }, { logger })

      expect(await vol.promises.readFile(outputPath, 'utf-8')).toBe(existing)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parseInterpolation: false;'))
    })

    it('suggests the typed value in the warning when i18next supports it', async () => {
      const outputPath = resolve(process.cwd(), mockConfig.types!.output)
      vol.fromJSON({
        '/locales/en/translation.json': JSON.stringify({ key: 'value' }),
        [outputPath]: "declare module 'i18next' { interface CustomTypeOptions { defaultNS: 'translation' } }",
        ...withI18next('26.5.1'),
      })
      const logger = silentLogger()

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'mf2' } }, { logger })

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("parseInterpolation: 'mf2';"))
    })

    it('hints at the typed value when an existing i18next.d.ts still sets parseInterpolation: false', async () => {
      const outputPath = resolve(process.cwd(), mockConfig.types!.output)
      const existing = "declare module 'i18next' { interface CustomTypeOptions { parseInterpolation: false; } }"
      vol.fromJSON({ '/locales/en/translation.json': JSON.stringify({ key: 'value' }), [outputPath]: existing, ...withI18next('26.5.0') })
      const logger = silentLogger()

      await runTypesGenerator({ ...mockConfig, extract: { ...mockConfig.extract, messageFormat: 'icu' } }, { logger })

      expect(await vol.promises.readFile(outputPath, 'utf-8')).toBe(existing)
      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("parseInterpolation: 'icu';"))
    })
  })
})
