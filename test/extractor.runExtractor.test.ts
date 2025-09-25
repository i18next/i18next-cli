import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/extractor'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

// Mock the 'fs/promises' module to use our in-memory file system from 'memfs'
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock the 'glob' module to control which files it "finds"
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor: runExtractor', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Dynamically import the mocked glob after mocks are set up
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should extract keys from t() functions and Trans components', async () => {
    const sampleCode = `
      import { Trans, useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        return (
          <div>
            <h1>{t('app.title', { defaultValue: 'Welcome!' })}</h1>
            <Trans i18nKey="app.description">
              This is a <strong>description</strong>.
            </Trans>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const deFileContent = await vol.promises.readFile(dePath, 'utf-8')

    const enJson = JSON.parse(enFileContent as string)
    const deJson = JSON.parse(deFileContent as string)

    expect(enJson).toEqual({
      app: {
        description: 'This is a <strong>description</strong>.',
        title: 'Welcome!'
      }
    })

    expect(deJson).toEqual({
      app: {
        description: '',
        title: ''
      }
    })
  })

  it('should accept a string as the second argument for defaultValue', async () => {
    const sampleCode = `
      function App() {
        const t = (k: string, v?: any) => k as any;
        return <div>{t('string.default', 'A string default')}</div>;
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson.string.default).toBe('A string default')
  })

  it('should accept defaultValue inside options object', async () => {
    const sampleCode = `
      function App() {
        const { t } = { t: (k: string, o?: any) => k as any };
        return <div>{t('obj.default', { defaultValue: 'From options' })}</div>;
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson.obj.default).toBe('From options')
  })

  it('should merge with existing translations and not overwrite existing secondary translations', async () => {
    const sampleCode = `
      function App() {
        return <div>{t('merge.key', { defaultValue: 'Primary default' })}</div>;
      }
    `
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    // Prepopulate existing translations (simulate previously translated DE file)
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({ merge: { key: 'Old EN' } }, null, 2),
      [dePath]: JSON.stringify({ merge: { key: 'Vorhanden DE' } }, null, 2),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const deFileContent = await vol.promises.readFile(dePath, 'utf-8')

    const enJson = JSON.parse(enFileContent as string)
    const deJson = JSON.parse(deFileContent as string)

    // EN should prefer existing value
    expect(enJson.merge.key).toBe('Old EN')
    // DE should preserve existing translation
    expect(deJson.merge.key).toBe('Vorhanden DE')
  })

  it('should handle nested keys correctly', async () => {
    const sampleCode = `
    function App() {
      const { t } = useTranslation();
      return (
        <div>
          <h1>{t('header.title', { defaultValue: 'Main Title' })}</h1>
          <p>{t('header.subtitle', 'A subtitle')}</p>
        </div>
      );
    }
  `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Modify the mock config to use a key separator
    const nestedKeyConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: '.', // Explicitly set for clarity
      },
    }

    await runExtractor(nestedKeyConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      header: {
        title: 'Main Title',
        subtitle: 'A subtitle',
      },
    })
  })

  it('should handle flat keys correctly', async () => {
    const sampleCode = `
    function App() {
      const { t } = useTranslation();
      return (
        <div>
          <h1>{t('header.title', { defaultValue: 'Main Title' })}</h1>
          <p>{t('header.subtitle', 'A subtitle')}</p>
        </div>
      );
    }
  `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Modify the mock config to use a key separator
    const nestedKeyConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract
      },
    }
    nestedKeyConfig.extract.keySeparator = false

    await runExtractor(nestedKeyConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      'header.title': 'Main Title',
      'header.subtitle': 'A subtitle',
    })
  })

  it('should preserve keys matching preservePatterns and remove other unused keys', async () => {
    const sampleCode = `
      function App() {
        // This key will be extracted
        t('static.key', 'Static Value');
        // This dynamic key will NOT be extracted, but should be preserved
        const status = 'active';
        // t('dynamic.status.base'))
        // t('dynamic.status.another', 'OTHER'))
        // t('dynamic.status.next', { defaultValue: 'NEXT' }))
        return <div>{t(\`dynamic.status.\${status}\`)}</div>;
      }
    `
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')

    // Prepopulate an existing translation file
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({
        'static.key': 'Old Static Value',
        'dynamic.status.active': 'Active Status',
        'dynamic.status.inactive': 'Inactive Status',
        'unused.key': 'This should be removed',
      }, null, 2),
    })

    const configWithPatterns: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys for this test
        preservePatterns: ['dynamic.status.*'],
      },
    }

    await runExtractor(configWithPatterns)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      'static.key': 'Old Static Value', // Preserved existing value
      'dynamic.status.active': 'Active Status', // Preserved by pattern
      'dynamic.status.another': 'OTHER', // found in comment
      'dynamic.status.base': 'dynamic.status.base', // found in comment
      'dynamic.status.inactive': 'Inactive Status', // Preserved by pattern
      'dynamic.status.next': 'NEXT', // found in comment
      // 'unused.key' has been correctly removed
    })
  })

  it('should generate suffixed keys for plurals and context', async () => {
    const sampleCode = `
    function App() {
      // Pluralization (for English: 'one', 'other')
      t('item', { defaultValue: 'An item', count: 5 });
      t('deep.item', { defaultValue: 'An item', count: 5 });

      // Context
      t('friend', { defaultValue: 'A friend', context: 'male' });
      t('friend', { defaultValue: 'A friend (f)', context: 'female' });
      t('deep.friend', { defaultValue: 'A friend', context: 'male' });
      t('deep.friend', { defaultValue: 'A friend (f)', context: 'female' });
    }
  `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    // We are using the mockConfig which has 'en' as the primary language
    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
    // Plural keys for English
      item_one: 'An item',
      item_other: 'An item',
      // Context keys
      friend_male: 'A friend',
      friend_female: 'A friend (f)',
      deep: {
        friend_female: 'A friend (f)',
        friend_male: 'A friend',
        item_one: 'An item',
        item_other: 'An item',
      },
    })
  })

  it('should use the "defaults" prop on Trans component over children', async () => {
    const sampleCode = `
    function App() {
      return (
        <Trans i18nKey="trans.defaults" defaults="Default value from prop">
          This text will be ignored.
        </Trans>
      );
    }
  `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      trans: {
        defaults: 'Default value from prop',
      },
    })
  })

  it('should preserve nested keys when returnObjects is true', async () => {
    const sampleCode = `
      // This key should be extracted normally
      t('a_regular_key', 'A regular value');
      // This call should cause all nested keys under 'countries' to be preserved
      t('countries', { returnObjects: true });
    `
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')

    // Prepopulate an existing translation file with the nested object
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({
        countries: {
          US: 'United States',
          DE: 'Germany',
        },
        an_old_key: 'This should be removed',
      }, null, 2),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      a_regular_key: 'A regular value',
      countries: {
        US: 'United States', // Preserved
        DE: 'Germany',      // Preserved
      },
      // an_old_key was correctly removed
    })
  })
})
