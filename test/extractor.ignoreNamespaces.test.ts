import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import { ignoredNamespaceMatcher } from '../src/utils/file-utils'
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

  it('should not clear ignored namespace files when removeUnusedKeys is true (#171)', async () => {
    // Regression: when removeUnusedKeys is true the extractor discovers
    // existing namespace files via glob and rebuilds them from scratch.
    // Ignored namespaces must be skipped entirely so their files are
    // never emptied.
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        return (
          <div>
            <h1>{t('hello')}</h1>
            <p>{t('ns2:key')}</p>
          </div>
        );
      }
    `

    const existingNs2Content = { key: 'value' }

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      '/locales/en/ns2.json': JSON.stringify(existingNs2Content),
      '/locales/de/ns2.json': JSON.stringify(existingNs2Content),
    })

    // Override glob to also return existing locale files so the
    // extractor discovers them (simulating real file-system glob).
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      const allFiles = Object.keys(vol.toJSON())
      const pat = Array.isArray(pattern) ? pattern.join(',') : String(pattern)
      if (pat.includes('src/')) {
        return allFiles.filter(p => p.includes('/src/'))
      }
      // For namespace-discovery glob, return matching locale files
      return allFiles.filter(p => p.startsWith('/locales/'))
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        defaultNS: 'ns1',
        ignoreNamespaces: ['ns2'],
        removeUnusedKeys: true,
      },
    }

    await runExtractor(config)

    // ns2.json must be completely untouched
    const enNs2Path = resolve(process.cwd(), 'locales/en/ns2.json')
    const deNs2Path = resolve(process.cwd(), 'locales/de/ns2.json')

    const enNs2Content = await vol.promises.readFile(enNs2Path, 'utf-8')
    expect(JSON.parse(enNs2Content as string)).toEqual(existingNs2Content)

    const deNs2Content = await vol.promises.readFile(deNs2Path, 'utf-8')
    expect(JSON.parse(deNs2Content as string)).toEqual(existingNs2Content)

    // ns1 should still be created with the 'hello' key
    const enNs1Path = resolve(process.cwd(), 'locales/en/ns1.json')
    const enNs1Content = await vol.promises.readFile(enNs1Path, 'utf-8')
    const enNs1Json = JSON.parse(enNs1Content as string)
    expect(enNs1Json).toHaveProperty('hello')
  })

  it('should match ignoreNamespaces glob patterns (#325)', async () => {
    const isIgnored = ignoredNamespaceMatcher({ extract: { ...mockConfig.extract, ignoreNamespaces: ['dev.*', 'mocks'] } })
    expect(['dev.tools', 'dev.a.b', 'mocks'].filter(isIgnored)).toEqual(['dev.tools', 'dev.a.b', 'mocks'])
    expect(['dev', 'devtools', 'app.dev.x', 'mocks2'].some(isIgnored)).toBe(false)
  })

  it('should not touch files of namespaces matching an ignoreNamespaces glob (#325)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation(['app.home', 'dev.mocks', 'devtools']);
        return <p>{t('app.home:title')}{t('dev.mocks:fake')}{t('devtools:panel')}</p>;
      }
    `
    const existingDevTools = { key: 'value' }
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      '/locales/en/dev.tools.json': JSON.stringify(existingDevTools),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      const allFiles = Object.keys(vol.toJSON())
      return String(pattern).includes('src/') ? allFiles.filter(p => p.includes('/src/')) : allFiles.filter(p => p.startsWith('/locales/'))
    })

    await runExtractor({
      ...mockConfig,
      extract: { ...mockConfig.extract, ignoreNamespaces: ['dev.*'], removeUnusedKeys: true },
    })

    const files = vol.toJSON()
    expect(JSON.parse(files['/locales/en/dev.tools.json'] as string)).toEqual(existingDevTools)
    expect(files['/locales/en/dev.mocks.json']).toBeUndefined()
    expect(JSON.parse(files['/locales/en/app.home.json'] as string)).toHaveProperty('title')
    expect(JSON.parse(files['/locales/en/devtools.json'] as string)).toHaveProperty('panel')
  })

  it('should keep sections matching an ignoreNamespaces glob in a merged file (#325)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation(['app.home', 'dev.mocks']);
        return <p>{t('app.home:title')}{t('dev.mocks:fake')}</p>;
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      '/locales/en.json': JSON.stringify({ 'dev.tools': { key: 'value' }, 'app.home': { old: 'gone' } }),
    })

    await runExtractor({
      ...mockConfig,
      extract: { ...mockConfig.extract, output: 'locales/{{language}}.json', mergeNamespaces: true, ignoreNamespaces: ['dev.*'], removeUnusedKeys: true },
    })

    const merged = JSON.parse(vol.toJSON()['/locales/en.json'] as string)
    expect(merged['dev.tools']).toEqual({ key: 'value' })
    expect(Object.keys(merged).sort()).toEqual(['app.home', 'dev.tools'])
    expect(Object.keys(merged['app.home'])).toEqual(['title'])
  })
})
