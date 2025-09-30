import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
  },
}

describe('extractor: advanced t features', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should handle namespaces in the key (ns:key)', async () => {
    const sampleCode = `
      t('common:button.save', 'Save');
      t('app:title', 'My App');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const configWithNs = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        nsSeparator: ':',
        defaultNS: 'translation',
      },
    }

    const results = await extract(configWithNs)

    const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))
    const translationFile = results.find(r => r.path.endsWith('/locales/en/app.json'))

    expect(commonFile).toBeDefined()
    expect(translationFile).toBeDefined()

    expect(commonFile!.newTranslations).toEqual({
      button: { save: 'Save' },
    })
    expect(translationFile!.newTranslations).toEqual({
      title: 'My App',
    })
  })

  it('should handle the "ns" option in t()', async () => {
    const sampleCode = 't(\'button.save\', { ns: \'common\', defaultValue: \'Save\' })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const configWithNsOptions: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        // Disable nsSeparator to ensure we are only testing the `ns` option
        nsSeparator: false,
      },
    }

    const results = await extract(configWithNsOptions)
    const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({
      button: {
        save: 'Save',
      },
    })
  })

  describe('in react-i18next', () => {
    it('should detect the namespace from useTranslation("ns1")', async () => {
      const sampleCode = `
        const { t } = useTranslation('common');
        t('button.save', 'Save');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ button: { save: 'Save' } })
    })

    it('should detect the first namespace from useTranslation(["ns1", "ns2"])', async () => {
      const sampleCode = `
        const { t } = useTranslation(['common', 'header']);
        t('button.save', 'Save'); // Should go to 'common'
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ button: { save: 'Save' } })
    })

    it('should detect the first namespace from useTranslation(["ns1"])', async () => {
      const sampleCode = `
        const { t } = useTranslation(['common']);
        t('button.save', 'Save'); // Should go to 'common'
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ button: { save: 'Save' } })
    })

    it('should allow {ns: ...} to override the useTranslation namespace', async () => {
      const sampleCode = `
        const { t } = useTranslation('common');
        t('title', { ns: 'header', defaultValue: 'A Header' });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const headerFile = results.find(r => r.path.endsWith('/locales/en/header.json'))

      expect(headerFile).toBeDefined()
      expect(headerFile!.newTranslations).toEqual({ title: 'A Header' })
    })

    it('should detect the correct namespace from multiple useTranslation calls', async () => {
      const sampleCode = `
        function NotificationItem() {
          const { t } = useTranslation('clip')
          t('changes')
        }

        function NotificationContent() {
          const { t } = useTranslation('common')
          t('news')
        }
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const clipFile = results.find(r => r.path.endsWith('/locales/en/clip.json'))
      expect(clipFile).toBeDefined()
      expect(clipFile!.newTranslations).toEqual({ changes: 'changes' })
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))
      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ news: 'news' })
    })

    it('should handle keyPrefix from useTranslation options', async () => {
      const sampleCode = `
        const { t } = useTranslation('translation', { keyPrefix: 'very.deeply.nested' });
        const text = t('key'); // Should be extracted as 'very.deeply.nested.key'
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        very: {
          deeply: {
            nested: {
              key: 'key', // The default value is the unprefixed key
            },
          },
        },
      })
    })

    it('should handle aliased t functions from useTranslation', async () => {
      const sampleCode = `
        const { t: myTr } = useTranslation('ns1');
        const { t: t2 } = useTranslation('ns2');
        myTr('key.in.ns1', 'Key 1');
        t2('key.in.ns2', 'Key 2');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const ns1File = results.find(r => r.path.endsWith('/locales/en/ns1.json'))
      const ns2File = results.find(r => r.path.endsWith('/locales/en/ns2.json'))

      expect(ns1File).toBeDefined()
      expect(ns2File).toBeDefined()

      expect(ns1File!.newTranslations).toEqual({ key: { in: { ns1: 'Key 1' } } })
      expect(ns2File!.newTranslations).toEqual({ key: { in: { ns2: 'Key 2' } } })
    })

    it('should handle array destructuring from useTranslation', async () => {
      const sampleCode = `
        const [t] = useTranslation('common');
        t('button.submit', 'Submit');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ button: { submit: 'Submit' } })
    })

    it('should extract all possible keys from a ternary in the context option', async () => {
      const sampleCode = `
        const isMale = true;
        t('friend', 'A friend', { context: isMale ? 'male' : 'female' });
        t('alert', 'An alert', { context: isImportant ? 'important' : undefined });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      // This expectation is correct: for dynamic context, we need the base key and all variants.
      expect(translationFile!.newTranslations).toEqual({
        friend: 'A friend', // base key
        friend_male: 'A friend',
        friend_female: 'A friend',
        alert: 'An alert', // base key
        alert_important: 'An alert', // undefined is ignored
      })
    })

    it('should extract keys from t() calls inside array.map in JSX', async () => {
      const sampleCode = `
        function MappedComponent() {
          const { t } = useTranslation('test');
          return (
            <>
              {t('one', '1')}
              {["two"].map((number, index) => (
                <div key={index}>
                  {t('two', '2')}
                </div>
              ))}
              {t('three', '3')}
            </>
          )
        }
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })
      const config = { ...mockConfig, extract: { ...mockConfig.extract, functions: ['t'], useTranslationNames: ['useTranslation'] } }

      const results = await extract(config)
      const file = results.find(r => r.path.endsWith('/locales/en/test.json'))

      expect(file).toBeDefined()
      expect(file!.newTranslations).toEqual({
        one: '1',
        two: '2',
        three: '3',
      })
    })

    it('should handle custom hook with configurable namespace and keyPrefix argument positions', async () => {
      const sampleCode = `
        const { t } = loadPageTranslations(
          'en', // 0: locale (ignored)
          'custom-ns', // 1: namespace
          { keyPrefix: 'deep.prefix' } // 2: options object with keyPrefix
        );

        t('myKey', 'My Value'); // Should be extracted as 'deep.prefix.myKey' into the 'custom-ns' namespace
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Create a specific config for this test with the new custom hook configuration
      const customHookConfig: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          // Define the custom hook and its argument positions
          useTranslationNames: [
            'useTranslation', // Keep the default for other tests
            {
              name: 'loadPageTranslations',
              nsArg: 1,       // Namespace is the 2nd argument (index 1)
              keyPrefixArg: 2 // Options object is the 3rd argument (index 2)
            }
          ]
        }
      }

      const results = await extract(customHookConfig)

      // Find the generated file for our custom namespace
      const customNsFile = results.find(r => r.path.endsWith('/locales/en/custom-ns.json'))

      expect(customNsFile).toBeDefined()
      expect(customNsFile!.newTranslations).toEqual({
        deep: {
          prefix: {
            myKey: 'My Value',
          },
        },
      })
    })

    it('should handle custom async hook with configurable namespace and keyPrefix argument positions', async () => {
      const sampleCode = `
        const { t } = await loadPageTranslations(
          'en', // 0: locale (ignored)
          'custom-ns', // 1: namespace
          { keyPrefix: 'deep.prefix' } // 2: options object with keyPrefix
        );

        t('myKey', 'My Value'); // Should be extracted as 'deep.prefix.myKey' into the 'custom-ns' namespace
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Create a specific config for this test with the new custom hook configuration
      const customHookConfig: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          // Define the custom hook and its argument positions
          useTranslationNames: [
            'useTranslation', // Keep the default for other tests
            {
              name: 'loadPageTranslations',
              nsArg: 1,       // Namespace is the 2nd argument (index 1)
              keyPrefixArg: 2 // Options object is the 3rd argument (index 2)
            }
          ]
        }
      }

      const results = await extract(customHookConfig)

      // Find the generated file for our custom namespace
      const customNsFile = results.find(r => r.path.endsWith('/locales/en/custom-ns.json'))

      expect(customNsFile).toBeDefined()
      expect(customNsFile!.newTranslations).toEqual({
        deep: {
          prefix: {
            myKey: 'My Value',
          },
        },
      })
    })

    it('should handle custom async hook with direct assignment and selector API', async () => {
      const sampleCode = `
        let t = await getServerT('auth.signin', {
          keyPrefix: 'page.submissionErrors',
        });

        const error = t(($) => $.invalidEmailError);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const customHookConfig: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          useTranslationNames: [
            'useTranslation',
            {
              name: 'getServerT',
              nsArg: 0,
              keyPrefixArg: 1,
            },
          ],
        },
      }

      const results = await extract(customHookConfig)
      const authFile = results.find(r => r.path.endsWith('/locales/en/auth.signin.json'))

      // This test will fail before the fix because `authFile` will be undefined.
      expect(authFile).toBeDefined()
      expect(authFile!.newTranslations).toEqual({
        page: {
          submissionErrors: {
            invalidEmailError: 'invalidEmailError',
          },
        },
      })
    })
  })

  describe('getFixedT support', () => {
    it('should handle keyPrefix from getFixedT', async () => {
      const sampleCode = `
        const t = i18next.getFixedT(null, null, 'user.account');
        const text = t('changePassword.title'); // -> user.account.changePassword.title
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        user: {
          account: {
            changePassword: {
              title: 'changePassword.title',
            },
          },
        },
      })
    })

    it('should handle a fixed namespace from getFixedT', async () => {
      const sampleCode = `
        const common_t = i18next.getFixedT(null, 'common');
        common_t('button.save'); // -> goes to 'common' namespace
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({ button: { save: 'button.save' } })
    })

    it('should handle both a fixed namespace and keyPrefix', async () => {
      const sampleCode = `
        const t = i18next.getFixedT('en', 'common', 'forms.user');
        t('name'); // -> common:forms.user.name
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

      expect(commonFile).toBeDefined()
      expect(commonFile!.newTranslations).toEqual({
        forms: {
          user: {
            name: 'name',
          },
        },
      })
    })
  })

  describe('selector api', () => {
    it('should handle mixed dot and bracket notation in selectors', async () => {
      const sampleCode = "t($ => $.app['title'].main)"
      vol.fromJSON({ '/src/App.tsx': sampleCode })
      const results = await extract(mockConfig)
      const file = results.find(r => r.path.endsWith('/locales/en/translation.json'))
      expect(file!.newTranslations).toEqual({ app: { title: { main: 'app.title.main' } } })
    })

    it('should handle block bodies and keySeparator: false', async () => {
      const sampleCode = `
        // Using a block body in the selector
        t($ => { return $.app.title.main; });
      `
      // Configure for flat keys (keySeparator: false)
      const flatKeyConfig = {
        ...mockConfig,
        extract: { ...mockConfig.extract, keySeparator: false },
      }
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // @ts-ignore
      const results = await extract(flatKeyConfig)
      const file = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      // The key should be extracted as a single flat string
      expect(file!.newTranslations).toEqual({
        'app.title.main': 'app.title.main',
      })
    })

    it('should handle selector API used inside Trans props', async () => {
      const sampleCode = `
        import { Trans, useTranslation } from 'react-i18next';

        function MyComponent() {
          const { t } = useTranslation();
          return (
            <Trans i18nKey="myKey">
              Hello <strong title={t($ => $.tooltips.save)}>World</strong>
            </Trans>
          );
        }
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })
      const results = await extract(mockConfig)
      const file = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(file).toBeDefined()

      // The serializer extracts the content ("Hello <strong>World</strong>") for the defaultValue
      // and separately extracts the key from the title attribute.
      expect(file!.newTranslations).toEqual({
        myKey: 'Hello <strong>World</strong>',
        tooltips: {
          save: 'tooltips.save',
        },
      })
    })
  })

  describe('key fallbacks', () => {
    it('should extract all static keys from an array', async () => {
      const sampleCode = `
        t(['key.primary', 'key.fallback'], 'The fallback value');
        // This one has a dynamic key that will be ignored, but a static fallback that will be extracted
        t([errorKey, 'error.unspecific']);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })
      const results = await extract(mockConfig)
      const file = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(file).toBeDefined()
      expect(file!.newTranslations).toEqual({
        key: {
          // The first key's default value is itself
          primary: 'key.primary',
          // The second key gets the explicit default value
          fallback: 'The fallback value',
        },
        error: {
          // The static fallback key is correctly extracted
          unspecific: 'error.unspecific',
        },
      })
    })
  })

  describe('plurals', () => {
    it('should extract plural-specific default values (e.g., defaultValue_other)', async () => {
      const sampleCode = `
        t('DogCount', { 
          count: 5, 
          defaultValue_other: "{{count}} dogs", 
          defaultValue: "{{count}} dog" 
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        DogCount_one: '{{count}} dog', // From generic defaultValue
        DogCount_other: '{{count}} dogs', // From specific defaultValue_other
      })
    })

    it('should generate all required keys for languages with multiple plural forms (e.g., Arabic)', async () => {
      const sampleCode = `
        t('item', { 
          count: 5, 
          defaultValue_other: "{{count}} items", 
          defaultValue_two: "two items", 
          defaultValue_many: "many items", 
          defaultValue: "{{count}} item" 
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Create a specific config for this test with 'ar' as the primary language
      const arabicConfig: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['ar'], // Set locales to only include Arabic for this test
        extract: {
          ...mockConfig.extract,
          primaryLanguage: 'ar', // This is the key change
        },
      }

      const results = await extract(arabicConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/ar/translation.json'))

      expect(translationFile).toBeDefined()

      // Arabic has 6 plural forms: zero, one, two, few, many, other
      // The extractor should generate a key for each one.
      expect(translationFile!.newTranslations).toEqual({
        item_zero: '{{count}} items',
        item_one: '{{count}} item',
        item_two: 'two items',
        item_few: '{{count}} items',
        item_many: 'many items',
        item_other: '{{count}} items',
      })
    })

    it('should generate ordinal plural keys when ordinal: true is used', async () => {
      const sampleCode = `
        t('place', { 
          count: 1, 
          ordinal: true,
          defaultValue_ordinal_one: "{{count}}st place",
          defaultValue_ordinal_two: "{{count}}nd place",
          defaultValue_ordinal_few: "{{count}}rd place",
          defaultValue_ordinal_other: "{{count}}th place",
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // For English, ordinal rules are 'one', 'two', 'few', 'other'
      expect(translationFile!.newTranslations).toEqual({
        place_ordinal_one: '{{count}}st place',
        place_ordinal_two: '{{count}}nd place',
        place_ordinal_few: '{{count}}rd place',
        place_ordinal_other: '{{count}}th place',
      })
    })
  })

  it('should extract keys from a custom function with a member expression (i.e., i18n.t)', async () => {
    const sampleCode = `
    import i18n from '@/i18n';
    const message = i18n.t('A key from a member expression');
  `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        keySeparator: false, // Use flat keys for simplicity
        // Explicitly tell the extractor to look for 'i18n.t'
        functions: ['t', 'i18n.t'],
      },
    }

    const results = await extract(customConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    // This test will fail before the fix because the key will not be found.
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      'A key from a member expression': 'A key from a member expression',
    })
  })
})
