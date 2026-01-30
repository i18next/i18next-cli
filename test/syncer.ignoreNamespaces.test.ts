import { vol } from 'memfs'
import { resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { I18nextToolkitConfig } from '../src/index'
import { runSyncer } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
}

describe('syncer: ignoreNamespaces', () => {
  const enLocalPath = resolve(process.cwd(), 'locales/en/translation.json')
  const deLocalPath = resolve(process.cwd(), 'locales/de/translation.json')
  const enSharedPath = resolve(process.cwd(), 'locales/en/shared.json')
  const deSharedPath = resolve(process.cwd(), 'locales/de/shared.json')
  const enCommonPath = resolve(process.cwd(), 'locales/en/common.json')
  const deCommonPath = resolve(process.cwd(), 'locales/de/common.json')

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Setup the glob mock to find the primary language files
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
      // Return all English locale files that exist in memfs
      return Object.keys(vol.toJSON()).filter(p => p.includes('/locales/en/'))
    })
  })

  it('should skip syncing ignored namespaces', async () => {
    const enLocalTranslations = { local: { key: 'Local Value' } }
    const enSharedTranslations = { shared: { key: 'Shared Value' } }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
      // de/translation.json is missing
      // de/shared.json is missing
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    await runSyncer(config)

    // Local namespace should be synced
    expect(vol.existsSync(deLocalPath)).toBe(true)
    const deLocalContent = await vol.promises.readFile(deLocalPath, 'utf-8')
    const deLocalJson = JSON.parse(deLocalContent as string)
    expect(deLocalJson).toEqual({ local: { key: '' } })

    // Shared namespace should NOT be synced (file should not be created)
    expect(vol.existsSync(deSharedPath)).toBe(false)
  })

  it('should skip multiple ignored namespaces during sync', async () => {
    const enLocalTranslations = { local: { key: 'Local Value' } }
    const enSharedTranslations = { shared: { key: 'Shared Value' } }
    const enCommonTranslations = { common: { key: 'Common Value' } }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
      [enCommonPath]: JSON.stringify(enCommonTranslations),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared', 'common'],
      },
    }

    await runSyncer(config)

    // Local namespace should be synced
    expect(vol.existsSync(deLocalPath)).toBe(true)

    // Shared and common namespaces should NOT be synced
    expect(vol.existsSync(deSharedPath)).toBe(false)
    expect(vol.existsSync(deCommonPath)).toBe(false)
  })

  it('should not modify existing ignored namespace files', async () => {
    const enLocalTranslations = { local: { key: 'Local Value' } }
    const enSharedTranslations = { shared: { key: 'Shared Value', newKey: 'New Value' } }
    const existingDeSharedTranslations = { shared: { key: 'Geteilter Wert' } }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
      [deSharedPath]: JSON.stringify(existingDeSharedTranslations),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    await runSyncer(config)

    // Shared namespace file should remain unchanged (newKey should NOT be added)
    const deSharedContent = await vol.promises.readFile(deSharedPath, 'utf-8')
    const deSharedJson = JSON.parse(deSharedContent as string)
    expect(deSharedJson).toEqual(existingDeSharedTranslations)
  })

  it('should sync all namespaces when ignoreNamespaces is empty', async () => {
    const enLocalTranslations = { local: { key: 'Local Value' } }
    const enSharedTranslations = { shared: { key: 'Shared Value' } }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: [],
      },
    }

    await runSyncer(config)

    // Both namespaces should be synced
    expect(vol.existsSync(deLocalPath)).toBe(true)
    expect(vol.existsSync(deSharedPath)).toBe(true)
  })

  it('should sync all namespaces when ignoreNamespaces is not specified', async () => {
    const enLocalTranslations = { local: { key: 'Local Value' } }
    const enSharedTranslations = { shared: { key: 'Shared Value' } }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
    })

    await runSyncer(mockConfig)

    // Both namespaces should be synced
    expect(vol.existsSync(deLocalPath)).toBe(true)
    expect(vol.existsSync(deSharedPath)).toBe(true)
  })

  it('should preserve existing translations in non-ignored namespaces while ignoring others', async () => {
    const enLocalTranslations = {
      local: { key1: 'Value 1', key2: 'Value 2' },
    }
    const enSharedTranslations = {
      shared: { key1: 'Shared 1' },
    }
    const existingDeLocalTranslations = {
      local: { key1: 'Wert 1' }, // key2 is missing
    }

    vol.fromJSON({
      [enLocalPath]: JSON.stringify(enLocalTranslations),
      [enSharedPath]: JSON.stringify(enSharedTranslations),
      [deLocalPath]: JSON.stringify(existingDeLocalTranslations),
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        ignoreNamespaces: ['shared'],
      },
    }

    await runSyncer(config)

    // Local namespace should be synced, preserving existing and adding missing
    const deLocalContent = await vol.promises.readFile(deLocalPath, 'utf-8')
    const deLocalJson = JSON.parse(deLocalContent as string)
    expect(deLocalJson).toEqual({
      local: { key1: 'Wert 1', key2: '' },
    })

    // Shared namespace should NOT be synced
    expect(vol.existsSync(deSharedPath)).toBe(false)
  })
})
