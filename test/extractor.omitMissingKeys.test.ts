import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('runExtractor: omitMissingKeys option', () => {
  let tempDir: string

  const baseConfig = (): I18nextToolkitConfig => ({
    locales: ['en', 'de', 'fr'],
    extract: {
      input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
      output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
      functions: ['t'],
      defaultNS: 'translation',
    },
  })

  const readJson = async (language: string, namespace = 'translation') =>
    JSON.parse(await fs.readFile(join(tempDir, 'locales', language, `${namespace}.json`), 'utf-8'))

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-omit-missing-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    for (const locale of ['en', 'de', 'fr']) {
      await fs.mkdir(join(tempDir, 'locales', locale), { recursive: true })
    }
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('omits missing keys only for the listed languages and keeps existing translations', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), `
      t('button.save', 'Save');
      t('button.cancel', 'Cancel');
      t('welcome.title', 'Welcome');
    `)
    await fs.writeFile(join(tempDir, 'locales', 'fr', 'translation.json'), JSON.stringify({
      button: { save: 'Enregistrer' },
      legacy: { old: 'Vieux' },
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = ['fr']

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('en')).toEqual({
      button: { save: 'Save', cancel: 'Cancel' },
      welcome: { title: 'Welcome' },
    })
    // German is not listed: it still gets placeholders for every key.
    expect(await readJson('de')).toEqual({
      button: { save: '', cancel: '' },
      welcome: { title: '' },
    })
    // French keeps its translation, gets no placeholders, and still drops unused keys.
    expect(await readJson('fr')).toEqual({
      button: { save: 'Enregistrer' },
    })
  })

  it('omits missing keys for every secondary language when set to true', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), `
      t('button.save', 'Save');
      t('button.cancel', 'Cancel');
    `)
    await fs.writeFile(join(tempDir, 'locales', 'de', 'translation.json'), JSON.stringify({
      button: { save: 'Speichern' },
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = true

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('en')).toEqual({
      button: { save: 'Save', cancel: 'Cancel' },
    })
    expect(await readJson('de')).toEqual({
      button: { save: 'Speichern' },
    })
    // Nothing left to write for French: no placeholder file is created at all.
    await expect(fs.access(join(tempDir, 'locales', 'fr', 'translation.json'))).rejects.toThrow()
  })

  it('keeps existing plural forms and omits the generated placeholder forms', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), "t('item', { count: 2 });")
    await fs.writeFile(join(tempDir, 'locales', 'fr', 'translation.json'), JSON.stringify({
      item_one: 'Article',
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = ['fr']

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('fr')).toEqual({
      item_one: 'Article',
    })
  })

  it('omits new keys while preserving unused keys when removeUnusedKeys is false', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), "t('new.key', 'New');")
    await fs.writeFile(join(tempDir, 'locales', 'fr', 'translation.json'), JSON.stringify({
      legacy: 'Vieux',
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = ['fr']
    config.extract.removeUnusedKeys = false

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('fr')).toEqual({
      legacy: 'Vieux',
    })
  })

  it('works with flat keys (keySeparator: false)', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), `
      t('button.save', 'Save');
      t('button.cancel', 'Cancel');
    `)
    await fs.writeFile(join(tempDir, 'locales', 'fr', 'translation.json'), JSON.stringify({
      'button.save': 'Enregistrer',
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = ['fr']
    config.extract.keySeparator = false

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('fr')).toEqual({
      'button.save': 'Enregistrer',
    })
  })

  it('drops keys cleared by syncAll instead of writing an empty string', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), "t('button.save', 'Save');")
    await fs.writeFile(join(tempDir, 'locales', 'en', 'translation.json'), JSON.stringify({
      button: { save: 'Old' },
    }, null, 2))
    await fs.writeFile(join(tempDir, 'locales', 'fr', 'translation.json'), JSON.stringify({
      button: { save: 'Enregistrer' },
    }, null, 2))

    const config = baseConfig()
    config.locales = ['en', 'fr']
    config.extract.omitMissingKeys = ['fr']

    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true, syncAll: true })

    expect(await readJson('en')).toEqual({ button: { save: 'Save' } })
    expect(await readJson('fr')).toEqual({})
  })

  it('keeps writing placeholders when the option is not set', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), "t('button.save', 'Save');")

    const config = baseConfig()
    config.locales = ['en', 'fr']

    await runExtractor(config, { isDryRun: false })

    expect(await readJson('en')).toEqual({ button: { save: 'Save' } })
    expect(await readJson('fr')).toEqual({ button: { save: '' } })
  })

  it('works with merged namespace files', async () => {
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), `
      t('button.save', 'Save');
      t('button.cancel', 'Cancel');
    `)
    await fs.writeFile(join(tempDir, 'locales', 'fr.json'), JSON.stringify({
      translation: { button: { save: 'Enregistrer' } },
    }, null, 2))

    const config = baseConfig()
    config.extract.omitMissingKeys = ['fr']
    config.extract.output = normalizePath(join(tempDir, 'locales/{{language}}.json'))
    config.extract.mergeNamespaces = true

    await runExtractor(config, { isDryRun: false })

    const fr = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'fr.json'), 'utf-8'))
    expect(fr).toEqual({
      translation: { button: { save: 'Enregistrer' } },
    })
  })
})
