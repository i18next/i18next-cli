import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'

import { runTypesGenerator } from '../src/types-generator'
import { resolve } from 'node:path'

// Mock fs/promises
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock i18next-resources-for-ts to avoid heavy runtime
vi.mock('i18next-resources-for-ts', () => ({
  mergeResourcesAsInterface: (resources: any[]) => 'export interface I18nResources {}',
}))

describe('runTypesGenerator with functional extract.output', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/project')

    // create resource files matching the functional output layout
    vol.fromJSON({
      '/project/packages/pkg/locales/en/pkg.json': JSON.stringify({ hello: 'world' }),
      '/project/packages/pkg/locales/de/pkg.json': JSON.stringify({ hello: 'welt' }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('generates resources types file from files placed by functional output', async () => {
    const config: any = {
      locales: ['en', 'de'],
      extract: {
        primaryLanguage: 'en',
        input: ['src/**/*.ts'],
        output: (lng: string, ns?: string) => `packages/${ns ?? 'pkg'}/locales/${lng}/${ns ?? 'pkg'}.json`,
      },
      // leave types undefined so generator derives defaults from extract.output
    }

    await runTypesGenerator(config)

    // default output is src/@types/i18next.d.ts -> resources file next to it
    const resourcesPath = resolve('/project', 'src/@types/resources.d.ts')
    const content = await vol.promises.readFile(resourcesPath, 'utf8')
    expect(content).toContain('export interface I18nResources')
  })
})
