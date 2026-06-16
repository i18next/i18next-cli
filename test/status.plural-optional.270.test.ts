import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

/**
 * Issue #270: `status` reported optional CLDR plural categories (e.g. French
 * `_many`, only selected for counts ≥ 1,000,000) as hard "missing" errors, and
 * with `disablePlurals: true` it flagged the bare base key as missing even when
 * the locale's `_one`/`_other` variants existed.
 *
 * The fix aligns `status` with the i18next runtime:
 *  - Optional categories (unreachable by typical counts) are soft notes, never
 *    failures — whether absent or an empty placeholder.
 *  - A count-driven key is satisfied by its plural variants OR the bare key
 *    (the runtime's resolution chain), so `disablePlurals` no longer produces
 *    false positives.
 */

vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const { runStatus } = await import('../src/index')

function makeConfig (overrides: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig {
  return {
    locales: ['en', 'fr'],
    extract: {
      input: ['src/**/*.{ts,tsx}'],
      output: 'locales/{{language}}/{{namespace}}.json',
      primaryLanguage: 'en',
      secondaryLanguages: ['fr'],
      ...overrides,
    },
  }
}

describe('status optional plural categories (#270)', () => {
  let consoleLogs: string[]
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () =>
      Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    )
    consoleLogs = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { consoleLogs.push(String(msg)) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Case A — plurals enabled --------------------------------------------------

  it('does not fail when only an optional category (French _many) is absent', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('items', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        items_one: '{{count}} item', items_other: '{{count}} items',
      }),
      // fr has the required forms; _many is absent (and never displayed for normal counts)
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        items_one: '{{count}} article', items_other: '{{count}} articles',
      }),
    })

    try { await runStatus(makeConfig()) } catch { /* process.exit throws */ }

    // No failure — fr is fully translated for the required categories.
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('surfaces an absent optional category as a soft note in the detailed report', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('items', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        items_one: '{{count}} item', items_other: '{{count}} items',
      }),
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        items_one: '{{count}} article', items_other: '{{count}} articles',
      }),
    })

    try { await runStatus(makeConfig(), { detail: 'fr' }) } catch { /* noop */ }

    const out = consoleLogs.join('\n')
    expect(out).toMatch(/items_many/)
    expect(out).toMatch(/optional plural form/)
    expect(out).not.toMatch(/items_many.*absent/)
  })

  it('still fails when a REQUIRED plural form is missing', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('items', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        items_one: '{{count}} item', items_other: '{{count}} items',
      }),
      // fr is missing the required `_other` form entirely.
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        items_one: '{{count}} article',
      }),
    })

    try { await runStatus(makeConfig()) } catch { /* process.exit throws */ }

    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  // Case B — disablePlurals ---------------------------------------------------

  it('disablePlurals: a count key is satisfied by its _one/_other variants (not the bare key)', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('ownerAlert.title', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        ownerAlert: { title_one: 'one', title_other: 'other' },
      }),
      // Reporter's exact setup: only plural variants exist, no bare `title`.
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        ownerAlert: { title_one: 'un', title_other: 'plusieurs' },
      }),
    })

    try { await runStatus(makeConfig({ disablePlurals: true })) } catch { /* noop */ }

    // The bare `ownerAlert.title` must NOT be reported as missing.
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('disablePlurals: a count key is satisfied by the bare key alone (single-other convention)', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('ownerAlert.title', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        ownerAlert: { title: 'bare' },
      }),
      // Only the bare key exists (the convention `extract` writes under disablePlurals).
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({
        ownerAlert: { title: 'nu' },
      }),
    })

    try { await runStatus(makeConfig({ disablePlurals: true })) } catch { /* noop */ }

    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('disablePlurals: still fails when neither the bare key nor any variant exists', async () => {
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import { useTranslation } from 'react-i18next'
        export function App () {
          const { t } = useTranslation()
          return t('ownerAlert.title', { count: 5 })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        ownerAlert: { title_one: 'one', title_other: 'other' },
      }),
      // fr is genuinely missing the key in every form.
      [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({}),
    })

    try { await runStatus(makeConfig({ disablePlurals: true })) } catch { /* process.exit throws */ }

    expect(processExitSpy).toHaveBeenCalledWith(1)
  })
})
