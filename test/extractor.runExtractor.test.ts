import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor, extract } from '../src/index'
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

    // Mock the current working directory to align with the virtual file system's root.
    vi.spyOn(process, 'cwd').mockReturnValue('/')

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
      'dynamic.status.inactive': 'Inactive Status', // Preserved by pattern
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

  it('should handle "mixed" nested keys when updating an existing file', async () => {
    const sampleCode = `
      // These keys create a "mixed" structure under 'example'
      t('example.label');
      t('example.content.title');
      t('example.content.body');
    `
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')

    const existingTranslations = {
      example: {
        content: {
          // This value should be preserved
          title: 'Existing Title',
        },
      },
    }

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      // Create the file before running the extractor
      [enPath]: JSON.stringify(existingTranslations),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // The expected output should be a merge of the existing file and the new/missing keys
    expect(enJson).toEqual({
      example: {
        // The new key was correctly added alongside the existing `content` object
        label: 'example.label',
        content: {
          // The existing translation was correctly preserved
          title: 'Existing Title',
          // The new key was added to the nested object
          body: 'example.content.body',
        },
      },
    })
  })

  it('should handle "mixed" nested keys when updating an existing file with selector api', async () => {
    const sampleCode = `
      // These keys create a "mixed" structure under 'example'
      t(($) => $.example.label)
      t(($) => $.example.content.title)
      t(($) => $.example.content.body)
    `
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')

    const existingTranslations = {
      example: {
        content: {
          // This value should be preserved
          title: 'Existing Title',
        },
      },
    }

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      // Create the file before running the extractor
      [enPath]: JSON.stringify(existingTranslations),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // The expected output should be a merge of the existing file and the new/missing keys
    expect(enJson).toEqual({
      example: {
        // The new key was correctly added alongside the existing `content` object
        label: 'example.label',
        content: {
          // The existing translation was correctly preserved
          title: 'Existing Title',
          // The new key was added to the nested object
          body: 'example.content.body',
        },
      },
    })
  })

  it('should recognize keys in arrays as expected', async () => {
    const sampleCode = `
      function TestingFunc() {
        const { t } = useTranslation();

        const titles = [
          {
            text: t(($) => $.system.nested.label),
          },
          {
            text: t(($) => $.system.nested.body),
          },
        ];

        const otherArray = [t(($) => $.system.nested.found), t(($) => $.system.nested.notFound)];

        return (
        <div>
          <span>
            {t(($) => $.system.title)}
          </span>
          {titles.map((title) => (
            <span key={title.text}>{title.text}</span>
          ))}
        </div>
        );
      }
    `
    const existingTranslations = {
      system: {
        nested: {
          label: 'Label to persist', // This should be preserved
        },
      }
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify(existingTranslations),
    })
    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      system: {
        nested: {
          label: 'Label to persist', // Preserved existing value
          body: 'system.nested.body',
          found: 'system.nested.found',
          notFound: 'system.nested.notFound',
        },
        title: 'system.title',
      },
    })
  })

  it('should not discard other keys when a t() call with an empty string is present', async () => {
    const sampleCode = `
      t('TITLE', 'My Title');
      t(''); // The problematic call with an empty key
      t('SUBTITLE', 'My Subtitle');
    `

    // Pre-populate the translation file with the TITLE key
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({ TITLE: 'Existing Title' }, null, 2),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This test will fail before the fix because TITLE will be missing.
    // The correct behavior is to preserve TITLE and add SUBTITLE.
    expect(enJson).toEqual({
      TITLE: 'Existing Title',
      SUBTITLE: 'My Subtitle',
    })
  })

  it('should ignore files specified in the "ignore" option during extraction', async () => {
  // Setup: Create two files, one of which should be ignored.
    vol.fromJSON({
      '/src/App.tsx': "t('key.from.app')",
      '/src/ignored-file.ts': "t('key.from.ignored')",
    })

    // Mock glob to return both files, so we can ensure our logic filters them.
    // In reality, `glob` itself would do the filtering, but this tests our code's intent.
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern, options) => {
      if ((options?.ignore as string[]).includes('**/*.ignored.ts')) {
        return ['/src/App.tsx'] // Simulate glob filtering
      }
      return ['/src/App.tsx', '/src/ignored-file.ts'] // Default return
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        input: ['src/**/*.{ts,tsx}'],
        // Ignore a specific file pattern
        ignore: ['**/*.ignored.ts'],
      },
    }

    // Action: Run the extractor
    const results = await extract(config)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    // Assertions
    expect(translationFile).toBeDefined()
    const extractedKeys = translationFile!.newTranslations

    // It should contain the key from the non-ignored file
    expect(extractedKeys).toHaveProperty('key.from.app')
    // It should NOT contain the key from the ignored file
    expect(extractedKeys).not.toHaveProperty('key.from.ignored')
  })

  it('should preserve unused keys when removeUnusedKeys is false', async () => {
    // Setup: A source file with one key, and an existing file with a different, unused key.
    vol.fromJSON({
      '/src/App.tsx': "t('key.new', 'New Value')",
      '/locales/en/translation.json': JSON.stringify({
        'key.old': 'Old Value',
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys for this test
        removeUnusedKeys: false
      },
    }

    // Action
    await runExtractor(config)

    // Assertions
    const enFileContent = await vol.promises.readFile('/locales/en/translation.json', 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This will fail before the fix because `key.old` will be pruned.
    // The correct behavior is to preserve the old key and add the new one.
    expect(enJson).toEqual({
      'key.old': 'Old Value',
      'key.new': 'New Value',
    })
  })

  it('should not preserve unused keys when removeUnusedKeys is true', async () => {
    // Setup: A source file with one key, and an existing file with a different, unused key.
    vol.fromJSON({
      '/src/App.tsx': "t('key.new', 'New Value')",
      '/locales/en/translation.json': JSON.stringify({
        'key.old': 'Old Value',
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys for this test
        removeUnusedKeys: true
      },
    }

    // Action
    await runExtractor(config)

    // Assertions
    const enFileContent = await vol.promises.readFile('/locales/en/translation.json', 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This will fail before the fix because `key.old` will be pruned.
    // The correct behavior is to preserve the old key and add the new one.
    expect(enJson).toEqual({
      'key.new': 'New Value'
    })
  })

  it('should extract keys from within class methods', async () => {
    const sampleCode = `
      t("outside");
      class C {
        method() {
          t("inside");
        }
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    // Use a config with flat keys for a simple assertion
    const flatKeyConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false,
      },
    }

    await runExtractor(flatKeyConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This will fail because "inside" will be missing.
    expect(enJson).toEqual({
      outside: 'outside',
      inside: 'inside',
    })
  })

  it('should not write any files when --dry-run is used', async () => {
    const sampleCode = "t('new.key', 'A New Key')"
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
      },
    }

    const fsPromises = await import('node:fs/promises')
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile')

    // Call runExtractor with the correct options object, including `isDryRun: true`.
    const result = await runExtractor(config, { isDryRun: true })

    // Assertions
    // 1. `writeFile` should NOT have been called.
    expect(writeFileSpy).not.toHaveBeenCalled()

    // 2. The function should still report that an update *would* have happened.
    expect(result).toBe(true)

    writeFileSpy.mockRestore()
  })

  it('should extract keys from a member expression based on "this"', async () => {
    const sampleCode = `
      class Foo {
        constructor() { this._i18n = { t: (key) => key }; }
        method() {
          this._i18n.t('bar');
        }
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const configWithThis: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false,
        // Add the new function pattern to the config
        functions: ['t', 'this._i18n.t'],
      },
    }

    await runExtractor(configWithThis)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      bar: 'bar',
    })
  })

  it('should correctly remove the last remaining key from a translation file', async () => {
    // This test requires a specific mock for glob to simulate its exact scenario:
    // 1. Finding NO source files.
    // 2. Finding the ONE existing translation file.
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      // For key-finder looking for source files, return an empty array.
      if (Array.isArray(pattern) && pattern[0].includes('src/')) {
        return []
      }
      // For translation-manager looking for 'en' locale files, return the one we created.
      if (pattern === 'locales/en/*.json') {
        return ['/locales/en/translation.json']
      }
      // For other locales, return empty.
      return []
    })

    // Setup: The source code is empty.
    const sampleCode = ''
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      // The existing translation file contains one key.
      '/locales/en/translation.json': JSON.stringify({
        'key.to.remove': 'Old Value',
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys for simplicity
        removeUnusedKeys: true,
      },
    }

    // Action
    await runExtractor(config)

    // Assertions
    const enFileContent = await vol.promises.readFile('/locales/en/translation.json', 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This assertion will now pass.
    expect(enJson).toEqual({})
  })

  it('should replace a nested object with a primitive when a key is refactored', async () => {
    // Setup: The existing file has a nested object for 'person'.
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      '/locales/en/translation.json': JSON.stringify({
        person: { name: 'A person name' },
      }),
      // The new source code only uses the parent 'person' key.
      '/src/App.tsx': "t('person', 'A person')",
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // This will fail before the fix because the old nested object will be preserved.
    // The correct behavior is for the object to be replaced by the new string value.
    expect(enJson).toEqual({
      person: 'A person',
    })
  })

  it('should correctly sort top-level keys when mixed with nested keys', async () => {
    // Setup: The source code contains keys that should be sorted alphabetically
    // at the top level ('person', then 'person-foo').
    const sampleCode = `
      t('person-foo');
      t('person.bla');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    // Action
    await runExtractor(mockConfig) // mockConfig has sort: true by default

    // Assertions
    const enFileContent = await vol.promises.readFile('/locales/en/translation.json', 'utf-8')

    // This will fail before the fix because the order will be person-foo, then person.
    // The correct order is person, then person-foo.
    // We check the raw string content because object key order is not guaranteed after JSON.parse.
    const expectedOrder = '"person": {\n    "bla": "person.bla"\n  },\n  "person-foo": "person-foo"'
    expect(enFileContent).toContain(expectedOrder)
  })

  it('should correctly sort keys within nested objects', async () => {
  // Setup: Add keys for a nested object in a non-alphabetical order
    const sampleCode = `
      t('buttons.scroll-to-top');
      t('buttons.cancel');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig) // mockConfig has sort: true by default

    const enFileContent = await vol.promises.readFile('/locales/en/translation.json', 'utf-8')

    // This will fail before the fix. We check the raw string to ensure order.
    const expectedOrder = '"buttons": {\n    "cancel": "buttons.cancel",\n    "scroll-to-top": "buttons.scroll-to-top"\n  }'
    expect(enFileContent).toContain(expectedOrder)
  })

  it('should preserve nested objects when returnObjects is used with selector API', async () => {
    const sampleCode = `
      // This selector API call should preserve the nested object structure
      let { t } = useTranslation('_app._index')
      const meta = t(($) => $.meta);
    `
    const enPath = resolve(process.cwd(), 'locales/en/_app._index.json')

    // Prepopulate an existing translation file with the nested object
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({
        meta: {
          title: 'Lorem ipsum',
          description: 'Dolor et sit amet'
        }
      }, null, 2),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      meta: {
        title: 'Lorem ipsum', // Preserved
        description: 'Dolor et sit amet' // Preserved
      },
      // The nested structure should be preserved, not replaced with "meta": "meta"
    })
  })

  it('should preserve nested objects when returnObjects is used with t function API', async () => {
    const sampleCode = `
      // This selector API call should preserve the nested object structure
      let { t } = useTranslation('_app._index')
      const meta = t('meta');
    `
    const enPath = resolve(process.cwd(), 'locales/en/_app._index.json')

    // Prepopulate an existing translation file with the nested object
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({
        meta: {
          title: 'Lorem ipsum',
          description: 'Dolor et sit amet'
        }
      }, null, 2),
    })

    await runExtractor(mockConfig)

    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      meta: {
        title: 'Lorem ipsum', // Preserved
        description: 'Dolor et sit amet' // Preserved
      },
      // The nested structure should be preserved, not replaced with "meta": "meta"
    })
  })

  it('should remove namespace prefix from i18nKey when ns prop is specified on Trans component', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      export const FormTranslation = () => {
        return (
          <Trans
            t={t}
            ns="form"
            i18nKey="form:cost_question.description"
          />
        );
      };

      export const AnotherComponent = () => {
        return (
          <Trans
            ns="common"
            i18nKey="common:button.submit"
          />
        );
      };

      export const WithoutNamespacePrefix = () => {
        return (
          <Trans
            ns="form"
            i18nKey="simple.key"
          />
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    // Check form namespace file
    const formPath = resolve(process.cwd(), 'locales/en/form.json')
    const formFileContent = await vol.promises.readFile(formPath, 'utf-8')
    const formJson = JSON.parse(formFileContent as string)

    expect(formJson).toEqual({
      cost_question: {
        description: 'cost_question.description'
      },
      simple: {
        key: 'simple.key'
      }
    })

    // Check common namespace file
    const commonPath = resolve(process.cwd(), 'locales/en/common.json')
    const commonFileContent = await vol.promises.readFile(commonPath, 'utf-8')
    const commonJson = JSON.parse(commonFileContent as string)

    expect(commonJson).toEqual({
      button: {
        submit: 'button.submit'
      }
    })

    // Verify that the default translation.json doesn't contain these keys (if it exists)
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    try {
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)

      // Should not contain the namespaced keys
      expect(translationJson).not.toHaveProperty('form:cost_question.description')
      expect(translationJson).not.toHaveProperty('common:button.submit')
    } catch (error) {
      // It's okay if the translation.json file doesn't exist since all keys went to namespace files
      if ((error as any)?.code === 'ENOENT') {
        // This is expected - no keys went to the default translation file
        expect(true).toBe(true)
      } else {
        throw error
      }
    }
  })

  it('should extract commented t() calls with namespace from useTranslation scope', async () => {
    const sampleCode = `
      export const TranslatedAccessType = ({
          accessType,
      }: {
          accessType: string;
      }) => {
          const { t } = useTranslation('access');

          return (
              <>
                  {
                      // t("Private")
                      // t("Everyone")
                      // t("Admin Only")
                      t(accessType, {
                          ignoreJSONStructure: true,
                      })
                  }
              </>
          );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    // Check that commented keys go to access.json (from useTranslation scope)
    const accessPath = resolve(process.cwd(), 'locales/en/access.json')
    const accessFileContent = await vol.promises.readFile(accessPath, 'utf-8')
    const accessJson = JSON.parse(accessFileContent as string)

    expect(accessJson).toEqual({
      Private: 'Private',
      Everyone: 'Everyone',
      'Admin Only': 'Admin Only'
    })

    // Verify that the default translation.json doesn't contain these keys
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    try {
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)

      // Should not contain the commented keys since they went to access.json
      expect(translationJson).not.toHaveProperty('Private')
      expect(translationJson).not.toHaveProperty('Everyone')
      expect(translationJson).not.toHaveProperty('Admin Only')
    } catch (error) {
      // It's okay if the translation.json file doesn't exist since keys went to access namespace
      if ((error as any)?.code === 'ENOENT') {
        expect(true).toBe(true)
      } else {
        throw error
      }
    }
  })

  it('should extract commented t() calls with context and count combinations', async () => {
    const sampleCode = `
      export const TimeBasedOptions = ({ term }) => {
        return (
          <div>
            {/* t('options.option', { context: 'month', count: 1 }) */}
            {/* t('options.option', { context: 'day', count: 1 })  */}
            {/* t('options.option', { context: 'week', count: 1 }) */}
            {t(\`options.option\`, {
              count: Number(term.amount),
              context: term.timeUnit,
            })}
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    // Check that all context + plural combinations are extracted
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      options: {
        // Base plural forms (no context)
        option_one: 'options.option',
        option_other: 'options.option',
        // Context + plural combinations
        option_month_one: 'options.option',
        option_month_other: 'options.option',
        option_day_one: 'options.option',
        option_day_other: 'options.option',
        option_week_one: 'options.option',
        option_week_other: 'options.option',
      }
    })
  })

  it('should extract commented t() calls with ordinal plurals', async () => {
    const sampleCode = `
      export const OrdinalExamples = () => {
        return (
          <div>
            {
              // t('position', { count: 1, ordinal: true })
              // t('rank_ordinal', { count: 1 })
              // t('place', { count: 2, ordinal: false })
              t(\`position\`, {
                count: Number(position),
                // No ordinal flag, so this should generate cardinal plurals
              })
            }
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      // Ordinal from comment with explicit ordinal: true (English has one, two, few, other)
      position_ordinal_one: 'position',
      position_ordinal_two: 'position',
      position_ordinal_few: 'position',
      position_ordinal_other: 'position',

      // Ordinal from comment with _ordinal suffix in key
      rank_ordinal_one: 'rank',
      rank_ordinal_two: 'rank',
      rank_ordinal_few: 'rank',
      rank_ordinal_other: 'rank',

      // Cardinal from comment with explicit ordinal: false (English cardinal has one, other)
      place_one: 'place',
      place_other: 'place',

      // Cardinal from dynamic t() call (no ordinal specified)
      position_one: 'position',
      position_other: 'position'
    })
  })

  it('should handle ordinal plurals with custom separators', async () => {
    const customConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        pluralSeparator: '-'
      }
    }

    const sampleCode = `
      export const CustomSeparatorOrdinals = () => {
        return (
          <div>
            {
              // t('position', { count: 1, ordinal: true })
              // t('rank-ordinal', { count: 1 })
              t(\`position\`, { count: Number(pos) }) // No ordinal flag
            }
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(customConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      // Ordinal with custom separator from comment (English ordinal: one, two, few, other)
      'position-ordinal-one': 'position',
      'position-ordinal-two': 'position',
      'position-ordinal-few': 'position',
      'position-ordinal-other': 'position',

      // Ordinal detected via suffix with custom separator
      'rank-ordinal-one': 'rank',
      'rank-ordinal-two': 'rank',
      'rank-ordinal-few': 'rank',
      'rank-ordinal-other': 'rank',

      // Dynamic call fallback with custom separator (cardinal: one, other)
      'position-one': 'position',
      'position-other': 'position'
    })
  })

  it('should handle ordinal plurals with different primary languages', async () => {
    const polishConfig = {
      ...mockConfig,
      locales: ['pl', 'en'],
      extract: {
        ...mockConfig.extract,
        primaryLanguage: 'pl'
      }
    }

    const sampleCode = `
      export const PolishOrdinals = () => {
        return (
          <div>
            {
              // t('position', { count: 1, ordinal: true })
              t(\`position\`, { count: num }) // Cardinal plurals for dynamic call
            }
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(polishConfig)

    const translationPath = resolve(process.cwd(), 'locales/pl/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    // Polish ordinal plural categories - get the actual categories
    const ordinalKeys = Object.keys(translationJson).filter(key =>
      key.startsWith('position_ordinal_')
    )

    // Polish ordinals actually only have 'other' category
    expect(ordinalKeys.length).toBe(1)
    expect(ordinalKeys).toContain('position_ordinal_other')

    // Also check dynamic call generates cardinal plurals (Polish cardinal: one, few, many, other)
    const cardinalKeys = Object.keys(translationJson).filter(key =>
      key.startsWith('position_') && !key.includes('ordinal')
    )
    expect(cardinalKeys.length).toBeGreaterThan(2) // Should have more than just one/other
    expect(cardinalKeys).toContain('position_one')
    expect(cardinalKeys).toContain('position_other')
    // Polish should also have 'few' and 'many'
    expect(cardinalKeys.some(key => key.includes('_few'))).toBe(true)
    expect(cardinalKeys.some(key => key.includes('_many'))).toBe(true)
  })

  it('should handle ordinal parsing edge cases', async () => {
    const sampleCode = `
      export const OrdinalEdgeCases = () => {
        return (
          <div>
            {
              // t('test1', { ordinal: true }) - ordinal without count
              // t('test2', { count: 1, ordinal: "true" }) - string ordinal value  
              // t('test3', { count: 1, ordinal: false }) - explicit false
              // t('test4_ordinal') - ordinal suffix without count
              // t('test5_ordinal', { count: 1, ordinal: false }) - suffix overrides option
              t(\`test\`, { count: num })
            }
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      // test1: ordinal without count -> simple key only
      test1: 'test1',

      // test2: string "true" value -> should not be parsed as ordinal (cardinal plurals)
      test2_one: 'test2',
      test2_other: 'test2',

      // test3: explicit false -> cardinal plurals
      test3_one: 'test3',
      test3_other: 'test3',

      // test4: ordinal suffix without count -> simple key only (suffix stripped)
      test4: 'test4',

      // test5: suffix detected despite ordinal: false -> ordinal wins (English ordinal: one, two, few, other)
      test5_ordinal_one: 'test5',
      test5_ordinal_two: 'test5',
      test5_ordinal_few: 'test5',
      test5_ordinal_other: 'test5',

      // Dynamic call: cardinal plurals (English cardinal: one, other)
      test_one: 'test',
      test_other: 'test'
    })
  })

  it('should apply namespace from useTranslation to dynamic t() calls with context and count', async () => {
    const sampleCode = `
      export const Calculator = ({ term }) => {
        const { t } = useTranslation('/widgets/calculator/ui/calculator-form');
        
        return (
          <div>
            {t(\`options.option\`, {
              count: Number(term.amount),
              context: term.timeUnit, // Could be 'DAYS', 'WEEKS', 'MONTHS'
            })}
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    // Keys should go to the namespace from useTranslation, not the default namespace
    const calculatorPath = resolve(process.cwd(), 'locales/en/widgets/calculator/ui/calculator-form.json')
    const calculatorFileContent = await vol.promises.readFile(calculatorPath, 'utf-8')
    const calculatorJson = JSON.parse(calculatorFileContent as string)

    // Should only extract the base plural keys since context is dynamic
    // The actual context variants would need to be added via comments or preservePatterns
    expect(calculatorJson).toEqual({
      options: {
        option_one: 'options.option',
        option_other: 'options.option'
      }
    })

    // Verify that the default translation.json doesn't contain these keys
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    try {
      await vol.promises.readFile(translationPath, 'utf-8')
      // If the file exists, it should be empty or not contain our keys
      expect(true).toBe(false) // Should not reach here - file shouldn't exist
    } catch (error) {
      // File should not exist since keys went to the proper namespace
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT') {
        expect(true).toBe(true)
      } else {
        throw error
      }
    }
  })

  it('should extract context variants when using commented hints with namespace', async () => {
    const sampleCode = `
      export const Calculator = ({ term }) => {
        const { t } = useTranslation('/widgets/calculator/ui/calculator-form');
        
        return (
          <div>
            {
              // t('options.option', { context: 'DAYS', count: 1 })
              // t('options.option', { context: 'WEEKS', count: 1 })
              // t('options.option', { context: 'MONTHS', count: 1 })
              t(\`options.option\`, {
                count: Number(term.amount),
                context: term.timeUnit,
              })
            }
          </div>
        );
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    // Keys should go to the namespace from useTranslation
    const calculatorPath = resolve(process.cwd(), 'locales/en/widgets/calculator/ui/calculator-form.json')
    const calculatorFileContent = await vol.promises.readFile(calculatorPath, 'utf-8')
    const calculatorJson = JSON.parse(calculatorFileContent as string)

    expect(calculatorJson).toEqual({
      options: {
        // Base plural forms from dynamic call
        option_one: 'options.option',
        option_other: 'options.option',
        // Context + plural combinations from comments
        option_DAYS_one: 'options.option',
        option_DAYS_other: 'options.option',
        option_WEEKS_one: 'options.option',
        option_WEEKS_other: 'options.option',
        option_MONTHS_one: 'options.option',
        option_MONTHS_other: 'options.option'
      }
    })
  })

  it('should handle TypeScript satisfies operator in template literals', async () => {
    const sampleCode = `
      const role = 'ADMIN';

      // Support as for static types
      t(\`profile.role.\${role satisfies 'ADMIN' | 'MANAGER' | 'EMPLOYEE'}\`);
      t(\`menu.option.\${title satisfies 'title' | 'subtitle' | Dynamic}\`);
      // Ignore non-static types
      t(\`option.action.\${name satisfies Option}\`);
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      menu: {
        option: {
          subtitle: 'menu.option.subtitle',
          title: 'menu.option.title'
        }
      },
      profile: {
        role: {
          ADMIN: 'profile.role.ADMIN',
          MANAGER: 'profile.role.MANAGER',
          EMPLOYEE: 'profile.role.EMPLOYEE'
        }
      }
    })
  })

  it('should handle TypeScript satisfies operator with nested types', async () => {
    const sampleCode = `
      const role = 'role_ADMIN';
      t('test.key')
      t(\`profile.role.\${role satisfies \`role_\${'ADMIN' | 'MANAGER'}\`}.description\`);
      t(\`profile.role.\${role satisfies \`role_\${'ADMIN' | 'MANAGER' | ROLES}\`}.title\`);
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      test: {
        key: 'test.key',
      },
      profile: {
        role: {
          role_ADMIN: {
            description: 'profile.role.role_ADMIN.description',
            title: 'profile.role.role_ADMIN.title',
          },
          role_MANAGER: {
            description: 'profile.role.role_MANAGER.description',
            title: 'profile.role.role_MANAGER.title',
          },
        }
      }
    })
  })

  it('should handle TypeScript as operator in template literals', async () => {
    const sampleCode = `
      const status = getStatus();
      t(\`alert.\${status as 'success' | 'error' | 'warning'}.message\`);
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      alert: {
        error: { message: 'alert.error.message' },
        success: { message: 'alert.success.message' },
        warning: { message: 'alert.warning.message' }
      }
    })
  })

  it('should NOT extract keys matching preservePatterns', async () => {
    const sampleCode = `
      function App() {
        // These keys should be extracted normally
        t('app.title', 'My App Title');
        t('common.button.save', 'Save');
        
        // These keys match preservePatterns and should NOT be extracted
        // (they already exist in other files like assets.json)
        t('BUILDINGS.ACADEMY.NAME');
        t('BUILDINGS.BREWERY.NAME'); 
        t('BUILDINGS.HEROS_MANSION.NAME');
        t('QUESTS.ADVENTURE-COUNT.DESCRIPTION');
        t('QUESTS.EVERY.NAME');
        
        // Dynamic usage of preserved patterns (also shouldn't be extracted)
        const buildingId = 'SMITHY';
        t(\`BUILDINGS.\${buildingId}.NAME\`);
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const configWithPreservePatterns: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys to match user's config
        preservePatterns: [
          'BUILDINGS.*',
          'QUESTS.*',
          'UNITS.*',
          'ITEMS.*',
          'TRIBES.*',
          'REPUTATIONS.*',
          'FACTIONS.*',
          'RESOURCES.*',
          'ICONS.*',
        ],
      },
    }

    await runExtractor(configWithPreservePatterns)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    // ✅ This test should now PASS - demonstrating the fix
    expect(enJson).toEqual({
      // These should be extracted (normal app keys)
      'app.title': 'My App Title',
      'common.button.save': 'Save',

      // ✅ These should NOT be in the extracted file:
      // 'BUILDINGS.ACADEMY.NAME': 'BUILDINGS.ACADEMY.NAME', // EXCLUDED
      // 'BUILDINGS.BREWERY.NAME': 'BUILDINGS.BREWERY.NAME', // EXCLUDED
      // 'BUILDINGS.HEROS_MANSION.NAME': 'BUILDINGS.HEROS_MANSION.NAME', // EXCLUDED
      // 'QUESTS.ADVENTURE-COUNT.DESCRIPTION': 'QUESTS.ADVENTURE-COUNT.DESCRIPTION', // EXCLUDED
      // 'QUESTS.EVERY.NAME': 'QUESTS.EVERY.NAME', // EXCLUDED
    })

    // The preserved pattern keys should be completely absent from extraction
    expect(enJson).not.toHaveProperty('BUILDINGS.ACADEMY.NAME')
    expect(enJson).not.toHaveProperty('BUILDINGS.BREWERY.NAME')
    expect(enJson).not.toHaveProperty('BUILDINGS.HEROS_MANSION.NAME')
    expect(enJson).not.toHaveProperty('QUESTS.ADVENTURE-COUNT.DESCRIPTION')
    expect(enJson).not.toHaveProperty('QUESTS.EVERY.NAME')
  })

  it('should preserve keys matching preservePatterns and remove other unused keys', async () => {
    const sampleCode = `
      function App() {
        // This key will be extracted (doesn't match preservePatterns)
        t('static.key', 'Static Value');
        
        // These commented keys match preservePatterns and should NOT be extracted
        // t('dynamic.status.base')
        // t('dynamic.status.another', 'OTHER')
        // t('dynamic.status.next', { defaultValue: 'NEXT' })
        
        // This dynamic key also matches preservePatterns and should NOT be extracted
        const status = 'active';
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

    // The correct behavior with preservePatterns:
    expect(enJson).toEqual({
      'static.key': 'Old Static Value', // Extracted and preserved existing value
      'dynamic.status.active': 'Active Status', // Preserved by pattern (not re-extracted)
      'dynamic.status.inactive': 'Inactive Status', // Preserved by pattern
      // 'unused.key' has been correctly removed (removeUnusedKeys: true by default)
      // The commented keys matching preservePatterns were NOT extracted (correct behavior)
    })
  })
})
