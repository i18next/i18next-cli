import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'

import { runExtractor } from '../src/extractor/core/extractor'
import { resolve } from 'node:path'

// Mock fs/promises to use memfs
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock findKeys used by the extractor
vi.mock('../src/extractor/core/find-keys', () => ({
  findKeys: vi.fn().mockResolvedValue({ allKeys: new Map(), objectKeys: new Set() }),
}))

// Mock translation-manager.getTranslations used by the extractor
vi.mock('../src/extractor/core/translation-manager', () => ({
  getTranslations: vi.fn().mockResolvedValue([
    {
      path: '/project/packages/pkg/locales/en/pkg.json',
      newTranslations: { key: 'Value' },
      updated: true,
    },
  ]),
}))

describe('runExtractor with functional extract.output', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/project')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes translation files to paths returned by the output function', async () => {
    const config: any = {
      locales: ['en', 'de'],
      extract: {
        primaryLanguage: 'en',
        input: ['src/**/*.ts'],
        // functional output: per-package layout
        output: (lng: string, ns?: string) => `packages/${ns ?? 'pkg'}/locales/${lng}/${ns ?? 'pkg'}.json`,
        outputFormat: 'json',
        indentation: 2,
      },
      plugins: [],
    }

    const updated = await runExtractor(config, { isDryRun: false })
    expect(updated).toBe(true)

    const content = await vol.promises.readFile(resolve('/project', 'packages/pkg/locales/en/pkg.json'), 'utf8')
    expect(content).toContain('"key": "Value"')
  })
})
