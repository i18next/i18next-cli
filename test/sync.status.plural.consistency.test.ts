import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'
import { normalizePath, pathEndsWith } from './utils/path'

/**
 * Tests for issue #220: plural suffix generation and sync/status consistency.
 *
 * Background
 * ----------
 * When `extract` runs against a plural t() call with locales ['en', 'fr', 'es'],
 * it iterates ALL configured locales to build the union of CLDR plural categories.
 * For en+fr+es that union is {one, many, other}, so `title_many: ""` IS written
 * to fr/es locale files by extract.
 *
 * `status` then correctly reports those keys as incomplete because their value is
 * the empty string — a placeholder that genuinely needs a translator to fill in.
 * Exiting 1 in that situation is correct; there is no bug in the exit behaviour.
 *
 * What WAS confusing (now fixed) is that the original status output did not
 * distinguish between:
 *   - "untranslated"  — key is present in the file but value is ""
 *                       (normal after a fresh extract; needs a translator)
 *   - "absent"        — key is completely missing from the file
 *                       (structural problem; extract/sync may not have run)
 *
 * The updated status output now shows both states separately so developers
 * can tell at a glance whether they need to run extract again or just hand
 * the file to a translator.
 *
 * Sync consistency
 * ----------------
 * A separate real issue exists in the syncer: if a translator manually adds
 * `title_many` to a secondary locale file, sync must not strip it just because
 * the primary locale (en) has no `_many` key.  The syncer already handles this
 * via `isLocaleSpecificPluralExtension`.
 */

// ---------------------------------------------------------------------------
// Mock filesystem and glob
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

// Imports must come AFTER mocks
const { runStatus, runExtractor } = await import('../src/index')
const { runSyncer } = await import('../src/syncer')

/** Look up a file in the memfs volume by normalized path suffix. */
function findVolFile (suffix: string): string | undefined {
  const json = vol.toJSON() as Record<string, string>
  const key = Object.keys(json).find(p => pathEndsWith(p, suffix))
  return key ? json[key] : undefined
}

// ---------------------------------------------------------------------------
// Config helper
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
// Fixtures
// ---------------------------------------------------------------------------

/** Primary locale (en) — only has `_one` and `_other` */
const EN_TRANSLATIONS = {
  detail: {
    comments: {
      title_one: '{{count}} Comment',
      title_other: '{{count}} Comments',
      newKey: 'New string', // ← exists in EN, absent in FR/ES (canary for sync)
    },
  },
}

/** French locale with manually-added `_many` form */
const FR_TRANSLATIONS_BEFORE_SYNC = {
  detail: {
    comments: {
      title_one: '{{count}} commentaire',
      title_many: '{{count}} commentaires',
      title_other: '{{count}} commentaires',
    },
  },
}

/** Spanish locale with manually-added `_many` form */
const ES_TRANSLATIONS_BEFORE_SYNC = {
  detail: {
    comments: {
      title_one: '{{count}} comentario',
      title_many: '{{count}} comentarios',
      title_other: '{{count}} comentarios',
    },
  },
}

/** Source file used across all tests — a single pluralised t() call */
const COMPONENT_SRC = `
import { useTranslation } from 'react-i18next';
export const CommentsSection = ({ commentCount }: { commentCount: number }) => {
  const { t } = useTranslation('common');
  return <h2>{t('detail.comments.title', { count: commentCount })}</h2>;
};
`

// ---------------------------------------------------------------------------
// Part 1: sync + status consistency
// (unchanged from the original test suite, plus canary assertions)
// ---------------------------------------------------------------------------

describe('sync + status plural consistency (issue #220)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter(p => normalizePath(p).includes('/en/'))
    })

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('syncer preserves locale-required plural forms not present in primary locale', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_TRANSLATIONS_BEFORE_SYNC, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frRaw = findVolFile('locales/fr/common.json')
    const esRaw = findVolFile('locales/es/common.json')

    expect(frRaw).toBeDefined()
    expect(esRaw).toBeDefined()

    const frAfterSync = JSON.parse(frRaw!)
    const esAfterSync = JSON.parse(esRaw!)

    // Canary: proves sync actually ran (newKey was absent from FR/ES before sync)
    expect(frAfterSync?.detail?.comments?.newKey).toBe('')

    // title_many must survive sync even though it is absent from the primary (en) locale
    expect(frAfterSync?.detail?.comments?.title_many).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_many).toBe('{{count}} comentarios')

    expect(frAfterSync?.detail?.comments?.title_one).toBe('{{count}} commentaire')
    expect(frAfterSync?.detail?.comments?.title_other).toBe('{{count}} commentaires')
    expect(esAfterSync?.detail?.comments?.title_one).toBe('{{count}} comentario')
    expect(esAfterSync?.detail?.comments?.title_other).toBe('{{count}} comentarios')
  })

  it('status exits 1 when _many is present but empty (untranslated placeholder)', async () => {
    // This documents correct behaviour: an empty _many means a translator needs
    // to fill it in.  status correctly flags that with exit 1.
    const config = makeConfig()

    const frWithEmptyMany = {
      detail: {
        comments: {
          title_one: '{{count}} commentaire',
          title_many: '',    // present but empty — needs translation
          title_other: '{{count}} commentaires',
        },
      },
    }
    const esWithEmptyMany = {
      detail: {
        comments: {
          title_one: '{{count}} comentario',
          title_many: '',    // present but empty — needs translation
          title_other: '{{count}} comentarios',
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(frWithEmptyMany, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(esWithEmptyMany, null, 2),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter(p => normalizePath(p).includes('/src/'))
    })

    try { await runStatus(config) } catch { /* process.exit throws */ }

    // Correct: _many is present but empty → translator still needs to fill it in
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('status exits 0 after sync when all source-code keys are fully translated, including preserved _many', async () => {
    // After sync:
    //   - title_one, title_other, title_many are all present with translated values (preserved by sync)
    //   - newKey is added as "" but it only lives in the EN json fixture, NOT in COMPONENT_SRC
    // findKeys scans source files only, so newKey is never extracted and status
    // only checks the three plural forms — all of which are translated.
    // Therefore status must exit 0.
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_TRANSLATIONS_BEFORE_SYNC, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter(p => normalizePath(p).includes('/src/'))
    })

    try { await runStatus(config) } catch { /* process.exit throws */ }

    // All source-code plural keys are translated → status exits 0
    expect(processExitSpy).not.toHaveBeenCalledWith(1)
  })

  it('syncer still removes genuinely obsolete keys from secondary locales', async () => {
    const config = makeConfig()

    const frWithObsoleteKey = {
      detail: {
        comments: {
          title_one: '{{count}} commentaire',
          title_many: '{{count}} commentaires',
          title_other: '{{count}} commentaires',
          subtitle: 'Commentaires obsolètes', // ← not in primary
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_TRANSLATIONS, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(frWithObsoleteKey, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_TRANSLATIONS_BEFORE_SYNC, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frAfterSync = JSON.parse(findVolFile('locales/fr/common.json')!)

    expect(frAfterSync?.detail?.comments?.subtitle).toBeUndefined()
    expect(frAfterSync?.detail?.comments?.title_one).toBe('{{count}} commentaire')
    expect(frAfterSync?.detail?.comments?.title_other).toBe('{{count}} commentaires')
  })
})

// ---------------------------------------------------------------------------
// Part 2: extract plural suffix generation for secondary locales
// ---------------------------------------------------------------------------

describe('extract plural suffix generation for secondary locales (issue #220)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      const p = String(pattern)
      if (p.includes('{{language}}') || p.includes('/en/') || p.endsWith('/*')) {
        return Object.keys(vol.toJSON()).filter(f => normalizePath(f).includes('/en/'))
      }
      return Object.keys(vol.toJSON()).filter(f => normalizePath(f).includes('/src/'))
    })

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Test 6 — extract DOES generate _many for secondary locales
  // (union of all configured locales' CLDR categories)
  // -------------------------------------------------------------------------

  it('extract generates _many plural suffix for secondary locales (fr, es)', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
    })

    await runExtractor(config, { isDryRun: false })

    const frRaw = findVolFile('locales/fr/common.json')
    const esRaw = findVolFile('locales/es/common.json')

    expect(frRaw).toBeDefined()
    expect(esRaw).toBeDefined()

    const frAfterExtract = JSON.parse(frRaw!)
    const esAfterExtract = JSON.parse(esRaw!)

    // extract iterates ALL locales to build the union of CLDR plural categories.
    // For en+fr+es that union includes 'many', so _many is written for fr and es.
    expect(frAfterExtract?.detail?.comments).toHaveProperty('title_one')
    expect(frAfterExtract?.detail?.comments).toHaveProperty('title_other')
    expect(frAfterExtract?.detail?.comments).toHaveProperty('title_many')
    expect(esAfterExtract?.detail?.comments).toHaveProperty('title_many')
  })

  // -------------------------------------------------------------------------
  // Test 7 — status correctly exits 1 after a clean extract because the
  // generated _many placeholders are empty and need a translator.
  // This is EXPECTED and CORRECT behaviour, not a bug.
  // -------------------------------------------------------------------------

  it('status correctly exits 1 after a clean extract: _many exists but is empty and needs translation', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
    })

    await runExtractor(config, { isDryRun: false })

    // Confirm _many was written as an empty placeholder
    const frAfterExtract = JSON.parse(findVolFile('locales/fr/common.json')!)
    expect(frAfterExtract?.detail?.comments?.title_many).toBe('')

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () =>
      Object.keys(vol.toJSON()).filter(f => normalizePath(f).includes('/src/'))
    )

    try { await runStatus(config) } catch { /* process.exit throws */ }

    // Correct: empty placeholder means untranslated — status must exit 1
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // Test 8 — regression guard: extract must NOT add _many to the primary
  // locale (en). English CLDR has only `one` and `other`.
  // -------------------------------------------------------------------------

  it('extract does not generate _many for the primary locale (en)', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
    })

    await runExtractor(config, { isDryRun: false })

    const enRaw = findVolFile('locales/en/common.json')
    expect(enRaw).toBeDefined()
    const enAfterExtract = JSON.parse(enRaw!)

    expect(enAfterExtract?.detail?.comments).toHaveProperty('title_one')
    expect(enAfterExtract?.detail?.comments).toHaveProperty('title_other')
    expect(enAfterExtract?.detail?.comments).not.toHaveProperty('title_many')
  })

  // -------------------------------------------------------------------------
  // Test 9 — full repro of dbilldr's steps: extract then status.
  // Status exits 1 because _many is an empty placeholder — correct behaviour.
  // The distinction between "absent" and "untranslated" is now visible in the
  // status output so developers can understand why exit 1 was triggered.
  // -------------------------------------------------------------------------

  it('after a clean extract, status exits 1 because _many is an empty placeholder that needs translation', async () => {
    const config = makeConfig()

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
    })

    // Step 1: extract
    await runExtractor(config, { isDryRun: false })

    const frAfterExtract = JSON.parse(findVolFile('locales/fr/common.json')!)
    // _many is present (extract ran correctly) but has no value yet
    expect(frAfterExtract?.detail?.comments).toHaveProperty('title_many')
    expect(frAfterExtract?.detail?.comments?.title_many).toBe('')

    // Step 2: status
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () =>
      Object.keys(vol.toJSON()).filter(f => normalizePath(f).includes('/src/'))
    )

    try { await runStatus(config) } catch { /* process.exit throws */ }

    // Correct: _many is untranslated (empty), so status exits 1.
    // The updated status output now shows "N untranslated" vs "N absent" so
    // developers can tell this is a translation task, not a structural failure.
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // Test 10 — the new absent/empty distinction: verify that the report
  // correctly classifies keys as absent vs empty so the improved display
  // has accurate data to work with.
  // -------------------------------------------------------------------------

  it('status report correctly distinguishes absent keys from empty (untranslated) keys', async () => {
    const config = makeConfig()

    // fr has title_one translated, title_other empty, title_many absent entirely
    const frMixed = {
      detail: {
        comments: {
          title_one: '{{count}} commentaire',  // translated
          title_other: '',                      // empty placeholder
          // title_many intentionally absent    // structurally missing
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify({
        detail: { comments: { title_one: '{{count}} Comment', title_other: '{{count}} Comments' } }
      }, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(frMixed, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify({
        detail: { comments: { title_one: '{{count}} comentario', title_other: '{{count}} comentarios' } }
      }, null, 2),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () =>
      Object.keys(vol.toJSON()).filter(f => normalizePath(f).includes('/src/'))
    )

    // Access the internal report via a spy on generateStatusReport's output.
    // We do this by checking that the locale data in the exit path reflects
    // the correct counts — the simplest way is to check the console output.
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      consoleLogs.push(String(msg))
    })

    try { await runStatus(config) } catch { /* process.exit throws */ }

    // exit 1 was called (some keys are non-translated)
    expect(processExitSpy).toHaveBeenCalledWith(1)

    // The updated output must mention both "untranslated" and "absent"
    // somewhere in the console output to confirm the distinction is shown.
    const allOutput = consoleLogs.join('\n')
    expect(allOutput).toMatch(/untranslated/)
    expect(allOutput).toMatch(/absent/)
  })
})
