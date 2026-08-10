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

// Import runUnusedReport AFTER mocks so internal modules use the mocked fs/glob
const { runUnusedReport } = await import('../src/index')

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
}

describe('status --unused', () => {
  let consoleLogSpy: any
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
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

  const getAllLogs = () => consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')

  it('reports only unused keys, exits 1 and never modifies files', async () => {
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enContent = JSON.stringify({ used_key: 'Used', unused_key: 'Unused' })
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('used_key')
        t('missing_key')
      `,
      [enPath]: enContent,
    })

    await expect(runUnusedReport(mockConfig)).rejects.toThrow('Process exit called')
    expect(processExitSpy).toHaveBeenCalledWith(1)

    const logs = getAllLogs()
    expect(logs).toContain('unused_key')
    // The missing key must not be reported — it is not "unused"
    expect(logs).not.toContain('missing_key')
    expect(logs).toContain('Found 1 unused key(s)')

    // Read-only: the translation file must be untouched. Read it back through
    // memfs instead of vol.toJSON() — on Windows the resolved path (backslashes)
    // doesn't match the normalized toJSON() keys.
    expect(vol.readFileSync(enPath, 'utf-8')).toBe(enContent)
  })

  it('exits cleanly when there are no unused keys, even with missing translations', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('used_key')
        t('missing_key')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ used_key: 'Used' }),
    })

    await runUnusedReport(mockConfig)

    expect(processExitSpy).not.toHaveBeenCalled()
    expect(getAllLogs()).toContain('No unused keys found')
  })

  it('filters the report by locale', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('used_key')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ used_key: 'Used', unused_key: 'Unused' }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ used_key: 'Benutzt', unused_key: 'Unbenutzt' }),
    })

    await expect(runUnusedReport(mockConfig, { locale: 'en' })).rejects.toThrow('Process exit called')

    const logs = getAllLogs()
    expect(logs).toContain('[en/translation]')
    expect(logs).not.toContain('[de/translation]')
    expect(logs).toContain('Found 1 unused key(s) for "en"')
  })

  it('reports unused keys even when removeUnusedKeys is false in the config', async () => {
    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: { ...mockConfig.extract, removeUnusedKeys: false },
    }
    vol.fromJSON({
      [resolve(process.cwd(), 'src/app.ts')]: `
        import { t } from 'i18next'
        t('used_key')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ used_key: 'Used', unused_key: 'Unused' }),
    })

    await expect(runUnusedReport(config)).rejects.toThrow('Process exit called')
    expect(getAllLogs()).toContain('unused_key')
    // The caller's config must not be mutated by the forced removeUnusedKeys
    expect(config.extract.removeUnusedKeys).toBe(false)
  })

  it('errors on a locale that is not configured', async () => {
    await expect(runUnusedReport(mockConfig, { locale: 'xx' })).rejects.toThrow('Process exit called')
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })
})
