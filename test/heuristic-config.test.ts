import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { detectConfig } from '../src/heuristic-config'
import { normalizePath } from './utils/path'
import { resolve } from 'node:path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

describe('heuristic-config', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should successfully detect a common project structure and prioritize "en"', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/en/translation.json'])

    vol.fromJSON({
      'locales/de/common.json': '{}',
      'locales/en/translation.json': '{}',
      'locales/fr/translation.json': '{}',
      'locales/README.md': 'not a locale',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    expect(config?.locales).toEqual(['en', 'de', 'fr'])
    // accept either a string template or a function that resolves to a sample path
    if (typeof config?.extract?.output === 'string') {
      expect(normalizePath(config.extract.output)).toBe('locales/{{language}}/{{namespace}}.json')
    } else if (typeof config?.extract?.output === 'function') {
      const sample = config.extract.output('en', 'translation')
      expect(normalizePath(sample)).toBe('locales/en/translation.json')
    } else {
      throw new Error('unexpected extract.output shape')
    }
    expect(config?.extract?.primaryLanguage).toBe('en')
    // no source directory exists: the usual one
    expect(config?.extract?.input).toEqual(['src/**/*.{js,jsx,mjs,ts,tsx}'])
  })

  it('covers the source directories that exist, and takes what next-i18next and i18next-icu set', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      if (String(pattern).startsWith('{i18n.config')) return ['i18n.config.ts']
      return String(pattern) === 'public/locales/en/*.json' ? ['public/locales/en/home.json', 'public/locales/en/footer.json'] : []
    })

    vol.fromJSON({
      // readProjectDeps reads it by its absolute path
      [resolve('package.json')]: JSON.stringify({ dependencies: { next: '16.0.0', 'next-i18next': '16.4.0', 'i18next-icu': '2.6.0' } }),
      'i18n.config.ts': "export default { supportedLngs: ['en', 'de'], fallbackLng: 'en', defaultNS: 'home' }",
      'app/page.tsx': '',
      'components/Header.tsx': '',
      'public/locales/en/home.json': '{ "blog.title": "Blog" }',
      'public/locales/en/footer.json': '{ "description": "Footer" }',
      'public/locales/de/home.json': '{}',
    })

    const config = await detectConfig()

    expect(config?.extract?.input).toEqual(['{app,components}/**/*.{js,jsx,mjs,ts,tsx}'])
    expect(config?.extract?.defaultNS).toBe('home')
    expect(config?.extract?.messageFormat).toBe('icu')
    // flat keys with a dot in them stay flat
    expect(config?.extract?.keySeparator).toBe(false)
  })

  it("takes next-i18next's default namespace, common, when its config sets none", async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => String(pattern) === 'public/locales/en/*.json' ? ['public/locales/en/common.json'] : [])

    vol.fromJSON({
      [resolve('package.json')]: JSON.stringify({ dependencies: { next: '16.0.0', 'next-i18next': '16.4.0' } }),
      'public/locales/en/common.json': '{ "nested": { "title": "Title" } }',
      'public/locales/de/common.json': '{}',
    })

    const config = await detectConfig()

    expect(config?.extract?.defaultNS).toBe('common')
    expect(config?.extract?.keySeparator).toBeUndefined()
  })

  it('should return null if no recognizable structure is found', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([])

    const config = await detectConfig()

    expect(config).toBeNull()
  })

  it('should prioritize "dev" as the first locale if "en" is not present', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/dev/translation.json'])

    vol.fromJSON({
      'locales/de/translation.json': '{}',
      'locales/fr/common.json': '{}',
      'locales/dev/translation.json': '{}',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    // 'dev' should be moved to the front, followed by the rest sorted alphabetically
    expect(config?.locales).toEqual(['dev', 'de', 'fr'])
    // The primary language should default to the first in the prioritized list
    expect(config?.extract?.primaryLanguage).toBe('dev')
  })

  it('should fall back to alphabetical order when neither "en" nor "dev" are present', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/fr/translation.json'])

    vol.fromJSON({
      'locales/it/translation.json': '{}',
      'locales/fr/common.json': '{}',
      'locales/de/translation.json': '{}',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    // The locales should be sorted alphabetically
    expect(config?.locales).toEqual(['de', 'fr', 'it'])
    // The primary language should default to the first in the alphabetical list
    expect(config?.extract?.primaryLanguage).toBe('de')
  })

  it('should detect JSON5 project structure and infer outputFormat as json5', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/en/translation.json5'])

    vol.fromJSON({
      'locales/en/translation.json5': '{}',
      'locales/de/translation.json5': '{}',
      'locales/fr/translation.json5': '{}',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    expect(config?.locales).toEqual(['en', 'de', 'fr'])
    expect(config?.extract?.outputFormat).toBe('json5')
    if (typeof config?.extract?.output === 'string') {
      expect(normalizePath(config.extract.output)).toBe('locales/{{language}}/{{namespace}}.json5')
    }
  })

  it('should detect mixed .json and .json5 files and prioritize .json5', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/en/translation.json5', 'locales/en/translation.json'])

    vol.fromJSON({
      'locales/en/translation.json5': '{}',
      'locales/en/translation.json': '{}',
      'locales/de/translation.json5': '{}',
      'locales/de/translation.json': '{}',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    expect(config?.extract?.outputFormat).toBe('json5')
    if (typeof config?.extract?.output === 'string') {
      expect(normalizePath(config.extract.output)).toBe('locales/{{language}}/{{namespace}}.json5')
    }
  })

  it('should detect YAML project structure and infer outputFormat as yaml', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/en/translation.yaml'])

    vol.fromJSON({
      'locales/en/translation.yaml': 'key: value',
      'locales/de/translation.yaml': 'key: wert',
      'locales/fr/translation.yaml': 'key: valeur',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    expect(config?.locales).toEqual(['en', 'de', 'fr'])
    expect(config?.extract?.outputFormat).toBe('yaml')
    if (typeof config?.extract?.output === 'string') {
      expect(normalizePath(config.extract.output)).toBe('locales/{{language}}/{{namespace}}.yaml')
    }
  })

  it('should detect .yml project structure and infer outputFormat as yaml', async () => {
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['locales/en/translation.yml'])

    vol.fromJSON({
      'locales/en/translation.yml': 'key: value',
      'locales/de/translation.yml': 'key: wert',
    })

    const config = await detectConfig()

    expect(config).not.toBeNull()
    expect(config?.locales).toEqual(['en', 'de'])
    expect(config?.extract?.outputFormat).toBe('yaml')
    if (typeof config?.extract?.output === 'string') {
      expect(normalizePath(config.extract.output)).toBe('locales/{{language}}/{{namespace}}.yml')
    }
  })
})
