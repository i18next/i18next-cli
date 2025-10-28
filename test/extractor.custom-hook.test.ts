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
