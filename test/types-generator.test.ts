import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runTypesGenerator } from '../src/types-generator'
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
    expect(mainOutputFileContent).toContain("import Resources from './resources';")
    expect(mainOutputFileContent).toContain("declare module 'i18next'")
    expect(mainOutputFileContent).toContain('interface CustomTypeOptions')
    expect(mainOutputFileContent).toContain('resources: Resources;')
  })
})
