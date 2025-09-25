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
})
