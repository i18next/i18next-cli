import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

/**
 * Bug reproduction tests for:
 * https://github.com/your-org/i18next-cli/issues/216
 *
 * Issue: `sync` and `extract --ci` produce inconsistent plural key ordering
 * in JSON locale files, making the workflow `extract → sync → extract --ci`
 * non-idempotent.
 *
 * Root cause: When the syncer (from the #215 fix) preserves locale-specific
 * plural extensions (e.g. `title_many` for fr/es), it appends those keys
 * AFTER the primary-keyed entries.  The extractor, when run with `sort: true`,
 * writes keys in strict alphabetical order.  The two orderings differ:
 *
 *   sync writes:   title_one, title_other, title_many   (primary keys first, extension appended)
 *   extract writes: title_many, title_one, title_other  (alphabetical sort)
 *
 * `extract --dry-run --ci` then detects the ordering difference as a file
 * change and exits 1, even though no translation content has changed.
 */

// ---------------------------------------------------------------------------
// Filesystem + glob mocks
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
const { runExtractor } = await import('../src/index')
const { runSyncer } = await import('../src/syncer')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findVolFile (suffix: string): string | undefined {
  const json = vol.toJSON() as Record<string, string>
  const key = Object.keys(json).find(p => pathEndsWith(p, suffix))
  return key ? json[key] : undefined
}

/**
 * Returns the insertion-order keys of the nested object at `path` within
 * `obj`, where `path` is a dot-separated key chain (e.g. "detail.comments").
 */
function nestedKeyOrder (obj: Record<string, any>, path: string): string[] {
  return path.split('.').reduce((acc: any, seg) => acc?.[seg], obj)
    ? Object.keys(path.split('.').reduce((acc: any, seg) => acc?.[seg], obj))
    : []
}

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
// Source file used across tests — a single pluralised call
// ---------------------------------------------------------------------------

const COMPONENT_SRC = `
import { useTranslation } from 'react-i18next';
export const CommentsSection = ({ count }: { count: number }) => {
  const { t } = useTranslation('common');
  return <h2>{t('detail.comments.title', { count })}</h2>;
};
`

// Primary locale (en) — two plural forms only
const EN_COMMON = {
  detail: {
    comments: {
      title_one: '{{count}} Comment',
      title_other: '{{count}} Comments',
    },
  },
}

// French before sync — has the locale-required `title_many`
// Deliberately stored with the "wrong" (non-alphabetical) order to ensure the
// syncer and extractor both converge to the same sorted output.
const FR_COMMON_INITIAL = {
  detail: {
    comments: {
      title_one: '{{count}} commentaire',
      title_other: '{{count}} commentaires',
      title_many: '{{count}} commentaires',
    },
  },
}

const ES_COMMON_INITIAL = {
  detail: {
    comments: {
      title_one: '{{count}} comentario',
      title_other: '{{count}} comentarios',
      title_many: '{{count}} comentarios',
    },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync + extract --ci plural key ordering (issue #216)', () => {
  // let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Point glob at the primary locale directory for the syncer
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
    })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    /* processExitSpy = */vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Test 1 — Direct ordering check: sync must produce sorted output when
  // `sort: true` is configured, including preserved locale-extension keys.
  // -------------------------------------------------------------------------

  it('FIX: sync preserves the existing key order of locale-extension plural keys', async () => {
    // The order-preserving syncer does NOT sort keys itself. Instead it walks
    // the existing secondary file in its current order and reproduces it.
    // Once `extract` has written the file in its canonical order, subsequent
    // `sync` runs preserve that order exactly — making the pipeline idempotent.
    //
    // This test verifies the core order-preservation contract: whatever key
    // order is already in the secondary file, sync must reproduce it.
    const config = makeConfig()

    // FR_COMMON_INITIAL has keys in the order: title_one, title_other, title_many.
    // After sync the output must keep exactly that order (not re-sort or re-append).
    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_COMMON, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_COMMON_INITIAL, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_COMMON_INITIAL, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frRaw = findVolFile('fr/common.json')
    expect(frRaw).toBeDefined()
    const frAfterSync = JSON.parse(frRaw!)

    const comments = frAfterSync?.detail?.comments
    expect(comments).toBeDefined()

    // All three keys must still be present with their translated values
    expect(comments.title_one).toBe('{{count}} commentaire')
    expect(comments.title_other).toBe('{{count}} commentaires')
    expect(comments.title_many).toBe('{{count}} commentaires')

    // The locale-extension key (title_many) must appear in the same relative
    // position as it did in the input file — not appended at the end.
    // FR_COMMON_INITIAL order: title_one, title_other, title_many
    expect(Object.keys(comments)).toEqual(['title_one', 'title_other', 'title_many'])
  })

  // -------------------------------------------------------------------------
  // Test 2 — Idempotency: extract → sync → extract --dry-run must report
  //           no file changes (anyFileUpdated === false).
  // -------------------------------------------------------------------------

  it('BUG: extract → sync → extract --dry-run is not idempotent when locale has extra plural forms', async () => {
    const config = makeConfig()

    // Re-point glob to source files for the extractor pass, then to en/ for sync
    const { glob } = await import('glob')

    // Step 1: extract
    // Glob returns source files so the extractor can discover keys
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      if (String(pattern).includes('{{language}}') || String(pattern).includes('/en/') || String(pattern).endsWith('/*')) {
        return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
      }
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/src/'))
    })

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_COMMON, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_COMMON_INITIAL, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_COMMON_INITIAL, null, 2),
    })

    // extract — establishes the canonical form of all locale files
    await runExtractor(config, { isDryRun: false })

    // Step 2: sync — should not change the on-disk key order that extract just established
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
    })

    await runSyncer(config, { quiet: true })

    // Step 3: extract --dry-run --ci — must report NO file updates
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      if (String(pattern).includes('{{language}}') || String(pattern).includes('/en/') || String(pattern).endsWith('/*')) {
        return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
      }
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/src/'))
    })

    const { anyFileUpdated } = await runExtractor(config, { isDryRun: true })

    // BUG: anyFileUpdated is true because sync wrote keys in a different order
    // than extract expects (appended vs. sorted), causing extract to see a diff.
    expect(anyFileUpdated).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Test 3 — Verify that the sorted output produced by sync matches the
  //           sorted output produced by extract for the same content, key
  //           by key at the nested plural level.
  // -------------------------------------------------------------------------

  it('BUG: sync and extract produce different key orderings for the same locale file content', async () => {
    const config = makeConfig()

    const { glob } = await import('glob')

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_COMMON, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_COMMON_INITIAL, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_COMMON_INITIAL, null, 2),
    })

    // Run extract first to get its canonical sorted output
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      if (String(pattern).includes('{{language}}') || String(pattern).endsWith('/*')) {
        return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
      }
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/src/'))
    })

    await runExtractor(config, { isDryRun: false })

    const frAfterExtract = JSON.parse(findVolFile('fr/common.json')!)
    const orderAfterExtract = nestedKeyOrder(frAfterExtract, 'detail.comments')

    // Now run sync on the same files — it should produce identical ordering
    vi.mocked(glob).mockImplementation(async (pattern: any) => {
      return Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
    })

    await runSyncer(config, { quiet: true })

    const frAfterSync = JSON.parse(findVolFile('fr/common.json')!)
    const orderAfterSync = nestedKeyOrder(frAfterSync, 'detail.comments')

    // BUG: orderAfterSync !== orderAfterExtract because sync appends locale
    // extensions instead of sorting them with the rest of the keys.
    expect(orderAfterSync).toEqual(orderAfterExtract)
  })

  // -------------------------------------------------------------------------
  // Test 4 — Regression: sync must not change the order of keys that are
  //           already correctly sorted in the secondary file.
  // -------------------------------------------------------------------------

  it('sync should not reorder keys that are already in sorted order', async () => {
    const config = makeConfig()

    // French file already has keys in alphabetical order (the "fixed" state)
    const frAlreadySorted = {
      detail: {
        comments: {
          title_many: '{{count}} commentaires',
          title_one: '{{count}} commentaire',
          title_other: '{{count}} commentaires',
        },
      },
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_COMMON, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(frAlreadySorted, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_COMMON_INITIAL, null, 2),
    })

    await runSyncer(config, { quiet: true })

    const frAfter = findVolFile('fr/common.json')!

    // If the file was already sorted, sync should not rewrite it at all
    // (content-equal → no write), or at minimum preserve the sort order.
    const parsed = JSON.parse(frAfter)
    const actualOrder = nestedKeyOrder(parsed, 'detail.comments')
    const expectedOrder = ['title_many', 'title_one', 'title_other'] // alphabetical

    expect(actualOrder).toEqual(expectedOrder)
  })

  // -------------------------------------------------------------------------
  // Test 5 — Expected fix: after fix, the full extract → sync → extract --ci
  //           pipeline must be idempotent across multiple locales.
  // -------------------------------------------------------------------------

  it('EXPECTED FIX: extract → sync → extract --dry-run reports no changes for all secondary locales', async () => {
    const config = makeConfig()

    const { glob } = await import('glob')

    vol.fromJSON({
      [resolve(process.cwd(), 'src/CommentsSection.tsx')]: COMPONENT_SRC,
      [resolve(process.cwd(), 'locales/en/common.json')]: JSON.stringify(EN_COMMON, null, 2),
      [resolve(process.cwd(), 'locales/fr/common.json')]: JSON.stringify(FR_COMMON_INITIAL, null, 2),
      [resolve(process.cwd(), 'locales/es/common.json')]: JSON.stringify(ES_COMMON_INITIAL, null, 2),
    })

    const srcGlob = async () =>
      Object.keys(vol.toJSON()).filter((p: string) => p.includes('/src/'))
    const enGlob = async () =>
      Object.keys(vol.toJSON()).filter((p: string) => p.includes('/en/'))
    const hybridGlob = async (pattern: any) => {
      const p = String(pattern)
      return (p.includes('{{language}}') || p.endsWith('/*'))
        ? enGlob()
        : srcGlob()
    }

    // Step 1: extract
    vi.mocked(glob).mockImplementation(hybridGlob)
    await runExtractor(config, { isDryRun: false })

    // Step 2: sync
    vi.mocked(glob).mockImplementation(enGlob)
    await runSyncer(config, { quiet: true })

    // Step 3: extract --dry-run — must see no changes
    vi.mocked(glob).mockImplementation(hybridGlob)
    const { anyFileUpdated } = await runExtractor(config, { isDryRun: true })

    // After the fix, sync must write keys in the same sorted order as extract,
    // so a subsequent dry-run detects zero diffs.
    expect(anyFileUpdated).toBe(false)
  })
})
