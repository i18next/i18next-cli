import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { detectConfig } from '../src/heuristic-config'

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
    expect(config?.extract?.output).toBe('locales/{{language}}/{{namespace}}.json')
    expect(config?.extract?.primaryLanguage).toBe('en')
    expect(config?.extract?.input).toEqual([
      'src/**/*.{js,jsx,ts,tsx}',
      'app/**/*.{js,jsx,ts,tsx}',
      'pages/**/*.{js,jsx,ts,tsx}',
      'components/**/*.{js,jsx,ts,tsx}'
    ])
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
})
