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

  it('should generate plural forms from all configured locales for the primary language', async () => {
    // English only needs _one/_other, but Polish needs _one/_few/_many/_other.
    // With allPluralForms, English should get the union: _one, _few, _many, _other.
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))

    // English should get the union of en (one, other) + pl (one, few, many, other)
    expect(en.translation.item_one).toBeDefined()
    expect(en.translation.item_few).toBeDefined()
    expect(en.translation.item_many).toBeDefined()
    expect(en.translation.item_other).toBeDefined()
  })

  it('should generate plural forms from all configured locales for secondary languages', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('item', { count: 3 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Polish should also get all forms from the union
    expect(pl.translation.item_one).toBeDefined()
    expect(pl.translation.item_few).toBeDefined()
    expect(pl.translation.item_many).toBeDefined()
    expect(pl.translation.item_other).toBeDefined()
  })

  it('should only generate forms needed by at least one configured locale (not all 6 CLDR forms)', async () => {
    // en + de both only need _one/_other.
    // With allPluralForms, the union is still just _one/_other — no _zero/_two/_few/_many.
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

    const enPath = join(tempDir, 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))

    // Union of en + de is just one/other — no extra forms
    expect(en.translation.item_one).toBeDefined()
    expect(en.translation.item_other).toBeDefined()
    expect(en.translation.item_zero).toBeUndefined()
    expect(en.translation.item_two).toBeUndefined()
    expect(en.translation.item_few).toBeUndefined()
    expect(en.translation.item_many).toBeUndefined()
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

  it('should apply defaultValues consistently to all generated plural forms', async () => {
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

    // English primary: all union forms should have defaultValues (not empty)
    expect(en.translation.item_one).toEqual('{{count}} item')
    expect(en.translation.item_other).toEqual('{{count}} items')
    // _few and _many come from Polish's categories, they should still get a defaultValue (not be empty)
    expect(en.translation.item_few).toBeDefined()
    expect(en.translation.item_few).not.toEqual('')
    expect(en.translation.item_many).toBeDefined()
    expect(en.translation.item_many).not.toEqual('')

    // Polish secondary: union forms should all be present
    expect(pl.translation.item_one).toBeDefined()
    expect(pl.translation.item_few).toBeDefined()
    expect(pl.translation.item_many).toBeDefined()
    expect(pl.translation.item_other).toBeDefined()

    // Forms NOT in the union (zero, two) should not exist
    expect(en.translation.item_zero).toBeUndefined()
    expect(en.translation.item_two).toBeUndefined()
    expect(pl.translation.item_zero).toBeUndefined()
    expect(pl.translation.item_two).toBeUndefined()
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
      locales: ['en', 'pl'],
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
    const plPath = join(tempDir, 'locales', 'pl.json')

    // Add translations
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))
    pl1.translation.item_one = '{{count}} przedmiot'
    pl1.translation.item_other = '{{count}} przedmiotów'
    pl1.translation.item_few = '{{count}} przedmioty'
    pl1.translation.item_many = '{{count}} przedmiotów'
    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction with sync-primary
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // English should still have all union forms
    expect(en2.translation.item_one).toBeDefined()
    expect(en2.translation.item_few).toBeDefined()
    expect(en2.translation.item_many).toBeDefined()
    expect(en2.translation.item_other).toBeDefined()

    // Polish translations should be preserved
    expect(pl2.translation.item_one).toEqual('{{count}} przedmiot')
    expect(pl2.translation.item_other).toEqual('{{count}} przedmiotów')
    expect(pl2.translation.item_few).toEqual('{{count}} przedmioty')
    expect(pl2.translation.item_many).toEqual('{{count}} przedmiotów')
  })

  it('should generate all 6 forms when a locale like Arabic requires them all', async () => {
    // Arabic needs zero, one, two, few, many, other — all 6 CLDR forms.
    // With allPluralForms + ar in locales, the union should include all 6.
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        return <p>{t('message', { count: 5 })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'ar'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        allPluralForms: true,
      },
    }

    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))

    // Union of en + ar includes all 6 forms
    expect(en.translation.message_zero).toBeDefined()
    expect(en.translation.message_one).toBeDefined()
    expect(en.translation.message_two).toBeDefined()
    expect(en.translation.message_few).toBeDefined()
    expect(en.translation.message_many).toBeDefined()
    expect(en.translation.message_other).toBeDefined()
  })
})
