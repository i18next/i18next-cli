import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runStatus } from '../src/status'
import type { I18nextToolkitConfig, ExtractedKey } from '../src/types'
import { resolve } from 'path'

// Mock dependencies
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock the core key extractor
vi.mock('../src/extractor/core/key-finder', () => ({
  findKeys: vi.fn(),
}))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
    primaryLanguage: 'en',
  },
}

describe('status', () => {
  let consoleLogSpy: any

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should generate a correct status report for partially translated languages', async () => {
    // 1. Setup Mocks
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key.a', { key: 'key.a', ns: 'translation' }],
      ['translation:key.b', { key: 'key.b', ns: 'translation' }],
      ['translation:key.c', { key: 'key.c', ns: 'translation' }],
      ['translation:key.d', { key: 'key.d', ns: 'translation' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    // Setup virtual file system
    vol.fromJSON({
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: { a: 'Wert A', b: 'Wert B' }, // 2 of 4 keys translated
      }),
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        key: { a: 'Valeur A', b: 'Valeur B', c: 'Valeur C' }, // 3 of 4 keys translated
      }),
    })

    // 2. Run the function
    await runStatus(mockConfig)

    // 3. Assert the output
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('i18next Project Status'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         4'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Translation Progress:'))

    // Check German (de) progress: 2/4 keys = 50%
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■□□□□□□□□□□] 50% (2/4 keys)'))

    // Check French (fr) progress: 3/4 keys = 75%
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- fr: [■■■■■■■■■■■■■■■□□□□□] 75% (3/4 keys)'))

    // Check for the locize funnel message
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Take your localization to the next level!'))
  })

  it('should handle missing translation files gracefully', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key.a', { key: 'key.a', ns: 'translation' }],
      ['translation:key.b', { key: 'key.b', ns: 'translation' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    // Only provide the German file, French is missing
    vol.fromJSON({
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: { a: 'Wert A', b: 'Wert B' }, // 2/2 keys
      }),
    })

    await runStatus(mockConfig)

    // German should be 100%
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■■■■■■■■■■■] 100% (2/2 keys)'))
    // French should be 0% as the file is missing
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- fr: [□□□□□□□□□□□□□□□□□□□□] 0% (0/2 keys)'))
  })

  it('should ignore extraneous keys in translation files that are not in the source code', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    // Source code only has 2 keys
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key.a', { key: 'key.a', ns: 'translation' }],
      ['translation:key.b', { key: 'key.b', ns: 'translation' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    // The German file has an old, unused key ('old_key')
    vol.fromJSON({
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: { a: 'Wert A' }, // Only 1 of 2 source keys is present
        old_key: 'Dieser Schlüssel ist veraltet',
      }),
    })

    await runStatus(mockConfig)

    // The status should be based on the 2 keys found in the source code, not the 3 keys in the JSON file.
    // Therefore, progress is 1/2 = 50%.
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■□□□□□□□□□□] 50% (1/2 keys)'))
  })
})
