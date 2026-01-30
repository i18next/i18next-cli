import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
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

describe('extractor: ignoreNamespaces', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Mock the current working directory to align with the virtual file system's root.
    vi.spyOn(process, 'cwd').mockReturnValue('/')

    // Dynamically import the mocked glob after mocks are set up
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
      // Return any files that exist in memfs under /src/
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
  })

  it('should not extract keys from ignored namespaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        const { t: tShared } = useTranslation('shared');
        return (
          <div>
            <h1>{t('local.title')}</h1>
            <p>{tShared('shared.message')}</p>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    await runExtractor(config)

    const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')

    // Local namespace should be created with keys
    const enLocalContent = await vol.promises.readFile(enLocalPath, 'utf-8')
    const enLocalJson = JSON.parse(enLocalContent as string)
    expect(enLocalJson).toHaveProperty('local.title')

    // Shared namespace should NOT be created
    expect(vol.existsSync(enSharedPath)).toBe(false)
  })

  it('should not extract keys with explicit namespace prefix when namespace is ignored', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        return (
          <div>
            <h1>{t('local.title')}</h1>
            <p>{t('common:shared.button')}</p>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['common'],
      },
    }

    await runExtractor(config)

    const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enCommonPath = resolve(process.cwd(), 'locales/en/common.json')

    // Local namespace should be created with local.title
    const enLocalContent = await vol.promises.readFile(enLocalPath, 'utf-8')
    const enLocalJson = JSON.parse(enLocalContent as string)
    expect(enLocalJson).toHaveProperty('local.title')

    // Common namespace should NOT be created
    expect(vol.existsSync(enCommonPath)).toBe(false)
  })

  it('should ignore multiple namespaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        const { t: tShared } = useTranslation('shared');
        const { t: tCommon } = useTranslation('common');
        return (
          <div>
            <h1>{t('app.title')}</h1>
            <p>{tShared('shared.message')}</p>
            <button>{tCommon('common.save')}</button>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared', 'common'],
      },
    }

    await runExtractor(config)

    const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')
    const enCommonPath = resolve(process.cwd(), 'locales/en/common.json')

    // Local namespace should be created with app.title
    const enLocalContent = await vol.promises.readFile(enLocalPath, 'utf-8')
    const enLocalJson = JSON.parse(enLocalContent as string)
    expect(enLocalJson).toHaveProperty('app.title')

    // Shared and common namespaces should NOT be created
    expect(vol.existsSync(enSharedPath)).toBe(false)
    expect(vol.existsSync(enCommonPath)).toBe(false)
  })

  it('should extract all namespaces when ignoreNamespaces is empty', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        const { t: tShared } = useTranslation('shared');
        return (
          <div>
            <h1>{t('local.title')}</h1>
            <p>{tShared('shared.message')}</p>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: [],
      },
    }

    await runExtractor(config)

    const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')

    // Both namespaces should be created
    expect(vol.existsSync(enLocalPath)).toBe(true)
    expect(vol.existsSync(enSharedPath)).toBe(true)
  })

  it('should extract all namespaces when ignoreNamespaces is not specified', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        const { t: tShared } = useTranslation('shared');
        return (
          <div>
            <h1>{t('local.title')}</h1>
            <p>{tShared('shared.message')}</p>
          </div>
        );
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await runExtractor(mockConfig)

    const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')

    // Both namespaces should be created
    expect(vol.existsSync(enLocalPath)).toBe(true)
    expect(vol.existsSync(enSharedPath)).toBe(true)
  })

  it('should not modify existing files for ignored namespaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        const { t: tShared } = useTranslation('shared');
        return (
          <div>
            <h1>{t('local.newKey')}</h1>
            <p>{tShared('shared.newKey')}</p>
          </div>
        );
      }
    `

    const existingSharedContent = { existing: { key: 'value' } }

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      '/locales/en/shared.json': JSON.stringify(existingSharedContent),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    await runExtractor(config)

    const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')

    // Shared namespace file should remain unchanged
    const enSharedContent = await vol.promises.readFile(enSharedPath, 'utf-8')
    const enSharedJson = JSON.parse(enSharedContent as string)
    expect(enSharedJson).toEqual(existingSharedContent)
  })
})
