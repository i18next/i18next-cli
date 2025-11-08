import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

// Mock filesystem used by extractor (both sync and promises layers)
vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock glob so extractor only scans test files we create in memfs
vi.mock('glob', () => ({ glob: vi.fn() }))

// Import runStatus AFTER mocks so internal modules use the mocked fs/glob
const { runStatus } = await import('../src/index')

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
}

describe('status (summary view)', () => {
  let consoleLogSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    // provide deterministic glob results: return only files we create in this test's memfs
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any, options?: any) => {
      // Return any memfs path that contains a /src/ segment (files are created with absolute cwd paths)
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should generate a correct status report for partially translated languages', async () => {
    // Create source files that the real extractor will scan
    vol.fromJSON({
      [resolve(process.cwd(), 'src/file1.ts')]: `
        import { t } from 'i18next'
        t('key.a')
        t('key.d')
        t('key.c')
        t('key.b')
      `,
      // translations present in memfs
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: { a: 'Wert A', b: 'Wert B' },
      }),
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        key: { a: 'Valeur A', b: 'Valeur B', c: 'Valeur C' },
      }),
    })

    await runStatus(mockConfig)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         4'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   1'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■□□□□□□□□□□] 50% (2/4 keys)'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- fr: [■■■■■■■■■■■■■■■□□□□□] 75% (3/4 keys)'))
  })

  it('should correctly calculate progress with multiple namespaces', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('app.title')
        t('app.welcome')
        t('app.error')
        t('app.loading')
      `,
      [resolve(process.cwd(), 'src/common.ts')]: `
        import { t } from 'i18next'
        t('button.save')
        t('button.cancel')
      `,
      // translations in memfs
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        app: { title: 'Titel', welcome: 'Willkommen', error: 'Fehler' },
      }),
      [resolve(process.cwd(), 'locales/de/common.json')]: JSON.stringify({
        button: { save: 'Speichern' },
      }),
    })

    await runStatus(mockConfig)

    // Total keys = 6. Translated (in the single namespace the extractor detected) = 3.
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         6'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   1'))
    // be resilient: check progress numbers rather than exact progress-bar glyphs
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('50% (3/6'))
  })

  it('should correctly calculate status for ordinal plurals', async () => {
    // Create source that uses an ordinal plural invocation.
    vol.fromJSON({
      [resolve(process.cwd(), 'src/ordinal.ts')]: `
        import { t } from 'i18next'
        const count = 2
        // extractor should detect hasCount and ordinal=true from this call shape
        t('place', { count, ordinal: true })
      `,
      // English has 4 ordinal forms; provide 2 translations
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        place_ordinal_one: '1st place',
        place_ordinal_other: 'nth place',
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['de', 'en'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'de',
      },
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- en: [■■■■■■■■■■□□□□□□□□□□] 50% (2/4 keys)'))
  })
})

describe('status (detailed view)', () => {
  let consoleLogSpy: any
  let consoleErrorSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any, options?: any) => {
      // Return any memfs path that contains a /src/ segment (files are created with absolute cwd paths)
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should show a warning when checking the primary language', async () => {
    // no source keys => extractor returns zero keys
    vol.fromJSON({
      [resolve(process.cwd(), 'src/empty.ts')]: 'console.log(\'no keys\')',
    })

    await runStatus(mockConfig, { detail: 'en' })

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('is the primary language'))
  })

  it('should show an error for an invalid locale', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/empty2.ts')]: 'console.log(\'no keys\')',
    })

    await runStatus(mockConfig, { detail: 'jp' })

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('is not defined in your configuration'))
  })
})

describe('status (namespace filtering)', () => {
  let consoleLogSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any, options?: any) => {
      // Return any memfs path that contains a /src/ segment (files are created with absolute cwd paths)
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should filter the detailed report by a single namespace', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('app.title')
        t('common:button.save')
      `,
      [resolve(process.cwd(), 'locales/de/common.json')]: JSON.stringify({
        button: { save: 'Speichern' },
      }),
    })

    await runStatus(mockConfig, { detail: 'de', namespace: 'common' })

    // Ensure the detailed report includes the namespaced key and excludes other keys
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('button.save'))
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('app.title'))
  })

  it('should filter the summary report by a single namespace', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/fileA.ts')]: `
        import { t } from 'i18next'
        t('key1')
        t('key2')
      `,
      [resolve(process.cwd(), 'src/fileB.ts')]: `
        import { t } from 'i18next'
        t('common:keyA')
        t('common:keyB')
      `,
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ key1: 'Wert 1' }),
      [resolve(process.cwd(), 'locales/de/common.json')]: JSON.stringify({ keyA: 'Wert A', keyB: 'Wert B' }),
    })

    await runStatus(mockConfig, { namespace: 'common' })

    // The summary for the 'common' namespace should show two keys and full translation coverage
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Status for Namespace'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2'))
  })

  it('should correctly report status for Arabic when primary language is English', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/item.ts')]: `
        import { t } from 'i18next'
        t('item', { count: 1 })
      `,
      [resolve(process.cwd(), 'locales/ar/translation.json')]: JSON.stringify({
        item_one: 'قطعة واحدة',
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'ar'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- ar: [■■■□□□□□□□□□□□□□□□□□] 17% (1/6 keys)'))
  })

  it('should correctly report status for English when primary language is Arabic', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/item2.ts')]: `
        import { t } from 'i18next'
        t('item', { count: 1 })
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        item_one: 'one item',
        item_other: 'other items',
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['ar', 'en'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'ar',
      },
    }

    await runStatus(config)

    // English should be 100% complete (2/2 keys) because English only needs 'one' and 'other' forms
    // Each language is evaluated based on its own plural rules, not the primary language's rules
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- en:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2 keys)'))
  })
})

describe('status (plurals)', () => {
  let consoleLogSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any, options?: any) => {
      // Return any memfs path that contains a /src/ segment (files are created with absolute cwd paths)
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should not double-expand already-expanded plural keys (regression)', async () => {
    // Create source that results in already-expanded plural keys being found by the real extractor.
    vol.fromJSON({
      [resolve(process.cwd(), 'src/plural-expanded.ts')]: `
        import { t } from 'i18next'
        t('key_one')
        t('key_other')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        key_one: 'One item',
        key_other: '{{count}} items',
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key_one: 'Ein Element',
        key_other: '{{count}} Elemente',
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   1'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■■■■■■■■■■■] 100% (2/2 keys)'))
  })

  it('should correctly report status for Swedish without requiring French plural forms', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/cake.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export const CakeComponent = ({ cakeCount }) => {
          const [t] = useTranslation("common")
          return <div>{t('cake', { count: cakeCount })}</div>
        }
      `,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify({
        cake_one: 'One cake',
        cake_other: '{{count}} cakes',
      }),
      [resolve(process.cwd(), 'locales/sv/common.json')]: JSON.stringify({
        cake_one: 'En tårta',
        cake_other: '{{count}} tårtor',
      }),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify({
        cake_one: 'Un gâteau',
        cake_many: 'Beaucoup de gâteaux',
        cake_other: '{{count}} gâteaux',
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'sv', 'fr'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
    }

    await runStatus(config)

    // Swedish should be 100% complete (2/2 keys), not 67% (2/3 keys)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- sv:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2 keys)'))

    // French should be 100% complete (3/3 keys)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- fr:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (3/3 keys)'))
  })
})
