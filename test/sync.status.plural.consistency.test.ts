import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

/**
 * Bug reproduction tests for:
 * https://github.com/your-org/i18next-cli/issues/XXX
 *
 * Issue: `sync` and `status` are inconsistent when the primary locale has
 * fewer plural categories than a secondary locale.
 *
 * Root cause: The syncer only iterates over keys present in the *primary*
 * locale file. If a secondary locale (fr, es) legally needs a plural form
 * that the primary language (en) doesn't use (e.g. `_many`), the syncer
 * silently drops that key from the secondary file. Immediately after, `status`
 * validates each locale against its own CLDR plural categories and reports
 * those same keys as missing — even though `sync` was the one that removed them.
 */

// ---------------------------------------------------------------------------
// Mock filesystem and glob (same pattern as status_test.ts)
// ---------------------------------------------------------------------------

vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// Import after mocks are registered
const { runStatus } = await import('../src/index')
const { runSyncer } = await import('../src/syncer')

// ---------------------------------------------------------------------------
// Helper: build the config used throughout these tests
// ---------------------------------------------------------------------------

function makeConfig (overrides: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig {
  return {
    locales: ['en', 'fr', 'es'],
    extract: {
      input: ['src/**/*.{ts,tsx}'],
      output: 'locales/{{language}}/{{namespace}}.json',
      primaryLanguage: 'en',
      secondaryLanguages: ['fr', 'es'],
      defaultNS: 'common',
      keySeparator: '.',
      sort: true,
      indentation: 2,
      removeUnusedKeys: true,
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// Shared locale fixtures matching the bug report exactly
// ---------------------------------------------------------------------------

/** Primary locale (en) — only has `_one` and `_other` */
const EN_TRANSLATIONS = {
  detail: {
    comments: {
      title_one: '{{count}} Comment',
      title_other: '{{count}} Comments',
    },
  },
}

/**
 * French locale *before* sync — has the locale-required `_many` form.
 * French CLDR plural categories: one, many, other.
 */
const FR_TRANSLATIONS_BEFORE_SYNC = {
  detail: {
    comments: {
      title_one: '{{count}} commentaire',
      title_many: '{{count}} commentaires',
      title_other: '{{count}} commentaires',
    },
  },
}

/**
 * Spanish locale *before* sync — has the locale-required `_many` form.
 * Spanish CLDR plural categories: one, many, other.
 */
const ES_TRANSLATIONS_BEFORE_SYNC = {
  detail: {
    comments: {
      title_one: '{{count}} comentario',
      title_many: '{{count}} comentarios',
      title_other: '{{count}} comentarios',
    },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync + status plural consistency (bug report reproduction)', () => {
  // let consoleLogSpy: ReturnType<typeof vi.spyOn>
  // let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      // The syncer uses glob to discover primary-language namespace files.
      // Return any memfs path that matches the primary locale directory.
      return Object.keys(vol.toJSON()).filter(p => p.includes('/en/'))
    })

    // consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Test 1 — FIX: syncer now preserves locale-specific plural forms
  // -------------------------------------------------------------------------

  it('FIX: syncer preserves locale-required plural forms not present in primary locale', async () => {
    const config = makeConfig()

    // Set up the in-memory filesystem with pre-sync locale files
    vol.fromJSON({
      // Source file with a pluralized translation call
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: `
        import { useTranslation } from 'react-i18next';
        export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
          const { t } = useTranslation('common');
          return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
        };
      `,

      // Primary locale (en) — only two plural forms (one, other)
      [resolve(process.cwd(), 'locales/en/common.json')]:
        JSON.stringify(EN_TRANSLATIONS, null, 2),

      // French — includes `title_many` which is required by French CLDR rules
      // (French cardinal categories: one, many, other)
      [resolve(process.cwd(), 'locales/fr/common.json')]:
        JSON.stringify(FR_TRANSLATIONS_BEFORE_SYNC, null, 2),

      // Spanish — includes `title_many` which is required by Spanish CLDR rules
      // (Spanish cardinal categories: one, many, other)
      [resolve(process.cwd(), 'locales/es/common.json')]:
        JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    // Run the syncer (equivalent to `i18next-cli sync`)
    await runSyncer(config, { quiet: true })

    // Read the post-sync locale files
    const frRaw = vol.toJSON()[resolve(process.cwd(), 'locales/fr/common.json')]
    const esRaw = vol.toJSON()[resolve(process.cwd(), 'locales/es/common.json')]

    expect(frRaw).toBeDefined()
    expect(esRaw).toBeDefined()

    const frAfterSync = JSON.parse(frRaw!)
    const esAfterSync = JSON.parse(esRaw!)

    // FIX: `title_many` must survive sync even though it is absent from the
    // primary (en) locale — it is a valid CLDR plural category for fr and es.
    expect(frAfterSync?.detail?.comments?.title_many).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_many).toBe('{{count}} comentarios')

    // Keys that come from the primary locale must also still be present
    expect(frAfterSync?.detail?.comments?.title_one).toBe('{{count}} commentaire')
    expect(frAfterSync?.detail?.comments?.title_other).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_one).toBe('{{count}} comentario')
    expect(esAfterSync?.detail?.comments?.title_other).toBe('{{count}} comentarios')
  })

  // -------------------------------------------------------------------------
  // Test 2 — status reports missing after sync (the full repro from the issue)
  // -------------------------------------------------------------------------

  it('BUG: status reports missing translations immediately after sync, for keys sync itself cleared', async () => {
    const config = makeConfig()

    // Simulate the state *after* sync has already run: `title_many` is gone
    // from fr and es (replaced with empty string, as the bug report shows).
    const frAfterSync = {
      detail: {
        comments: {
          title_one: '{{count}} commentaire',
          title_many: '',    // ← syncer overwrote the real translation
          title_other: '{{count}} commentaires',
        },
      },
    }
    const esAfterSync = {
      detail: {
        comments: {
          title_one: '{{count}} comentario',
          title_many: '',    // ← syncer overwrote the real translation
          title_other: '{{count}} comentarios',
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: `
        import { useTranslation } from 'react-i18next';
        export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
          const { t } = useTranslation('common');
          return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
        };
      `,
      [resolve(process.cwd(), 'locales/en/common.json')]:
        JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]:
        JSON.stringify(frAfterSync, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]:
        JSON.stringify(esAfterSync, null, 2),
    })

    // status re-uses glob to find source files for key extraction
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })

    // Run status (equivalent to `i18next-cli status`)
    try {
      await runStatus(config)
    } catch {
      // process.exit throws in tests
    }

    // status should call process.exit(1) because `title_many` is empty/missing
    // in fr and es — even though sync was responsible for clearing those values.
    expect(processExitSpy).toHaveBeenCalledWith(1) // BUG CONFIRMED: status exits with error
  })

  // -------------------------------------------------------------------------
  // Test 3 — Full end-to-end: extract → sync → status should succeed (FAILS)
  // -------------------------------------------------------------------------

  it('BUG: running sync then status should not fail when secondary locale has more plural forms than primary', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: `
        import { useTranslation } from 'react-i18next';
        export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
          const { t } = useTranslation('common');
          return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
        };
      `,
      [resolve(process.cwd(), 'locales/en/common.json')]:
        JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]:
        JSON.stringify(FR_TRANSLATIONS_BEFORE_SYNC, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]:
        JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    // Step 1: sync
    await runSyncer(config, { quiet: true })

    // Step 2: status — re-point glob to source files for key extraction
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })

    try {
      await runStatus(config)
    } catch {
      // process.exit throws in tests
    }

    // EXPECTED (after a fix): status should NOT exit with code 1.
    // Currently this assertion FAILS, confirming the bug is real.
    expect(processExitSpy).not.toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // Test 4 — Verify the fix: syncer should preserve locale-specific plural forms
  // -------------------------------------------------------------------------

  it('EXPECTED FIX: syncer should preserve locale-required plural forms not in primary locale', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: `
        import { useTranslation } from 'react-i18next';
        export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
          const { t } = useTranslation('common');
          return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
        };
      `,
      [resolve(process.cwd(), 'locales/en/common.json')]:
        JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]:
        JSON.stringify(FR_TRANSLATIONS_BEFORE_SYNC, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]:
        JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frRaw = vol.toJSON()[resolve(process.cwd(), 'locales/fr/common.json')]
    const esRaw = vol.toJSON()[resolve(process.cwd(), 'locales/es/common.json')]

    const frAfterSync = JSON.parse(frRaw!)
    const esAfterSync = JSON.parse(esRaw!)

    // After a fix, `title_many` should still contain the translator's value —
    // the syncer must not remove or blank out plural forms that are valid for
    // the secondary locale even when the primary locale doesn't use them.
    expect(frAfterSync?.detail?.comments?.title_many).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_many).toBe('{{count}} comentarios')

    // Other keys should be unaffected
    expect(frAfterSync?.detail?.comments?.title_one).toBe('{{count}} commentaire')
    expect(frAfterSync?.detail?.comments?.title_other).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_one).toBe('{{count}} comentario')
    expect(esAfterSync?.detail?.comments?.title_other).toBe('{{count}} comentarios')
  })

  // -------------------------------------------------------------------------
  // Test 5 — Regression: syncer should still remove keys genuinely absent
  //           from primary (not plurals, just obsolete keys)
  // -------------------------------------------------------------------------

  it('syncer should still remove genuinely obsolete keys from secondary locales', async () => {
    const config = makeConfig()

    // fr has an obsolete key `detail.comments.subtitle` that no longer exists
    // in the primary locale. It should be removed by sync.
    const frWithObsoleteKey = {
      detail: {
        comments: {
          title_one: '{{count}} commentaire',
          title_many: '{{count}} commentaires',
          title_other: '{{count}} commentaires',
          subtitle: 'Commentaires obsolètes', // ← no longer in primary
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: `
        import { useTranslation } from 'react-i18next';
        export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
          const { t } = useTranslation('common');
          return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
        };
      `,
      [resolve(process.cwd(), 'locales/en/common.json')]:
        JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]:
        JSON.stringify(frWithObsoleteKey, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]:
        JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frRaw = vol.toJSON()[resolve(process.cwd(), 'locales/fr/common.json')]
    const frAfterSync = JSON.parse(frRaw!)

    // `subtitle` was not in primary — it should be removed
    expect(frAfterSync?.detail?.comments?.subtitle).toBeUndefined()

    // Primary-matched keys should remain
    expect(frAfterSync?.detail?.comments?.title_one).toBe('{{count}} commentaire')
    expect(frAfterSync?.detail?.comments?.title_other).toBe('{{count}} commentaires')
  })
})
