import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

// Mock filesystem used by extractor (both sync and promises layers)
vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock glob so extractor only scans test files we create in memfs
vi.mock('glob', () => ({ glob: vi.fn() }))

// Import runStatus AFTER mocks so internal modules use the mocked fs/glob
const { runStatus } = await import('../src/index')

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
}

describe('status: ignoreNamespaces', () => {
  let consoleLogSpy: any
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    // provide deterministic glob results: return only files we create in this test's memfs
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
      // Return any memfs path that contains a /src/ segment
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should exclude ignored namespaces from status report', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        t('local.key1')
        t('local.key2')
        tShared('shared.key1')
        tShared('shared.key2')
      `,
      // Only local namespace translations exist
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        local: { key1: 'Schlüssel 1', key2: 'Schlüssel 2' },
      }),
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        local: { key1: 'Clé 1' },
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    try {
      await runStatus(config)
    } catch (e) {
      // Expected to throw when process.exit is called
      expect(processExitSpy).toHaveBeenCalled()
    }

    // Should only report 2 keys (from local namespace), not 4
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    // Should only report 1 namespace (translation, not shared)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   1'))
    // de should be 100% (2/2)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2'))
    // fr should be 50% (1/2)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('50% (1/2'))
  })

  it('should ignore multiple namespaces in status report', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        const { t: tCommon } = useTranslation('common')
        t('local.key1')
        tShared('shared.key1')
        tCommon('common.key1')
      `,
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        local: { key1: 'Schlüssel 1' },
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared', 'common'],
      },
    }

    try {
      await runStatus(config)
    } catch (e) {
      // Expected to throw when process.exit is called
    }

    // Should only report 1 key (from local namespace)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         1'))
    // Should report 1 namespace (translation only)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   1'))
    // de should be 100% (1/1)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (1/1'))
  })

  it('should report all namespaces when ignoreNamespaces is empty', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        t('local.key1')
        tShared('shared.key1')
      `,
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        local: { key1: 'Schlüssel 1' },
      }),
      [resolve(process.cwd(), 'locales/de/shared.json')]: JSON.stringify({
        shared: { key1: 'Geteilt 1' },
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: [],
      },
    }

    try {
      await runStatus(config)
    } catch (e) {
      // Expected to throw when process.exit is called
    }

    // Should report 2 keys total
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   2'))
  })

  it('should report all namespaces when ignoreNamespaces is not specified', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        t('local.key1')
        tShared('shared.key1')
      `,
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        local: { key1: 'Schlüssel 1' },
      }),
      [resolve(process.cwd(), 'locales/de/shared.json')]: JSON.stringify({
        shared: { key1: 'Geteilt 1' },
      }),
    })

    try {
      await runStatus(mockConfig)
    } catch (e) {
      // Expected to throw when process.exit is called
    }

    // Should report 2 keys total (no filtering)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('📚 Namespaces Found:   2'))
  })

  it('should correctly calculate overall completion when ignoring namespaces', async () => {
    // Scenario: 3 namespaces, 2 ignored
    // Only local namespace with 2 keys should be considered
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        const { t: tLib } = useTranslation('lib')
        t('local.key1')
        t('local.key2')
        tShared('shared.key1')
        tShared('shared.key2')
        tShared('shared.key3')
        tLib('lib.key1')
      `,
      // All local keys translated in de
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        local: { key1: 'Schlüssel 1', key2: 'Schlüssel 2' },
      }),
      // All local keys translated in fr
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        local: { key1: 'Clé 1', key2: 'Clé 2' },
      }),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared', 'lib'],
      },
    }

    try {
      await runStatus(config)
    } catch (e) {
      // Expected to throw when process.exit is called
    }

    // Should only count 2 keys from local namespace
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    // Both de and fr should be 100% (2/2)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2'))
  })
})
