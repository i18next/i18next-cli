import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract, findKeys } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'
import { resolve } from 'path'
import { parse } from '@swc/core'
import { normalizeSpansToCharIndices } from '../src/extractor/parsers/ast-utils'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (): I18nextToolkitConfig => ({
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
})

const run = async (code: string, existing?: object) => {
  vol.fromJSON({ '/src/App.tsx': code, ...(existing ? { [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify(existing) } : {}) })
  const results = await extract(config())
  return results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))!.newTranslations
}

const withPrefix = (line: string) => `import { useTranslation } from 'react-i18next'
export function C ({ url }: { url?: string }) {
  const { t } = useTranslation('translation', { keyPrefix: 'a.b' })
  return (
    <div>
      ${line}
    </div>
  )
}
`

describe('extractor: // and /* outside comments are no comments (#337)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('main case from the report', async () => {
    expect(await run(withPrefix(`<span>{url?.replace(/^https?:\\/\\//, '') ?? t('fromRegexLine')}</span>
      <a href="https://example.com">{t('fromStringLine')}</a>
      <span>{t('plainLine')}</span>`))).toEqual({ a: { b: { fromRegexLine: 'fromRegexLine', fromStringLine: 'fromStringLine', plainLine: 'plainLine' } } })
  })

  it.each([
    ['regex literal', '<span>{url?.replace(/^https?:\\/\\//, \'\') ?? t(\'key\')}</span>'],
    ['string literal', '<span>{url === \'https://example.com\' ? url : t(\'key\')}</span>'],
    // eslint-disable-next-line no-template-curly-in-string
    ['template literal', '<span>{`https://example.com/${t(\'key\')}`}</span>'],
    ['JSX attribute', '<a href="https://example.com">{t(\'key\')}</a>'],
    ['JSX text', '<p>See https://example.com {t(\'key\')}</p>'],
    ['two strings, same line', '<input accept="image/*" title={t(\'key\')} data-x="*/*" />'],
  ])('%s', async (_, line) => {
    expect(await run(withPrefix(line))).toEqual({ a: { b: { key: 'key' } } })
  })

  it('two strings, lines apart', async () => {
    expect(await run(withPrefix(`<input accept="image/*" />
      <span>{t('key')}</span>
      <span>{t('second')}</span>
      <input accept="*/*" />`))).toEqual({ a: { b: { key: 'key', second: 'second' } } })
  })

  it('a template key next to a URL keeps no stale keys', async () => {
    const code = `import { useTranslation } from 'react-i18next'
export function C ({ kind }: { kind: 'x' | 'y' }) {
  const { t } = useTranslation()
  return <a href="https://example.com">{t(\`status.\${kind}\`)}</a>
}
`
    expect(await run(code, { status: { x: 'X', y: 'Y', removedLongAgo: 'Stale' } })).toEqual({ status: { x: 'X', y: 'Y' } })
  })

  it('real comments still extract, also after a false opener on the same line', async () => {
    expect(await run(withPrefix(`<a href="https://x.com">x</a> {/* t('afterUrl') */}
      {/* t('jsxComment') */}
      <span>{t('code')}</span>`) + '// t(\'line\')\n/* t(\'block\', \'Block\') */\n')).toEqual({
      a: { b: { code: 'code' } }, afterUrl: 'afterUrl', jsxComment: 'jsxComment', line: 'line', block: 'Block'
    })
  })

  it('a hashbang file reports locations', async () => {
    vol.fromJSON({
      '/src/App.tsx': `#!/usr/bin/env node
import i18next from 'i18next'
const s = '#!' + "x"
i18next.t('key')
`
    })
    const { allKeys } = await findKeys(config())
    expect([...allKeys.values()].find(k => k.key === 'key')?.locations?.[0]).toEqual({ file: '/src/App.tsx', line: 4, column: 10 })
  })

  it('a file with a BOM reports the right column', async () => {
    vol.fromJSON({
      '/src/App.tsx': `\uFEFFimport i18next from 'i18next'
i18next.t('key')
`
    })
    const { allKeys } = await findKeys(config())
    expect([...allKeys.values()].find(k => k.key === 'key')?.locations?.[0]).toEqual({ file: '/src/App.tsx', line: 2, column: 10 })
  })

  // extract, lint and instrument all read the code at these spans; instrument rewrote such files at wrong offsets
  it.each([
    ['a hashbang', '#!/usr/bin/env node\n'],
    ['a BOM', '\uFEFF'],
    ['a BOM and a hashbang', '\uFEFF#!/usr/bin/env node\n'],
    ['a no-break space', '\u00A0'],
  ])('spans point at the code in a file with %s', async (_, head) => {
    const code = head + 'const a = "Grüße"\nconst b = \'https://x\'\n'
    const ast = await parse(code, { syntax: 'typescript', tsx: true })
    normalizeSpansToCharIndices(ast, code)
    const items = (ast.body as any[]).map(d => d.declarations[0].init)
    expect(items.map(n => code.slice(n.span.start, n.span.end))).toEqual(items.map(n => n.raw))
  })

  it.each([
    ['a hashbang', '#!/usr/bin/env node\n'],
    ['a BOM', '\uFEFF'],
  ])('blanks the right spans in a file with %s', async (_, head) => {
    expect(await run(head + `import { useTranslation } from 'react-i18next'
export function C () {
  const { t } = useTranslation('translation', { keyPrefix: 'a.b' })
  return <a href="https://example.com">{t('key')}</a> // t('real')
}
`)).toEqual({ a: { b: { key: 'key' } }, real: 'real' })
  })

  it('finds a real comment inside a template expression and skips // in template types', async () => {
    expect(await run(`import { useTranslation } from 'react-i18next'
type U = \`https://\${string}\`
export function C ({ x }: { x: string }) {
  const { t } = useTranslation('translation', { keyPrefix: 'a.b' })
  return <p>{\`https://x/\${/* t('inTpl') */ x}\`}{t('key')}</p>
}
`)).toEqual({ a: { b: { key: 'key' } }, inTpl: 'inTpl' })
  })
})
