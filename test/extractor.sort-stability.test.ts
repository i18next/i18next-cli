import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

/**
 * Regression tests for #279: the key comparator used to compare base keys for
 * plural/plural pairs but full keys for every other pair, which made it
 * intransitive. The resulting order then depended on the input order, so
 * `extract` was not idempotent for a key that has both plural forms and a
 * context variant in a locale with a `zero` plural (lv, ru, pl, lt, uk, …).
 */
describe('key sort stability', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-sort-stability-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const makeConfig = (): I18nextToolkitConfig => ({
    locales: ['lv'],
    extract: {
      input: normalizePath(join(tempDir, 'src/*.{ts,tsx}')),
      output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
      sort: true,
      keySeparator: false,
      // keeps the existing file's key order as the sort input, which is what
      // exposed the intransitive comparator
      removeUnusedKeys: false,
    },
  })

  it('produces the same key order regardless of the existing file order', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'Issues.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export const Issues = ({ count }: { count: number }) => {
          const { t } = useTranslation();
          return <p>{t('foo', { count })} {t('foo_solved')}</p>;
        };
      `
    )

    const lvPath = join(tempDir, 'locales', 'lv.json')
    const config = makeConfig()

    await runExtractor(config, { isDryRun: false })
    const expected = Object.keys(JSON.parse(await fs.readFile(lvPath, 'utf-8')).translation)

    // Plural forms come before the context variant, in canonical order
    expect(expected).toEqual(['foo_zero', 'foo_one', 'foo_other', 'foo_solved'])

    // Re-write the file with the context variant first (what a translation
    // service download can produce) and re-extract: the order must not flip.
    const shuffled = ['foo_solved', 'foo_zero', 'foo_one', 'foo_other']
    await fs.writeFile(
      lvPath,
      JSON.stringify({ translation: Object.fromEntries(shuffled.map(k => [k, k])) }, null, 2)
    )

    await runExtractor(config, { isDryRun: false })
    const after = Object.keys(JSON.parse(await fs.readFile(lvPath, 'utf-8')).translation)
    expect(after).toEqual(expected)
  })
})
