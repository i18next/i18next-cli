import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('allPluralForms option', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-all-plural-forms-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should generate all 6 CLDR plural forms for the primary language when allPluralForms is true', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))

    // English normally only gets _one and _other, but with allPluralForms
    // it should get all 6 CLDR forms
    expect(en.translation.item_zero).toBeDefined()
    expect(en.translation.item_one).toBeDefined()
    expect(en.translation.item_two).toBeDefined()
    expect(en.translation.item_few).toBeDefined()
    expect(en.translation.item_many).toBeDefined()
    expect(en.translation.item_other).toBeDefined()
  })

  it('should generate all 6 CLDR plural forms for secondary languages when allPluralForms is true', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const dePath = join(tempDir, 'locales', 'de.json')
    const de = JSON.parse(await fs.readFile(dePath, 'utf-8'))

    // German normally only gets _one and _other, but with allPluralForms
    // it should get all 6 CLDR forms
    expect(de.translation.item_zero).toBeDefined()
    expect(de.translation.item_one).toBeDefined()
    expect(de.translation.item_two).toBeDefined()
    expect(de.translation.item_few).toBeDefined()
    expect(de.translation.item_many).toBeDefined()
    expect(de.translation.item_other).toBeDefined()
  })

  it('should NOT generate extra plural forms when allPluralForms is false/unset', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        // allPluralForms is not set (defaults to false)
      },
    }

    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))

    // English should only get _one and _other (normal behavior)
    expect(en.translation.item_one).toBeDefined()
    expect(en.translation.item_other).toBeDefined()
    expect(en.translation.item_zero).toBeUndefined()
    expect(en.translation.item_two).toBeUndefined()
    expect(en.translation.item_few).toBeUndefined()
    expect(en.translation.item_many).toBeUndefined()
  })

  it('should generate all plural forms with defaultValues preserved', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3, defaultValue_one: '{{count}} item', defaultValue_other: '{{count}} items' })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
        keySeparator: false,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const plPath = join(tempDir, 'locales', 'pl.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // English primary language should have all 6 forms
    expect(en.translation.item_zero).toBeDefined()
    expect(en.translation.item_one).toBeDefined()
    expect(en.translation.item_two).toBeDefined()
    expect(en.translation.item_few).toBeDefined()
    expect(en.translation.item_many).toBeDefined()
    expect(en.translation.item_other).toBeDefined()

    // Polish secondary language should also have all 6 forms
    expect(pl.translation.item_zero).toBeDefined()
    expect(pl.translation.item_one).toBeDefined()
    expect(pl.translation.item_two).toBeDefined()
    expect(pl.translation.item_few).toBeDefined()
    expect(pl.translation.item_many).toBeDefined()
    expect(pl.translation.item_other).toBeDefined()
  })

  it('should preserve all plural forms across re-extractions with sync-primary', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
        removeUnusedKeys: true,
      },
    }

    // First extraction
    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const dePath = join(tempDir, 'locales', 'de.json')

    // Add translations
    const de1 = JSON.parse(await fs.readFile(dePath, 'utf-8'))
    de1.translation.item_one = 'Ein Artikel'
    de1.translation.item_other = '{{count}} Artikel'
    de1.translation.item_few = '{{count}} Artikel (wenige)'
    de1.translation.item_many = '{{count}} Artikel (viele)'
    await fs.writeFile(dePath, JSON.stringify(de1, null, 2), 'utf-8')

    // Second extraction with sync-primary
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const de2 = JSON.parse(await fs.readFile(dePath, 'utf-8'))

    // English should still have all 6 forms
    expect(en2.translation.item_zero).toBeDefined()
    expect(en2.translation.item_one).toBeDefined()
    expect(en2.translation.item_two).toBeDefined()
    expect(en2.translation.item_few).toBeDefined()
    expect(en2.translation.item_many).toBeDefined()
    expect(en2.translation.item_other).toBeDefined()

    // German translations should be preserved
    expect(de2.translation.item_one).toEqual('Ein Artikel')
    expect(de2.translation.item_other).toEqual('{{count}} Artikel')
    expect(de2.translation.item_few).toEqual('{{count}} Artikel (wenige)')
    expect(de2.translation.item_many).toEqual('{{count}} Artikel (viele)')
  })
})
