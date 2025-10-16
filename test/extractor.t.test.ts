import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

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

    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/app.json'))

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
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const headerFile = results.find(r => pathEndsWith(r.path, '/locales/en/header.json'))

      expect(headerFile).toBeDefined()
      expect(headerFile!.newTranslations).toEqual({ title: 'A Header' })
    })

    it('should allow key to override the useTranslation namespace', async () => {
      const sampleCode = `
        const { t } = useTranslation('common');
        t('header:title', { defaultValue: 'A Header' });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const headerFile = results.find(r => pathEndsWith(r.path, '/locales/en/header.json'))

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
      const clipFile = results.find(r => pathEndsWith(r.path, '/locales/en/clip.json'))
      expect(clipFile).toBeDefined()
      expect(clipFile!.newTranslations).toEqual({ changes: 'changes' })
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))
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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const ns1File = results.find(r => pathEndsWith(r.path, '/locales/en/ns1.json'))
      const ns2File = results.find(r => pathEndsWith(r.path, '/locales/en/ns2.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // This expectation is correct: for dynamic context, we need the base key and all variants.
      expect(translationFile!.newTranslations).toEqual({
        friend: 'A friend', // base key
        friend_male: 'A friend',
        friend_female: 'A friend',
        alert: 'An alert', // base key
        alert_important: 'An alert', // undefined is ignored
      })
    })

    it('should extract all possible keys from template string in the context option', async () => {
      const sampleCode = `
        const isFemale = true;
        t('friend', 'A friend', { context: \`$\{isFemale ? 'fe' : ''}male\` });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // This expectation is correct: for dynamic context, we need the base key and all variants.
      expect(translationFile!.newTranslations).toEqual({
        friend: 'A friend', // base key, dynamic context
        friend_male: 'A friend',
        friend_female: 'A friend',
      })
    })

    it('should extract static contexts', async () => {
      const sampleCode = `
        t('alert.text', 'An alert', { context: true });
        t('alert.number', 'A numeric alert', { context: 10 });
        t('alert.empty', 'An empty alert', { context: '' });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        alert: {
          text_true: 'An alert', // no base key, static context
          number_10: 'A numeric alert', // no base key, static context
          empty: 'An empty alert', // context is ''
        }
      })
    })

    it('should extract all possible keys with a ternary first argument', async () => {
      const sampleCode = `
        const isOpen = true;
        t('open', 'Open');
        t('closed', 'Closed');
        t(isOpen ? 'open' : 'closed');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        open: 'Open',
        closed: 'Closed',
      })
    })

    it('should extract all possible keys with a template string first argument', async () => {
      const sampleCode = `
        const isDone = true;

        t(\`state.\${isDone ? 'done' : 'notDone'}.title\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        state: {
          done: {
            title: 'state.done.title',
          },
          notDone: {
            title: 'state.notDone.title',
          },
        },
      })
    })

    it('should extract keys from template string with numeric and boolean literals', async () => {
      const sampleCode = `
        const isFive = true;

        t(\`messages.\${isFive ? 5 : false}.title\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        messages: {
          5: {
            title: 'messages.5.title',
          },
          false: {
            title: 'messages.false.title',
          },
        },
      })
    })

    it('should extract keys from template string with annotated variable', async () => {
      const sampleCode = `
        const state = 'pending';

        t(\`states.\${state satisfies 'pending' | 'finalized'}.description\`);
        t(\`states.\${state as 'baseball'}.description\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        states: {
          pending: {
            description: 'states.pending.description',
          },
          finalized: {
            description: 'states.finalized.description',
          },
          baseball: {
            description: 'states.baseball.description',
          },
        },
      })
    })

    it('should extract all possible keys with nested expressions', async () => {
      const sampleCode = `
        const test = false;
        const state = 'unknown';

        t(test ? \`state.\${state === 'final' ? 'finalized' : \`\${state === 'pending' ? 'pending' : 'unknown'}\`}.title\` : 'state.test.title');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        state: {
          finalized: {
            title: 'state.finalized.title',
          },
          pending: {
            title: 'state.pending.title',
          },
          test: {
            title: 'state.test.title',
          },
          unknown: {
            title: 'state.unknown.title',
          },
        },
      })
    })

    it('should correctly handle empty strings in template literal', async () => {
      const sampleCode = `
        const hasProducts = false;
        const isAvailable = true;

        t(\`section.intro.header.marketing\${isAvailable ? '.available' : ''}\`)
        t(\`section.intro.header.\${
                  hasProducts ? 'products' : 'no-products'
              }\${isAvailable ? '.available' : ''}\`)
        `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract({ ...mockConfig, extract: { ...mockConfig.extract, keySeparator: false, } })
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        'section.intro.header.marketing': 'section.intro.header.marketing',
        'section.intro.header.marketing.available': 'section.intro.header.marketing.available',
        'section.intro.header.no-products': 'section.intro.header.no-products',
        'section.intro.header.no-products.available': 'section.intro.header.no-products.available',
        'section.intro.header.products': 'section.intro.header.products',
        'section.intro.header.products.available': 'section.intro.header.products.available',
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
      const file = results.find(r => pathEndsWith(r.path, '/locales/en/test.json'))

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
      const customNsFile = results.find(r => pathEndsWith(r.path, '/locales/en/custom-ns.json'))

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
      const customNsFile = results.find(r => pathEndsWith(r.path, '/locales/en/custom-ns.json'))

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
      const authFile = results.find(r => pathEndsWith(r.path, '/locales/en/auth.signin.json'))

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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
      const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
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
      const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/ar/translation.json'))

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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // For English, ordinal rules are 'one', 'two', 'few', 'other'
      expect(translationFile!.newTranslations).toEqual({
        place_ordinal_one: '{{count}}st place',
        place_ordinal_two: '{{count}}nd place',
        place_ordinal_few: '{{count}}rd place',
        place_ordinal_other: '{{count}}th place',
      })
    })

    it('should extract ordinal plural keys from a key with an _ordinal suffix', async () => {
      const sampleCode = `
      t('place_ordinal', { 
        count: 1, 
        // Test with specific default values for ordinal forms
        defaultValue_ordinal_one: "{{count}}st place",
        defaultValue_ordinal_other: "{{count}}th place",
      });
    `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      // English has 4 ordinal forms: one, two, few, other
      expect(translationFile!.newTranslations).toEqual({
        place_ordinal_one: '{{count}}st place', // specific default
        place_ordinal_two: '{{count}}th place', // fallback to _other
        place_ordinal_few: '{{count}}th place', // fallback to _other
        place_ordinal_other: '{{count}}th place',
      })
    })

    it('should combine context and plural variants', async () => {
      const sampleCode = `
        const test = true;

        t('state', {
          context: test ? 'test' : 'production', 
          count: 2,
          defaultValue_one: "{{count}} car",
          defaultValue_other: "{{count}} cars",
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile!.newTranslations).toEqual({
        state_one: '{{count}} car',
        state_other: '{{count}} cars',
        state_test_one: '{{count}} car',
        state_test_other: '{{count}} cars',
        state_production_one: '{{count}} car',
        state_production_other: '{{count}} cars',
      })
    })

    it('should generate all Arabic plural forms when ar-SA is in locales with context', async () => {
      const sampleCode = `
        // t('options.option', { ns: 'common', context: 'MONTHS', count: 1 })
        // t('options.option', { ns: 'common', context: 'WEEKS', count: 1 })
        // t('options.option', { ns: 'common', context: 'DAYS', count: 1 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Include Arabic to trigger all plural forms
      const arabicConfig: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['en', 'ar-SA'], // Include Arabic
        extract: {
          ...mockConfig.extract,
        },
      }

      const results = await extract(arabicConfig)

      // Check English file - should only have English plural forms (one, other)
      const englishCommonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))
      expect(englishCommonFile).toBeDefined()
      expect(englishCommonFile!.newTranslations).toEqual({
        options: {
          // English only has 2 plural forms
          option_DAYS_one: 'options.option',
          option_DAYS_other: 'options.option',
          option_MONTHS_one: 'options.option',
          option_MONTHS_other: 'options.option',
          option_WEEKS_one: 'options.option',
          option_WEEKS_other: 'options.option',
          // Base forms
          option_one: 'options.option',
          option_other: 'options.option',
        },
      })

      // Check Arabic file - should have all 6 Arabic plural forms
      const arabicCommonFile = results.find(r => pathEndsWith(r.path, '/locales/ar-SA/common.json'))
      expect(arabicCommonFile).toBeDefined()
      expect(arabicCommonFile!.newTranslations).toEqual({
        options: {
          // Arabic has 6 plural forms: zero, one, two, few, many, other
          option_DAYS_zero: '',
          option_DAYS_one: '',
          option_DAYS_two: '',
          option_DAYS_few: '',
          option_DAYS_many: '',
          option_DAYS_other: '',
          option_MONTHS_zero: '',
          option_MONTHS_one: '',
          option_MONTHS_two: '',
          option_MONTHS_few: '',
          option_MONTHS_many: '',
          option_MONTHS_other: '',
          option_WEEKS_zero: '',
          option_WEEKS_one: '',
          option_WEEKS_two: '',
          option_WEEKS_few: '',
          option_WEEKS_many: '',
          option_WEEKS_other: '',
          // Base forms
          option_zero: '',
          option_one: '',
          option_two: '',
          option_few: '',
          option_many: '',
          option_other: '',
        },
      })
    })

    it('should generate all Arabic plural forms when ar-SA is in locales without context', async () => {
      const sampleCode = `
        // t('item', { count: 1 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Include Arabic to trigger all plural forms
      const arabicConfig: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['en', 'ar-SA'], // Include Arabic
      }

      const results = await extract(arabicConfig)

      // Check English file - should only have English plural forms
      const englishTranslationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
      expect(englishTranslationFile).toBeDefined()
      expect(englishTranslationFile!.newTranslations).toEqual({
        // English only has 2 plural forms
        item_one: 'item',
        item_other: 'item',
      })

      // Check Arabic file - should have all 6 Arabic plural forms
      const arabicTranslationFile = results.find(r => pathEndsWith(r.path, '/locales/ar-SA/translation.json'))
      expect(arabicTranslationFile).toBeDefined()
      expect(arabicTranslationFile!.newTranslations).toEqual({
        // Arabic has 6 plural forms
        item_zero: '',
        item_one: '',
        item_two: '',
        item_few: '',
        item_many: '',
        item_other: '',
      })
    })

    it('should only generate English plural forms when only English is in locales', async () => {
      const sampleCode = `
        // t('item', { count: 1 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      // Only English
      const englishOnlyConfig: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['en'], // Only English
      }

      const results = await extract(englishOnlyConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // Should only generate English plural forms
      expect(translationFile!.newTranslations).toEqual({
        item_one: 'item',
        item_other: 'item',
      })
    })

    it('should skip base plural forms when generateBasePluralForms is false and context is used', async () => {
      const sampleCode = `
        // t('options.option', { context: 'MONTHS', count: 1 })
        // t('options.option', { context: 'WEEKS', count: 1 })
        // t('options.option', { context: 'DAYS', count: 1 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const configWithDisabledBaseForms: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['en', 'ar-SA'], // Include Arabic to trigger all plural forms
        extract: {
          ...mockConfig.extract,
          generateBasePluralForms: false, // New option to disable base forms
        },
      }

      const results = await extract(configWithDisabledBaseForms)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // Should only generate context-specific plural forms, no base forms
      expect(translationFile!.newTranslations).toEqual({
        options: {
          // Only context-specific forms
          option_DAYS_one: 'options.option',
          option_DAYS_other: 'options.option',
          option_MONTHS_one: 'options.option',
          option_MONTHS_other: 'options.option',
          option_WEEKS_one: 'options.option',
          option_WEEKS_other: 'options.option',
          // No base forms like option_one, option_other
        },
      })

      // Check Arabic file also only has context forms
      const arabicFile = results.find(r => pathEndsWith(r.path, '/locales/ar-SA/translation.json'))
      expect(arabicFile).toBeDefined()
      expect(arabicFile!.newTranslations).toEqual({
        options: {
          // Arabic context-specific forms (all 6 plural categories)
          option_DAYS_zero: '',
          option_DAYS_one: '',
          option_DAYS_two: '',
          option_DAYS_few: '',
          option_DAYS_many: '',
          option_DAYS_other: '',
          option_MONTHS_zero: '',
          option_MONTHS_one: '',
          option_MONTHS_two: '',
          option_MONTHS_few: '',
          option_MONTHS_many: '',
          option_MONTHS_other: '',
          option_WEEKS_zero: '',
          option_WEEKS_one: '',
          option_WEEKS_two: '',
          option_WEEKS_few: '',
          option_WEEKS_many: '',
          option_WEEKS_other: '',
          // No base forms
        },
      })
    })

    it('should still generate base plural forms when generateBasePluralForms is false but no context is used', async () => {
      const sampleCode = `
        // t('item', { count: 1 })
        // t('product', { count: 2 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const configWithDisabledBaseForms: I18nextToolkitConfig = {
        ...mockConfig,
        locales: ['en', 'ar-SA'],
        extract: {
          ...mockConfig.extract,
          generateBasePluralForms: false, // This should not affect keys without context
        },
      }

      const results = await extract(configWithDisabledBaseForms)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // Should still generate base plural forms since no context is used
      expect(translationFile!.newTranslations).toEqual({
        item_one: 'item',
        item_other: 'item',
        product_one: 'product',
        product_other: 'product',
      })
    })

    it('should generate both base and context forms when generateBasePluralForms is true (default)', async () => {
      const sampleCode = `
        // t('options.option', { context: 'MONTHS', count: 1 })
      `

      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const configWithEnabledBaseForms: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          generateBasePluralForms: true, // Explicit true (this is the default)
        },
      }

      const results = await extract(configWithEnabledBaseForms)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()

      // Should generate both base and context forms
      expect(translationFile!.newTranslations).toEqual({
        options: {
          // Base forms
          option_one: 'options.option',
          option_other: 'options.option',
          // Context forms
          option_MONTHS_one: 'options.option',
          option_MONTHS_other: 'options.option',
        },
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
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // This test will fail before the fix because the key will not be found.
      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'A key from a member expression': 'A key from a member expression',
      })
    })

    it('should handle wildcard patterns in the functions array to match suffixes', async () => {
      const sampleCode = `
      // These should all be matched by '*.t' or 't'
      t('key.simple');
      i18n.t('key.member');
      this._i18n.t('key.this');

      // This should be ignored
      ignoreThis('key.ignored');
    `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const customConfig: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          keySeparator: false,
          // Use a wildcard to match any function ending in '.t', plus the base 't'
          functions: ['*.t', 't'],
        },
      }

      const results = await extract(customConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'key.simple': 'key.simple',
        'key.member': 'key.member',
        'key.this': 'key.this',
      })
    })

    it('should treat empty string context as "no context" like i18next does', async () => {
      const sampleCode = `
      const test = false;
      t('state.description', { context: test ? 'test' : '' });
    `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        state: {
          description: 'state.description',
          description_test: 'state.description',
        },
      })

      // Ensure there's no key with an underscore suffix (state.description_)
      expect(translationFile!.newTranslations.state).not.toHaveProperty('description_')
    })

    describe('disablePlurals', () => {
      it('should not generate plural keys when disablePlurals is true', async () => {
        const sampleCode = `
          // These calls have count but should not generate plural forms
          t('item', { count: 1, defaultValue: 'Item' })
          t('product', { count: 5, defaultValue: 'Product' })
          t('message', { count: 0 })
          
          // Context should still work normally
          t('friend', { context: 'male', defaultValue: 'Friend' })
          
          // But context + count should not generate plurals
          t('greeting', { context: 'formal', count: 2, defaultValue: 'Greeting' })
        `

        vol.fromJSON({ '/src/App.tsx': sampleCode })

        const configWithDisabledPlurals: I18nextToolkitConfig = {
          ...mockConfig,
          extract: {
            ...mockConfig.extract,
            disablePlurals: true, // Disable all plural generation
          },
        }

        const results = await extract(configWithDisabledPlurals)
        const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

        expect(translationFile).toBeDefined()

        // Should only generate base keys, no plural suffixes
        expect(translationFile!.newTranslations).toEqual({
          item: 'Item',
          product: 'Product',
          message: 'message',
          friend_male: 'Friend', // Context still works
          greeting_formal: 'Greeting', // Context works, but no plurals
        })
      })

      it('should not generate plural keys for Trans components when disablePlurals is true', async () => {
        const sampleCode = `
          function App() {
            return (
              <div>
                <Trans i18nKey="item" count={count}>Item</Trans>
                <Trans i18nKey="greeting" context="formal" count={count}>Greeting</Trans>
              </div>
            );
          }
        `

        vol.fromJSON({ '/src/App.tsx': sampleCode })

        const configWithDisabledPlurals: I18nextToolkitConfig = {
          ...mockConfig,
          extract: {
            ...mockConfig.extract,
            disablePlurals: true, // Disable all plural generation
          },
        }

        const results = await extract(configWithDisabledPlurals)
        const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

        expect(translationFile).toBeDefined()

        // Should only generate base keys, no plural suffixes
        expect(translationFile!.newTranslations).toEqual({
          item: 'Item',
          greeting_formal: 'Greeting', // Context works, but no plurals
        })
      })

      it('should not generate plural keys from comments when disablePlurals is true', async () => {
        const sampleCode = `
          // t('item.count', { count: 1, defaultValue: 'Item' })
          // t('user.messages', { count: 5 })
          // t('greeting.formal', { context: 'business', count: 2 })
        `

        vol.fromJSON({ '/src/App.tsx': sampleCode })

        const configWithDisabledPlurals: I18nextToolkitConfig = {
          ...mockConfig,
          extract: {
            ...mockConfig.extract,
            disablePlurals: true,
          },
        }

        const results = await extract(configWithDisabledPlurals)
        const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

        expect(translationFile).toBeDefined()

        // Should only generate base keys, no plural suffixes
        expect(translationFile!.newTranslations).toEqual({
          item: {
            count: 'Item',
          },
          user: {
            messages: 'user.messages',
          },
          greeting: {
            formal_business: 'greeting.formal', // Context works, no plurals
          },
        })
      })

      it('should respect generateBasePluralForms when disablePlurals is false (default behavior)', async () => {
        const sampleCode = `
          t('item', { count: 1, context: 'small' })
        `

        vol.fromJSON({ '/src/App.tsx': sampleCode })

        const configWithPluralsEnabled: I18nextToolkitConfig = {
          ...mockConfig,
          extract: {
            ...mockConfig.extract,
            disablePlurals: false, // Explicitly enable plurals (this is the default)
            generateBasePluralForms: false, // But disable base forms when context is present
          },
        }

        const results = await extract(configWithPluralsEnabled)
        const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

        expect(translationFile).toBeDefined()

        // Should generate context+plural combinations but not base plurals
        expect(translationFile!.newTranslations).toEqual({
          item_small_one: 'item',
          item_small_other: 'item',
        // No item_one, item_other because generateBasePluralForms is false
        })
      })
    })
  })
})
