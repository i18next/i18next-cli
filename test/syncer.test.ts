import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runSyncer } from '../src/syncer'
import type { I18nextToolkitConfig } from '../src/types'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
}

describe('syncer', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
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

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

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
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify(enTranslations),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify(deTranslations),
    })

    await runSyncer(configWithDefault)

    const updatedDeContent = await vol.promises.readFile(resolve(process.cwd(), 'locales/de/translation.json'), 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent as string)

    expect(updatedDeJson).toEqual({
      key1: 'Wert 1',
      key2: '[MISSING]', // <-- Assert the custom default value was used
    })
  })

  it('should use the configured indentation for output files', async () => {
    const enTranslations = { key: 'Value' }

    const configWithIndent: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract, indentation: 4 }, // <-- Set indentation
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify(enTranslations),
    })

    await runSyncer(configWithIndent)

    const updatedDeContent = await vol.promises.readFile(resolve(process.cwd(), 'locales/de/translation.json'), 'utf-8')

    const expectedContent = JSON.stringify({ key: '' }, null, 4) // Expect 4 spaces
    expect(updatedDeContent).toBe(expectedContent)
  })
})
