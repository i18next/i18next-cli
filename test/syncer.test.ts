import { vol } from 'memfs'
import { resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { I18nextToolkitConfig } from '../src/index'
import { runSyncer } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
}

describe('syncer', () => {
  const enPath = resolve(process.cwd(), 'locales/en/translation.json')
  const dePath = resolve(process.cwd(), 'locales/de/translation.json')

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Setup the glob mock to find the primary language file
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])
  })

  it('should sync nested keys, adding missing and removing extra', async () => {
    const enTranslations = {
      header: {
        title: 'Welcome',
        subtitle: 'To the app',
      },
      common: {
        save: 'Save',
      },
    }

    const deTranslations = {
      header: {
        title: 'Willkommen',
        // "subtitle" is missing
      },
      common: {
        save: 'Speichern',
        cancel: 'Abbrechen', // "cancel" is extra and should be removed
      },
      extra: { // "extra" is an extra top-level key
        key: 'Bonus',
      },
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(enTranslations),
      [dePath]: JSON.stringify(deTranslations),
    })

    await runSyncer(mockConfig)

    const updatedDeContent = await vol.promises.readFile(dePath, 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent as string)

    const expectedDeJson = {
      header: {
        title: 'Willkommen',
        subtitle: '', // Was added
      },
      common: {
        save: 'Speichern',
        // "cancel" was removed
      },
      // "extra" was removed
    }

    expect(updatedDeJson).toEqual(expectedDeJson)
  })

  it('should use the configured defaultValue for missing keys', async () => {
    const enTranslations = { key1: 'Value 1', key2: 'Value 2' }
    const deTranslations = { key1: 'Wert 1' } // key2 is missing

    const configWithDefault: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        defaultValue: '[MISSING]', // <-- Set custom default value
      },
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(enTranslations),
      [dePath]: JSON.stringify(deTranslations),
    })

    await runSyncer(configWithDefault)

    const updatedDeContent = await vol.promises.readFile(dePath, 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent as string)

    expect(updatedDeJson).toEqual({
      key1: 'Wert 1',
      key2: '[MISSING]', // <-- Assert the custom default value was used
    })
  })

  it('should use function-based defaultValue for missing keys', async () => {
    const enTranslations = {
      user: { name: 'Name', email: 'Email' },
      settings: { theme: 'Theme' }
    }
    const deTranslations = {
      user: { name: 'Name' }, // email is missing
      // settings namespace is completely missing
    }

    const configWithFunctionDefault: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        defaultValue: (key: string, namespace: string, language: string, value: string) => {
          return `${language.toUpperCase()}_${namespace}_${key}_${value}`
        },
      },
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(enTranslations),
      [dePath]: JSON.stringify(deTranslations),
    })

    await runSyncer(configWithFunctionDefault)

    const updatedDeContent = await vol.promises.readFile(dePath, 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent as string)

    expect(updatedDeJson).toEqual({
      user: {
        name: 'Name', // Preserved existing value
        email: 'DE_translation_user.email_Email', // Function-generated default
      },
      settings: {
        theme: 'DE_translation_settings.theme_Theme', // Function-generated default
      },
    })
  })

  it('should handle function-based defaultValue errors gracefully', async () => {
    const enTranslations = { key1: 'Value 1', key2: 'Value 2' }
    const deTranslations = { key1: 'Wert 1' } // key2 is missing

    const configWithErrorFunction: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        defaultValue: (key: string, namespace: string, language: string) => {
          if (key === 'key2') {
            throw new Error('Test error')
          }
          return `${language}_${key}`
        },
      },
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(enTranslations),
      [dePath]: JSON.stringify(deTranslations),
    })

    await runSyncer(configWithErrorFunction)

    const updatedDeContent = await vol.promises.readFile(dePath, 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent as string)

    expect(updatedDeJson).toEqual({
      key1: 'Wert 1',
      key2: '', // Falls back to empty string when function throws
    })
  })

  it('should use the configured indentation for output files', async () => {
    const enTranslations = { key: 'Value' }

    const configWithIndent: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract, indentation: 4 }, // <-- Set indentation
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(enTranslations),
      // The 'de' file does not exist yet, it should be created.
    })

    await runSyncer(configWithIndent)

    const updatedDeContent = await vol.promises.readFile(dePath, 'utf-8')

    const expectedContent = JSON.stringify({ key: '' }, null, 4) + '\n' // Expect 4 spaces
    expect(updatedDeContent).toBe(expectedContent)
  })
})
