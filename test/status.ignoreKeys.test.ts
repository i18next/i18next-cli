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

describe('status: ignoreKeys (#284)', () => {
  let consoleLogSpy: any
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => Object.keys(vol.toJSON()).filter(p => p.includes('/src/')))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should exclude keys matching status.ignoreKeys globs (with optional ns: prefix)', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        const { t: tShared } = useTranslation('shared')
        t('help.article-href')
        t('empty-table-subtitle')
        t('real.key')
        tShared('help.other-href')
        tShared('empty-table-subtitle')
      `,
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ real: { key: 'x' } }),
      [resolve(process.cwd(), 'locales/de/shared.json')]: JSON.stringify({}),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      locales: ['en', 'de'],
      status: { ignoreKeys: ['*-href', 'translation:empty-table-subtitle'] },
    }

    try {
      await runStatus(config)
    } catch (e) {
      expect(processExitSpy).toHaveBeenCalled()
    }

    // translation: real.key only; shared: empty-table-subtitle only (ns-scoped pattern does not apply there)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('50% (1/2'))
  })

  it('should not exit non-zero when every missing key is ignored', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('help.article-href')
        t('real.key')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ real: { key: 'x' } }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ real: { key: 'x' } }),
    })

    const config: I18nextToolkitConfig = { ...mockConfig, locales: ['en', 'de'], status: { ignoreKeys: ['*-href'] } }
    await runStatus(config)
    expect(processExitSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (1/1'))
  })
})
