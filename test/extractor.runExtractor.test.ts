import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor, extract } from '../src/extractor'
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

    // This will fail before the fix because "inside" will be missing.
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
})
