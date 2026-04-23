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
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor: custom hook keyPrefix/namespace extraction', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should apply direct string keyPrefix from a custom hook returning t', async () => {
    const sampleCode = `
      // custom hook returning { t }
      const { t } = useTranslate('footer')
      t('title', 'Footer title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        // register the custom hook: first arg is keyPrefix, no namespace arg
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslate', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      footer: {
        title: 'Footer title',
      },
    })
  })

  it('should apply hook-level keyPrefix to getFixedT usage returned from custom hook', async () => {
    const sampleCode = `
      // custom hook returning { getFixedT }
      const { getFixedT } = useTranslate('helloservice')
      const t = getFixedT('en', 'serviceNs')
      t('title', 'Hello service title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslate', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/serviceNs.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      helloservice: {
        title: 'Hello service title',
      },
    })
  })

  // New tests suggested for broader coverage of #78
  it('should apply hook-level keyPrefix when getFixedT is aliased (destructure alias)', async () => {
    const sampleCode = `
      // custom hook returning { getFixedT } aliased to ` + '`g`' + `
      const { getFixedT: g } = useTranslate('helloservice')
      const t = g('en', 'serviceNs')
      t('title', 'Hello service title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslate', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/serviceNs.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      helloservice: {
        title: 'Hello service title',
      },
    })
  })

  it('resolves simple identifier keyPrefix declared in same file', async () => {
    const sampleCode = `
      const prefix = 'footer'
      const { t } = useTranslate(prefix)
      t('title', 'Footer title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslate', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    // Simple identifier declared as `const prefix = 'footer'` should be resolved
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      footer: {
        title: 'Footer title',
      },
    })
  })

  it('propagates namespace from a custom hook bound to a non-destructured object via member expression t() — issue #239', async () => {
    // The hook returns an object with a `t` method, and the user uses it as
    // `obj.t(key)` instead of destructuring `const { t } = ...`.
    const sampleCode = `
      const emailError = useTranslateKeyState('auth')
      emailError.t('loginForm.input.email.required', 'Email is required')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        functions: ['t', '*.t'],
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslateKeyState', nsArg: 0, keyPrefixArg: -1 },
        ],
      },
    }

    const results = await extract(config)
    const authFile = results.find(r => pathEndsWith(r.path, '/locales/en/auth.json'))

    expect(authFile).toBeDefined()
    expect(authFile!.newTranslations).toEqual({
      loginForm: {
        input: {
          email: {
            required: 'Email is required',
          },
        },
      },
    })
  })

  it('propagates namespace through a deeper member-expression chain (e.g. `wrapper.i18n.t(...)`)', async () => {
    // When a custom hook returns a nested shape like `{ i18n: { t } }`, the
    // scope attached to the outer variable must still propagate to the inner
    // `t` call even though neither the full callee nor the immediate object
    // is the scoped variable directly.
    const sampleCode = `
      const wrapper = useTranslateKeyState('auth')
      wrapper.i18n.t('loginForm.input.email.required', 'Email is required')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        functions: ['t', '*.t'],
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslateKeyState', nsArg: 0, keyPrefixArg: -1 },
        ],
      },
    }

    const results = await extract(config)
    const authFile = results.find(r => pathEndsWith(r.path, '/locales/en/auth.json'))

    expect(authFile).toBeDefined()
    expect(authFile!.newTranslations).toEqual({
      loginForm: {
        input: {
          email: {
            required: 'Email is required',
          },
        },
      },
    })
  })

  it('does not treat arbitrary method calls on a scoped i18n object as translation calls', async () => {
    // Only callees that match one of the configured `functions` patterns
    // (here: `t` and `*.t`) are translation calls. A method call such as
    // `i18n.language.substring(...)` or `i18n.languages.join(...)` on a
    // variable that happens to be in scope (via `useTranslation()`
    // destructuring) must not be extracted — its first literal argument is
    // not a translation key.
    const sampleCode = `
      const { i18n } = useTranslation()
      const lang = i18n.language.substring(0, 2)
      const key = i18n.languages.join('|')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        functions: ['t', '*.t'],
      },
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    // No t()/*.t() calls are present, so nothing should be extracted.
    expect(translationFile?.newTranslations ?? {}).toEqual({})
  })

  it('does not extract when keyPrefix is a template literal with expressions (current limitation)', async () => {
    const sampleCode = `
      const id = 'footer'
      const { t } = useTranslate(\`prefix-\${id}\`)
      t('title', 'Title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        useTranslationNames: [
          'useTranslation',
          { name: 'useTranslate', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    // Current behaviour: computed/template keyPrefix is not resolved -> key is extracted unprefixed
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      title: 'Title',
    })
  })
})
