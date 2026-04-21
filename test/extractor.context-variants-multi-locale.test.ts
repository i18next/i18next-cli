import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

// Covers i18next-cli issue #242:
// `t('exportType', { context: type })` with a fully dynamic context value
// (e.g. a function parameter the extractor cannot statically resolve) tags
// the base key as "accepting context" but cannot enumerate the actual
// context values. The primary locale keeps its context variants
// (`exportType_gas`, `exportType_water`) via `preserveContextVariants`.
// Secondary locales must receive those variants too — not just preserve what
// they already happen to contain.
describe('extractor: propagate context variants to secondary locales', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) return ['/src/App.tsx']
      if (typeof pattern === 'string' && pattern.startsWith('src/')) return ['/src/App.tsx']
      return []
    })
  })

  it('creates primary context variants in secondary locales with empty defaults', async () => {
    // Fully dynamic context — a function parameter the extractor cannot
    // statically resolve. Only the base key `exportType` gets registered,
    // tagged with keyAcceptingContext.
    const sampleCode = `
      function renderExport(type: string) {
        const { t } = useTranslation();
        return <option>{t('exportType', { context: type })}</option>
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const primaryTranslations = {
      exportType: 'Readings',
      exportType_gas: 'Gas Readings',
      exportType_water: 'Water Readings'
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/de'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(primaryTranslations, null, 2)
    )
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/de/translation.json'),
      JSON.stringify({}, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true
      }
    }

    const results = await extract(config)
    const en = results.find(r => r.locale === 'en')!.newTranslations
    const de = results.find(r => r.locale === 'de')!.newTranslations

    // Primary keeps all variants with their values
    expect(en.exportType).toBe('Readings')
    expect(en.exportType_gas).toBe('Gas Readings')
    expect(en.exportType_water).toBe('Water Readings')

    // Secondary gains the same key skeleton with empty placeholders
    expect(de.exportType).toBeDefined()
    expect(de.exportType_gas).toBe('')
    expect(de.exportType_water).toBe('')
  })

  it('preserves existing secondary values instead of overwriting them with empty', async () => {
    const sampleCode = `
      function renderExport(type: string) {
        const { t } = useTranslation();
        return <option>{t('exportType', { context: type })}</option>
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const primaryTranslations = {
      exportType: 'Readings',
      exportType_gas: 'Gas Readings',
      exportType_water: 'Water Readings'
    }
    const secondaryTranslations = {
      exportType: 'Ablesungen',
      exportType_gas: 'Gas Ablesungen'
      // exportType_water is missing — should be added as empty placeholder
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/de'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(primaryTranslations, null, 2)
    )
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/de/translation.json'),
      JSON.stringify(secondaryTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true
      }
    }

    const results = await extract(config)
    const de = results.find(r => r.locale === 'de')!.newTranslations

    expect(de.exportType).toBe('Ablesungen')
    expect(de.exportType_gas).toBe('Gas Ablesungen')
    expect(de.exportType_water).toBe('')
  })

  it('does NOT propagate primary context variants when preserveContextVariants is off', async () => {
    const sampleCode = `
      function renderExport(type: string) {
        const { t } = useTranslation();
        return <option>{t('exportType', { context: type })}</option>
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const primaryTranslations = {
      exportType: 'Readings',
      exportType_gas: 'Gas Readings',
      exportType_water: 'Water Readings'
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/de'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(primaryTranslations, null, 2)
    )
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/de/translation.json'),
      JSON.stringify({}, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
        // preserveContextVariants intentionally omitted (defaults to false)
      }
    }

    const results = await extract(config)
    const de = results.find(r => r.locale === 'de')!.newTranslations

    // Without preserveContextVariants the context variants remain locale-local
    expect(de.exportType_gas).toBeUndefined()
    expect(de.exportType_water).toBeUndefined()
  })
})
