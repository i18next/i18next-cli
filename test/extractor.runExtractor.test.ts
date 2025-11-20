import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor, extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'
import { pathEndsWith } from './utils/path'

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
    vi.mocked(glob).mockImplementation(async (pattern, options) => {
      const ignore = (options?.ignore as string[]) || []
      // Normalize backslashes to forward slashes so this works cross-platform (Windows/Posix)
      const hasIgnoredPattern = ignore.some(p => p.replace(/\\/g, '/').includes('**/*.ignored.ts'))

      // Base candidates the tests expect
      const candidates = ['/src/App.tsx', '/src/App.ts', '/src/ignored-file.ts']
      // Only return files that actually exist in the memfs volume to avoid ENOENT
      const existing = candidates.filter(p => vol.existsSync(p))

      if (hasIgnoredPattern) {
        // Filter out ignored-file if pattern is present
        return existing.filter(p => !pathEndsWith(p, '/src/ignored-file.ts'))
      }
      return existing
    })
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
      const ignore = (options?.ignore as string[]) || []
      const hasIgnoredPattern = ignore.some(p => p.replace(/\\/g, '/').includes('**/*.ignored.ts'))

      const candidates = ['/src/App.tsx', '/src/ignored-file.ts']
      const existing = candidates.filter(p => vol.existsSync(p))

      if (hasIgnoredPattern) {
        return existing.filter(p => !pathEndsWith(p, '/src/ignored-file.ts'))
      }
      return existing
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
    const translationFile = results.find(r =>
      pathEndsWith(r.path, '/locales/en/translation.json')
    )

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

  it('should extract i18nKey from arrow function returning property access', async () => {
    const sampleCode = `
      <Trans i18nKey={($) => $.welcome.agreeText}>
        Agree
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    console.log(results)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      welcome: {
        agreeText: 'Agree',
      },
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

  it('does not treat domain/namespace prefix as nested key when useTranslation receives a string namespace', async () => {
    const sampleCode = `
      import { Trans, useTranslation } from 'react-i18next';

      export default function MyComponent() {
        const { t } = useTranslation('en', 'myDomain');

        return (
          <>
            <Trans i18nKey='myDomain:foo1.bar1' t={t} />
            {t('myDomain:foo2.bar2')}
          </>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const domainPath = resolve(process.cwd(), 'locales/en/myDomain.json')
    const domainFileContent = await vol.promises.readFile(domainPath, 'utf-8')
    const domainJson = JSON.parse(domainFileContent as string)

    expect(domainJson).toEqual({
      foo1: {
        bar1: 'myDomain:foo1.bar1'
      },
      foo2: {
        bar2: 'myDomain:foo2.bar2'
      }
    })

    // Ensure the default translation file does not contain namespaced keys
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    try {
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)
      expect(translationJson).not.toHaveProperty('myDomain:foo2.bar2')
      expect(translationJson).not.toHaveProperty('myDomain:foo1.bar1')
    } catch (error) {
      // It's acceptable if translation.json does not exist
      if ((error as any)?.code === 'ENOENT') {
        expect(true).toBe(true)
      } else {
        throw error
      }
    }
  })

  it('handles custom async useTranslation hook (lng, ns) that returns t and is awaited', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      // custom async hook that initializes i18next and returns { t, i18n }
      export const useTranslation = async (lng, ns) => {
        // fake init - extractor only needs the call shape, not runtime behavior
        return {
          t: (k, v) => k,
          i18n: {}
        }
      }

      export default async function MyComponent() {
        const { t } = await useTranslation('en', 'myDomain');

        return (
          <>
            <Trans i18nKey='myDomain:foo1.bar1' t={t} />
            {t('myDomain:foo2.bar2')}
          </>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        // register the custom hook signature: first arg is lng, second is namespace
        useTranslationNames: [{ name: 'useTranslation', nsArg: 1 }],
      },
    }

    await runExtractor(config)

    const domainPath = resolve(process.cwd(), 'locales/en/myDomain.json')
    const domainFileContent = await vol.promises.readFile(domainPath, 'utf-8')
    const domainJson = JSON.parse(domainFileContent as string)

    expect(domainJson).toEqual({
      foo1: {
        bar1: 'myDomain:foo1.bar1'
      },
      foo2: {
        bar2: 'myDomain:foo2.bar2'
      }
    })
  })

  it('supports custom async useTranslation hook signature (lng, ns) when registered with keyPrefixArg:-1', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      // custom async hook that initializes i18next and returns { t, i18n }
      export const useTranslation = async (lng, ns) => {
        // fake init - extractor only needs the call shape, not runtime behavior
        return {
          t: (k, v) => k,
          i18n: {}
        }
      }

      export default async function MyComponent() {
        const { t } = await useTranslation('en', 'myDomain');

        return (
          <>
            <Trans i18nKey='myDomain:foo1.bar1' t={t} />
            {t('myDomain:foo2.bar2')}
          </>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        // register the custom hook signature: first arg is lng, second is namespace,
        // and explicitly disable keyPrefix arg so the second arg is not treated as a prefix.
        useTranslationNames: [{ name: 'useTranslation', nsArg: 1, keyPrefixArg: -1 }],
      },
    }

    await runExtractor(config)

    const domainPath = resolve(process.cwd(), 'locales/en/myDomain.json')
    const domainFileContent = await vol.promises.readFile(domainPath, 'utf-8')
    const domainJson = JSON.parse(domainFileContent as string)

    expect(domainJson).toEqual({
      foo1: {
        bar1: 'myDomain:foo1.bar1'
      },
      foo2: {
        bar2: 'myDomain:foo2.bar2'
      }
    })
  })

  it('should apply keyPrefix from useTranslation to Trans component', async () => {
    const sampleCode = `
      import { Trans, useTranslation } from 'react-i18next';

      function SurveyLinkFeatures() {
        const { t } = useTranslation("home", { keyPrefix: "prefix" });

        return (
          <>
            Direct {t("key.sub1", "Direct is working")}
            <Trans t={t} i18nKey="key.sub2">
              Trans misses prefix
            </Trans>
          </>
        );
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const homePath = resolve(process.cwd(), 'locales/en/home.json')
    const homeFileContent = await vol.promises.readFile(homePath, 'utf-8')
    const homeJson = JSON.parse(homeFileContent as string)

    expect(homeJson).toEqual({
      prefix: {
        key: {
          sub1: 'Direct is working',
          sub2: 'Trans misses prefix',
        },
      },
    })
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

  it('should parse simple template literals as default values', async () => {
    const sampleCode = `
      t('app.title', { defaultValue: \`Welcome!\` });
      t('app.subtitle', \`Glad to meet you!\`);
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(mockConfig)

    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
    const translationJson = JSON.parse(translationFileContent as string)

    expect(translationJson).toEqual({
      app: {
        title: 'Welcome!',
        subtitle: 'Glad to meet you!',
      },
    })
  })

  it('should not overwrite existing plural variants when expanding base plural keys into secondary locales', async () => {
    const sampleCode = `
      function App() {
        return <div>{t('key', { count: 5 })}</div>;
      }
    `

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const jaPath = resolve(process.cwd(), 'locales/ja/translation.json')

    // Prepopulate existing English translations for the plural variants
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [enPath]: JSON.stringify({
        key_one: 'One item',
        key_other: '{{count}} items'
      }, null, 2),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      locales: ['ja', 'en'],
      extract: {
        ...mockConfig.extract,
        primaryLanguage: 'ja',
        // ensure output and functions are preserved from mockConfig
      },
    }

    await runExtractor(config)

    // JA (primary single-"other") should receive the base key
    const jaFileContent = await vol.promises.readFile(jaPath, 'utf-8')
    const jaJson = JSON.parse(jaFileContent as string)
    expect(jaJson).toEqual({ key: 'key' })

    // EN (secondary) should preserve existing variant translations (not be overwritten)
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)
    expect(enJson).toEqual({
      key_one: 'One item',
      key_other: '{{count}} items'
    })
  })

  it('does not fail parsing files using `<Type>expr` assertions and still extracts keys', async () => {
    const sampleCode = `
      type ExampleType = { key: string }

      function getValues(): ExampleType[] {
        return [{ key: 'value' }]
      }

      function getValue(): ExampleType {
        return { key: 'value' }
      }

      export class ExampleService {
        public getService() {
          const multipleValues = <ExampleType[]>getValues()
          console.log(multipleValues)

          const singleValue = <ExampleType>getValue()
          console.log(singleValue)

          // Ensure extractor still finds normal t() keys in the same file
          t('some.key', 'Default')
        }
      }
    `

    vol.fromJSON({
      '/src/App.ts': sampleCode,
    })

    const results = await extract(mockConfig)

    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      some: { key: 'Default' }
    })
  })

  it('should extract keys from JSX inside .ts files using TSX fallback', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/tsx-in-ts.ts'])

    const sampleWithJsxInTs = `
      import { Trans, useTranslation } from 'react-i18next';
      export default function App() {
        const { t } = useTranslation();
        return (
          <div>
            <Trans i18nKey="app.title">Welcome</Trans>
            <p>{t('inline.key', 'Inline default')}</p>
          </div>
        );
      }
    `

    vol.fromJSON({ '/src/tsx-in-ts.ts': sampleWithJsxInTs })

    // Run the extractor - it should not throw and should extract keys from the .ts file
    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toBeDefined()
    expect(enJson.app).toBeDefined()
    expect(enJson.app.title).toBe('Welcome')
    expect(enJson.inline).toBeDefined()
    expect(enJson.inline.key).toBe('Inline default')
  })

  it('should preserve entire namespace when preservePatterns contains namespace:*', async () => {
    const sampleCode = `
      function App() {
        // This key should be extracted normally (different namespace)
        t('app.title', 'My App Title');
        
        // These keys match the assets namespace pattern and should NOT be extracted
        t('assets:image.logo', 'Logo Image');
        t('icon.home', { ns: 'assets', defaultValue: 'Home Icon'});
        t('completely.different', { ns: 'other', defaultValue: 'OTHER'});
        
        // Dynamic usage that also shouldn't be extracted
        const assetId = 'banner';
        t(\`assets:image.\${assetId}\`);
      }
    `
    const assetsPath = resolve(process.cwd(), 'locales/en/assets.json')
    const otherPath = resolve(process.cwd(), 'locales/en/other.json')

    // Prepopulate an existing namespace file that should be preserved
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      [assetsPath]: JSON.stringify({
        external: {
          key: 'External Value'
        },
        image: {
          banner: 'Existing Banner'
        }
      }, null, 2),
      [otherPath]: JSON.stringify({
        okey: 'here',
        second: 'whatever',
        secondTwo: 'whatever2',
        bye: 'can be removed'
      }, null, 2),
    })

    const configWithNamespacePattern: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: '.', // nested keys
        nsSeparator: ':',
        // Preserve whole namespace by pattern
        preservePatterns: ['assets:*', 'other:okey', 'other:second*'],
      },
    }

    await runExtractor(configWithNamespacePattern)

    // Ensure the assets namespace file was preserved untouched (no new keys added)
    const assetsContent = await vol.promises.readFile(assetsPath, 'utf-8')
    const assetsJson = JSON.parse(assetsContent as string)

    expect(assetsJson).toEqual({
      external: {
        key: 'External Value'
      },
      image: {
        banner: 'Existing Banner'
      }
      // The keys from code (assets:image.logo, assets:icon.home) should NOT be here
    })

    // Verify they were NOT extracted
    expect(assetsJson).not.toHaveProperty('image.logo')
    expect(assetsJson).not.toHaveProperty('icon')

    const otherContent = await vol.promises.readFile(otherPath, 'utf-8')
    const otherJson = JSON.parse(otherContent as string)
    expect(otherJson).toEqual({
      okey: 'here',
      completely: {
        different: 'OTHER'
      },
      second: 'whatever',
      secondTwo: 'whatever2'
    })

    // Ensure the normal extracted key went to translation.json
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
    const enJson = JSON.parse(enFileContent as string)

    expect(enJson).toEqual({
      app: {
        title: 'My App Title'
      }
    })

    // Verify assets keys didn't leak into translation.json
    expect(enJson).not.toHaveProperty('assets:image.logo')
    expect(enJson).not.toHaveProperty('assets:icon.home')
  })

  describe('colons in value', () => {
    it('should correctly write fallback values containing colons to file', async () => {
      const sampleCode = `
        t('ExampleKeyOne', 'Example: Value');
        t('ExampleKeyTwo', 'Example:');
        t('ExampleKeyThree', 'No colon here');
        t('url', 'https://example.com');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      await runExtractor(mockConfig)

      const enPath = resolve(process.cwd(), 'locales/en/translation.json')
      const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
      const enJson = JSON.parse(enFileContent as string)

      expect(enJson).toEqual({
        ExampleKeyOne: 'Example: Value',
        ExampleKeyTwo: 'Example:',
        ExampleKeyThree: 'No colon here',
        url: 'https://example.com',
      })
    })

    it('should correctly write fallback values with colons when nsSeparator is enabled', async () => {
      const sampleCode = `
        t('key1', 'Value: with colon');
        t('key2', 'Value:');
        t('common:key3', 'Another: value');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const configWithNs = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          nsSeparator: ':',
        },
      }

      await runExtractor(configWithNs)

      const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)

      expect(translationJson).toEqual({
        key1: 'Value: with colon',
        key2: 'Value:',
      })

      const commonPath = resolve(process.cwd(), 'locales/en/common.json')
      const commonFileContent = await vol.promises.readFile(commonPath, 'utf-8')
      const commonJson = JSON.parse(commonFileContent as string)

      expect(commonJson).toEqual({
        key3: 'Another: value',
      })
    })

    it('should write fallback values with multiple colons to file', async () => {
      const sampleCode = `
        t('time', '12:30:45');
        t('ratio', '16:9:4');
        t('label', 'Note: This is important: really');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      await runExtractor(mockConfig)

      const enPath = resolve(process.cwd(), 'locales/en/translation.json')
      const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
      const enJson = JSON.parse(enFileContent as string)

      expect(enJson).toEqual({
        time: '12:30:45',
        ratio: '16:9:4',
        label: 'Note: This is important: really',
      })
    })

    it('should preserve existing values with colons when merging', async () => {
      const sampleCode = `
        t('ExampleKeyTwo', 'Example:');
        t('newKey', 'New: Value');
      `

      const existingTranslations = {
        ExampleKeyOne: 'Existing: Value',
        ExampleKeyTwo: 'Old: Value',
      }

      vol.fromJSON({
        '/src/App.tsx': sampleCode,
        '/locales/en/translation.json': JSON.stringify(existingTranslations, null, 2),
      })

      await runExtractor(mockConfig)

      const enPath = resolve(process.cwd(), 'locales/en/translation.json')
      const enFileContent = await vol.promises.readFile(enPath, 'utf-8')
      const enJson = JSON.parse(enFileContent as string)

      expect(enJson).toEqual({
        ExampleKeyTwo: 'Old: Value', // Should preserve existing value
        newKey: 'New: Value',
      })
    })

    it('should correctly extract fallback strings containing colons with nsSeparator enabled', async () => {
      const sampleCode = `
        const i18next = require('i18next');

        i18next.init({
          lng: 'en'
        }, (err, t) => {
          if (err) return console.error(err);
          // Fallback string should be extracted (second parameter as string)
          console.log(t('translation:SomeKey', 'fallback:'));
          
          // Or using defaultValue in options object
          console.log(t('translation:AnotherKey','default fallback'));
        });
      `

      const existingTranslations = {
        SomeKey: 'fallback:',
        AnotherKey: 'default fallback',
      }

      vol.fromJSON({
        '/src/app.js': sampleCode,
        '/locales/en/translation.json': JSON.stringify(existingTranslations, null, 2),
      })

      const configWithNs = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          nsSeparator: ':',
          input: ['src/**/*.js'],
        },
      }

      // ✅ Use syncPrimaryWithDefaults option to match your reproduction
      await runExtractor(configWithNs, { syncPrimaryWithDefaults: true })

      const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)

      // This test will fail before the fix because 'SomeKey' will have an empty string value
      // The bug is that when nsSeparator is enabled and syncPrimaryWithDefaults is true,
      // the fallback 'fallback:' is being incorrectly identified as a "derived default"
      // because it contains a colon, resulting in an empty value
      expect(translationJson).toEqual({
        SomeKey: 'fallback:',  // Should be 'fallback:', NOT ''
        AnotherKey: 'default fallback',
      })
    })

    it('should handle colons in fallback values correctly regardless of nsSeparator position', async () => {
      const sampleCode = `
        // Colon at the end
        t('translation:key1', 'fallback:');
        
        // Colon in the middle  
        t('translation:key2', 'fall:back');
        
        // Multiple colons
        t('translation:key3', 'a:b:c');
        
        // URL as fallback
        t('translation:key4', 'https://example.com');
      `

      const existingTranslations = {
        key1: 'fallback:',
        key2: 'fall:back',
        key3: 'a:b:c',
        key4: 'https://example.com',
      }

      vol.fromJSON({
        '/src/app.js': sampleCode,
        '/locales/en/translation.json': JSON.stringify(existingTranslations, null, 2),
      })

      const configWithNs = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          nsSeparator: ':',
          input: ['src/**/*.js'],
        },
      }

      // ✅ Use syncPrimaryWithDefaults option to match the bug scenario
      await runExtractor(configWithNs, { syncPrimaryWithDefaults: true })

      const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
      const translationFileContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationFileContent as string)

      // All fallback values should be preserved exactly as written, not parsed for namespace separators
      expect(translationJson).toEqual({
        key1: 'fallback:',
        key2: 'fall:back',
        key3: 'a:b:c',
        key4: 'https://example.com',
      })
    })
  })

  describe('extractor: indentation with and without mergeNamespaces', () => {
    beforeEach(() => {
      vol.reset()
      vi.clearAllMocks()
      vi.spyOn(process, 'cwd').mockReturnValue('/')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('writes JSON with configured 6-space indentation for merged and non-merged outputs', async () => {
      // Ensure glob returns our source file so the extractor actually processes it
      const { glob } = await import('glob')
      vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

      // Case A: mergeNamespaces = true -> generator should write a per-language merged file
      const sampleA = `
        function App() {
          t('translation:key', 'Value');
          // also a plain defaultNS key
          t('plain.key', 'Plain');
        }
      `
      vol.fromJSON({
        '/src/App.tsx': sampleA,
      })

      const configA: any = {
        locales: ['en'],
        extract: {
          input: ['src/**/*.ts'],
          // functional output: per-language file
          output: (lng: string) => `locales/${lng}.json`,
          outputFormat: 'json',
          indentation: 6,
          mergeNamespaces: true,
          defaultNS: 'translation',
          functions: ['t'],
        },
        plugins: [],
      }

      const updatedA = await runExtractor(configA, { isDryRun: false })
      expect(updatedA).toBe(true)

      const contentA = await vol.promises.readFile(resolve('/', 'locales/en.json'), 'utf8')

      // Expect 6-space indentation for the namespace level and 12 for the nested key
      expect(contentA).toContain('\n' + ' '.repeat(6) + '"translation": {')
      expect(contentA).toContain('\n' + ' '.repeat(12) + '"key": "Value"')
      // plain.key should be present under its nested structure with correct indentation
      expect(contentA).toContain('\n' + ' '.repeat(12) + '"plain": {')
      expect(contentA).toContain('\n' + ' '.repeat(18) + '"key": "Plain"')

      // Case B: mergeNamespaces = false -> namespace file should still be written with 6-space indentation
      // Start a fresh in-memory FS state for Case B to avoid colliding with the merged file
      vol.reset()
      // Ensure glob now returns the new source file for Case B
      const { glob: glob2 } = await import('glob')
      vi.mocked(glob2).mockResolvedValue(['/src/AppB.tsx'])
      const sampleB = `
        function App() {
          t('key', 'Value');
        }
      `
      vol.fromJSON({
        '/src/AppB.tsx': sampleB,
      })

      const configB: any = {
        locales: ['en'],
        extract: {
          input: ['src/**/*.ts'],
          output: (lng: string, ns?: string) => `locales/${lng}.json`,
          outputFormat: 'json',
          indentation: 6,
          mergeNamespaces: false,
          defaultNS: 'translation',
          functions: ['t'],
        },
        plugins: [],
      }

      const updatedB = await runExtractor(configB, { isDryRun: false })
      expect(updatedB).toBe(true)

      const contentB = await vol.promises.readFile(resolve('/', 'locales/en.json'), 'utf8')

      // Expect 6-space indentation for the key when not merged
      expect(contentB).toContain('\n' + ' '.repeat(6) + '"key": "Value"')
    })
  })

  it('should extract keys when using TFunction<"my-custom-namespace"> and create namespace file', async () => {
    const sampleCode = `
      import { z } from "zod";
      import { TFunction } from "@/i18n";

      export const createRegisterSchema = (
        t: TFunction<"my-custom-namespace">,
      ) => {
        return z
        .object({
          email: z
          .string({
            required_error: t("Email is required"),
          })
          .email(t("Email is invalid")),

          firstname: z
          .string({
            required_error: t("Firstname is required"),
          })
          .min(1, { message: t("Firstname is required") }),
          lastname: z
          .string({
            required_error: t("Lastname is required"),
          })
          .min(1, { message: t("Lastname is required") }),
          password: z
          .string()
          .min(
            8,
            t("Password must be at least {{symbols}} symbols", {
              symbols: 8,
            }),
          )
          .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).+$/, t("Password is weak")),

          confirm: z.string(),
          agree: z.literal(true, {
            errorMap: () => ({ message: t("You must agree with the terms") }),
          }),
        })
        .refine((data) => data.password === data.confirm, {
          message: t("Password and Confirm mismatch"),
          path: ["confirm"],
        });
      };

      export const createLoginSchema = (
        t: TFunction<"my-custom-namespace">,
      ) => {
        return z.object({
          email: z
          .string({
            required_error: t("Email is required"),
          })
          .email(t("Email is invalid")),
          password: z.string().min(
            5,
            t("Password must be at least {{symbols}} symbols", {
              symbols: 5,
            }),
          ),
        });
      };
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const nsPath = resolve(process.cwd(), 'locales/en/my-custom-namespace.json')
    const nsContent = await vol.promises.readFile(nsPath, 'utf-8')
    const nsJson = JSON.parse(nsContent as string)

    // Expect that at least some keys from the file were extracted into the namespace file
    expect(nsJson).toHaveProperty('Email is required')
    expect(nsJson['Email is required']).toBe('Email is required')

    // Ensure keys did not accidentally go to the default translation.json
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    try {
      const translationContent = await vol.promises.readFile(translationPath, 'utf-8')
      const translationJson = JSON.parse(translationContent as string)
      expect(translationJson).not.toHaveProperty('Email is required')
    } catch (err) {
      // translation.json may not exist — that's fine
      if ((err as any)?.code !== 'ENOENT') throw err
    }
  })
})
