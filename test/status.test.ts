import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runStatus } from '../src/status'
import type { I18nextToolkitConfig, ExtractedKey } from '../src/index'
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

describe('status (summary view)', () => {
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
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key.a', { key: 'key.a', ns: 'translation' }],
      ['translation:key.d', { key: 'key.d', ns: 'translation' }],
      ['translation:key.c', { key: 'key.c', ns: 'translation' }],
      ['translation:key.b', { key: 'key.b', ns: 'translation' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    vol.fromJSON({
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: { a: 'Wert A', b: 'Wert B' },
      }),
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        key: { a: 'Valeur A', b: 'Valeur B', c: 'Valeur C' },
      }),
    })

    await runStatus(mockConfig)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         4'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■□□□□□□□□□□] 50% (2/4 keys)'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- fr: [■■■■■■■■■■■■■■■□□□□□] 75% (3/4 keys)'))
  })

  it('should correctly calculate progress with multiple namespaces', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      // 4 keys in 'translation' ns
      ['translation:app.title', { key: 'app.title', ns: 'translation' }],
      ['translation:app.welcome', { key: 'app.welcome', ns: 'translation' }],
      ['translation:app.error', { key: 'app.error', ns: 'translation' }],
      ['translation:app.loading', { key: 'app.loading', ns: 'translation' }],
      // 2 keys in 'common' ns
      ['common:button.save', { key: 'button.save', ns: 'common' }],
      ['common:button.cancel', { key: 'button.cancel', ns: 'common' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    vol.fromJSON({
      // 3 of 4 keys translated for 'translation' ns
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        app: { title: 'Titel', welcome: 'Willkommen', error: 'Fehler' },
      }),
      // 1 of 2 keys translated for 'common' ns
      [resolve(process.cwd(), 'locales/de/common.json')]: JSON.stringify({
        button: { save: 'Speichern' },
      }),
    })

    await runStatus(mockConfig)

    // Total keys = 6. Translated = 3 (translation) + 1 (common) = 4.
    // Progress should be 4/6 = 67%
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         6'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■■■■□□□□□□□] 67% (4/6 keys)'))
  })
})

describe('status (detailed view)', () => {
  let consoleLogSpy: any

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should display a grouped, key-by-key report for a specific locale', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:app.title', { key: 'app.title', ns: 'translation' }],
      ['common:button.save', { key: 'button.save', ns: 'common' }],
      ['translation:app.welcome', { key: 'app.welcome', ns: 'translation' }],
      ['common:button.cancel', { key: 'button.cancel', ns: 'common' }],
    ])
    vi.mocked(findKeys).mockResolvedValue(mockKeys)

    vol.fromJSON({
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        app: { title: 'Titel', welcome: '' }, // 'welcome' is untranslated
      }),
      [resolve(process.cwd(), 'locales/de/common.json')]: JSON.stringify({
        button: { save: 'Speichern' }, // 'cancel' is missing
      }),
    })

    await runStatus(mockConfig, { detail: 'de' })

    // Check for namespace headers
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Namespace: common'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Namespace: translation'))

    // Check for specific key statuses
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✓'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('button.save'))

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✗'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('button.cancel')) // Missing from file

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✓'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('app.title'))

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✗'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('app.welcome')) // Has empty string value

    // Check final summary
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 missing translations for "de"'))
  })

  it('should show a warning when checking the primary language', async () => {
    await runStatus(mockConfig, { detail: 'en' })
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('is the primary language'))
  })

  it('should show an error for an invalid locale', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runStatus(mockConfig, { detail: 'jp' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('is not defined in your configuration'))
  })
})
