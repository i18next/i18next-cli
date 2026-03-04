import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, ExtractedKey, Plugin } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const mockConfigBase: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{lng}}/{{ns}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('plugin onKeySubmitted hook', () => {
  beforeEach(async () => {
    vol.reset()
    vol.fromJSON({})
    ;(vol as any).releasedFds = []
    vi.clearAllMocks()
  })

  it('fires for every key submission including duplicates', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    const submitted: ExtractedKey[] = []
    const plugin: Plugin = {
      name: 'capture',
      onKeySubmitted (key) {
        submitted.push({ ...key })
      },
    }

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('shared.key', 'Value A')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('shared.key', 'Value B')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [plugin],
    }

    const { allKeys } = await findKeys(config)
    // The key was deduplicated in allKeys
    expect(allKeys.size).toBe(1)

    // But onKeySubmitted fired for BOTH submissions
    expect(submitted).toHaveLength(2)
    expect(submitted[0].key).toBe('shared.key')
    expect(submitted[1].key).toBe('shared.key')
  })

  it('receives fully-normalized snapshots', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const submitted: ExtractedKey[] = []
    const plugin: Plugin = {
      name: 'capture',
      onKeySubmitted (key) {
        submitted.push({ ...key })
      },
    }

    vol.fromJSON({
      'src/App.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('test.key', 'Default Value')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [plugin],
    }

    await findKeys(config)

    expect(submitted).toHaveLength(1)
    // ns is resolved to 'translation' (the defaultNS)
    expect(submitted[0].ns).toBe('translation')
    // defaultValue is guaranteed non-null
    expect(submitted[0].defaultValue).toBe('Default Value')
  })

  it('receives a frozen key (read-only)', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    let frozenKey: any
    const plugin: Plugin = {
      name: 'freeze-check',
      onKeySubmitted (key) {
        frozenKey = key
      },
    }

    vol.fromJSON({
      'src/App.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('frozen.key', 'Frozen')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [plugin],
    }

    await findKeys(config)

    expect(frozenKey).toBeDefined()
    expect(Object.isFrozen(frozenKey)).toBe(true)
  })

  it('does not break extraction when plugin throws', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const plugin: Plugin = {
      name: 'bad-plugin',
      onKeySubmitted () {
        throw new Error('plugin exploded')
      },
    }

    vol.fromJSON({
      'src/App.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('safe.key', 'Still works')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [plugin],
    }

    // Should not throw — the error is caught and logged
    const { allKeys } = await findKeys(config)
    expect(allKeys.size).toBe(1)
  })

  it('conflict detector example works end-to-end', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    const conflicts: Array<{ id: string; first: string; second: string }> = []
    const seen = new Map<string, ExtractedKey>()

    const conflictDetector: Plugin = {
      name: 'conflict-detector',
      onKeySubmitted (key) {
        const id = `${String(key.ns)}:${key.key}`
        const previous = seen.get(id)
        if (previous && previous.defaultValue !== key.defaultValue) {
          conflicts.push({
            id,
            first: previous.defaultValue!,
            second: key.defaultValue!,
          })
        }
        seen.set(id, { ...key })
      },
    }

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('btn.label', 'Save')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('btn.label', 'Submit')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [conflictDetector],
    }

    await findKeys(config)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].id).toBe('translation:btn.label')
    expect(conflicts[0].first).toBe('Save')
    expect(conflicts[0].second).toBe('Submit')
  })
})

describe('extract.warnOnConflicts', () => {
  beforeEach(async () => {
    vol.reset()
    vol.fromJSON({})
    ;(vol as any).releasedFds = []
    vi.clearAllMocks()
  })

  it('logs a warning when warnOnConflicts is true', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('dup.key', 'First value')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('dup.key', 'Second value')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      extract: {
        ...mockConfigBase.extract,
        warnOnConflicts: true,
      },
    }

    // Should not throw — just warn
    const { allKeys } = await findKeys(config)
    expect(allKeys.size).toBe(1)
  })

  it('throws when warnOnConflicts is "error"', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('dup.key', 'First value')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('dup.key', 'Second value')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      extract: {
        ...mockConfigBase.extract,
        warnOnConflicts: 'error',
      },
    }

    await expect(findKeys(config)).rejects.toThrow(/conflicting default values/)
  })

  it('does not warn when same key has same default value', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('same.key', 'Same value')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('same.key', 'Same value')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      extract: {
        ...mockConfigBase.extract,
        warnOnConflicts: 'error',
      },
    }

    // Should not throw because the default values are identical
    const { allKeys } = await findKeys(config)
    expect(allKeys.size).toBe(1)
  })

  it('does not warn when generic fallback is overridden by specific value', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/A.tsx', 'src/B.tsx'])

    vol.fromJSON({
      'src/A.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('my.key')
      `,
      'src/B.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('my.key', 'Save')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      extract: {
        ...mockConfigBase.extract,
        warnOnConflicts: 'error',
      },
    }

    // Should not throw — generic fallback (key as defaultValue) overridden
    // by a specific value is the normal dedup path, not a conflict.
    const { allKeys } = await findKeys(config)
    expect(allKeys.size).toBe(1)
    expect(allKeys.get('translation:my.key')?.defaultValue).toBe('Save')
  })
})
