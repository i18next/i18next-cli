import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('reproducer: plural re-extract corruption', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-repro-'))
    await fs.mkdir(join(tempDir, 'components'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('running extract twice should not turn string values into objects (regression repro)', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const ReactComponent = () => {
        const { t } = useTranslation();
        const count = 0;
        return (
          <div>
            <p>{t('simple')}</p>
            <p>{t('plural', { count })}</p>
            <p>{t('nested.plural', { count })}</p>
          </div>
        );
      };
    `

    await fs.writeFile(join(tempDir, 'components', 'ReactComponent.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'ar'],
      extract: {
        removeUnusedKeys: true,
        defaultValue: '',
        defaultNS: false,
        generateBasePluralForms: true,
        outputFormat: 'json',
        mergeNamespaces: false,
        sort: true,
        keySeparator: false,
        input: normalizePath(join(tempDir, 'components/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
      },
    }

    // First run
    const updated1 = await runExtractor(config, { isDryRun: false })
    expect(updated1).toBe(true)

    const en1 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'en.json'), 'utf-8'))
    const ar1 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'ar.json'), 'utf-8'))

    // Expect string values after first run (as observed in reported behavior)
    expect(en1).toEqual({
      'nested.plural_one': 'nested.plural',
      'nested.plural_other': 'nested.plural',
      plural_one: 'plural',
      plural_other: 'plural',
      simple: 'simple',
    })
    expect(ar1).toEqual({
      'nested.plural_zero': '',
      'nested.plural_one': '',
      'nested.plural_two': '',
      'nested.plural_few': '',
      'nested.plural_many': '',
      'nested.plural_other': '',
      plural_zero: '',
      plural_one: '',
      plural_two: '',
      plural_few: '',
      plural_many: '',
      plural_other: '',
      simple: ''
    })

    // simulate a user adding a new translation key to en.json before re-extract
    const enModified = { ...en1, addedManually: 'manual' }
    await fs.writeFile(join(tempDir, 'locales', 'en.json'), JSON.stringify(enModified, null, 2), 'utf-8')

    // Second run (re-extract)
    const updated2 = await runExtractor(config, { isDryRun: false })
    expect(updated2).toBe(true)

    const en2 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'en.json'), 'utf-8'))
    const ar2 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'ar.json'), 'utf-8'))
    expect(en2).toEqual(en1)
    expect(ar2).toEqual(ar1)
  })

  it('running extract twice should not turn string values into objects when keySeparator="." (regression repro)', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const ReactComponent = () => {
        const { t } = useTranslation();
        const count = 0;
        return (
          <div>
            <p>{t('simple')}</p>
            <p>{t('plural', { count })}</p>
            <p>{t('nested.plural', { count })}</p>
          </div>
        );
      };
    `

    await fs.writeFile(join(tempDir, 'components', 'ReactComponent.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'ar'],
      extract: {
        removeUnusedKeys: true,
        defaultValue: '',
        defaultNS: false,
        generateBasePluralForms: true,
        outputFormat: 'json',
        mergeNamespaces: false,
        sort: true,
        keySeparator: '.',
        input: normalizePath(join(tempDir, 'components/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
      },
    }

    // First run
    const updated1 = await runExtractor(config, { isDryRun: false })
    expect(updated1).toBe(true)

    const en1 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'en.json'), 'utf-8'))
    const ar1 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'ar.json'), 'utf-8'))

    // Expect nested object for 'nested.plural' and root plural_* keys for 'plural'
    expect(en1).toEqual({
      nested: {
        plural_one: 'nested.plural',
        plural_other: 'nested.plural',
      },
      plural_one: 'plural',
      plural_other: 'plural',
      simple: 'simple',
    })
    expect(ar1).toEqual({
      nested: {
        plural_zero: '',
        plural_one: '',
        plural_two: '',
        plural_few: '',
        plural_many: '',
        plural_other: '',
      },
      plural_zero: '',
      plural_one: '',
      plural_two: '',
      plural_few: '',
      plural_many: '',
      plural_other: '',
      simple: ''
    })

    // simulate a user adding a new translation key to en.json before re-extract
    const enModified = { ...en1, addedManually: 'manual' }
    await fs.writeFile(join(tempDir, 'locales', 'en.json'), JSON.stringify(enModified, null, 2), 'utf-8')

    // Second run (re-extract)
    const updated2 = await runExtractor(config, { isDryRun: false })
    expect(updated2).toBe(true)

    const en2 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'en.json'), 'utf-8'))
    const ar2 = JSON.parse(await fs.readFile(join(tempDir, 'locales', 'ar.json'), 'utf-8'))
    expect(en2).toEqual(en1)
    expect(ar2).toEqual(ar1)
  })

  it('re-running extract with mergeNamespaces and indentation updates merged per-language file correctly', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const ReactComponent = () => {
        const { t } = useTranslation();
        return (
          <div>
            <p>{t('key', 'First')}</p>
          </div>
        );
      };
    `
    await fs.writeFile(join(tempDir, 'components', 'ReactComponent.tsx'), component)

    const outTemplate = normalizePath(join(tempDir, 'locales/{{language}}.json'))

    const config1: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        mergeNamespaces: true,
        input: normalizePath(join(tempDir, 'components/*.{ts,tsx,cts,mts}')),
        output: outTemplate,
        indentation: 6,
      },
    }

    // First run -> produces merged per-language file with 2-space indentation
    const updated1 = await runExtractor(config1, { isDryRun: false })
    expect(updated1).toBe(true)

    const enPath = join(tempDir, 'locales', 'en.json')
    const content1 = await fs.readFile(enPath, 'utf-8')

    // Sanity: initial file uses 2-space indentation
    expect(content1).toContain('\n' + ' '.repeat(6) + '"translation": {')
    expect(content1).toContain('\n' + ' '.repeat(12) + '"key": "First"')

    // Modify source so extractor will update the file and change indentation to 6
    const componentUpdated = `
      import { useTranslation } from 'react-i18next';

      export const ReactComponent = () => {
        const { t } = useTranslation();
        return (
          <div>
            <p>{t('key', 'First')}</p>
            <p>{t('keyAnother', 'Second')}</p>
          </div>
        );
      };
    `
    await fs.writeFile(join(tempDir, 'components', 'ReactComponent.tsx'), componentUpdated)

    // Second run -> should rewrite the file with 6-space indentation
    const updated2 = await runExtractor(config1, { isDryRun: false })
    expect(updated2).toBe(true)

    const content2 = await fs.readFile(enPath, 'utf-8')

    // Expect the rewritten file to reflect 6-space indentation and updated value "Second".
    expect(content2).toContain('\n' + ' '.repeat(6) + '"translation": {')
    expect(content2).toContain('\n' + ' '.repeat(12) + '"key": "First"')
    expect(content2).toContain('\n' + ' '.repeat(12) + '"keyAnother": "Second"')
  })
})
