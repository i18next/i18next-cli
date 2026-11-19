import { vol } from 'memfs'
import { resolve } from 'node:path'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const SRC = resolve(process.cwd(), 'src/App.tsx')

async function lint (lines: string[], files: Record<string, any>, extract: Partial<I18nextToolkitConfig['extract']> = {}) {
  const config: I18nextToolkitConfig = {
    locales: ['en'],
    extract: { input: ['src/**/*.tsx'], output: 'locales/{{language}}/{{namespace}}.json', ...extract },
    lint: {},
  }
  vol.fromJSON({
    [SRC]: lines.join('\n'),
    ...Object.fromEntries(Object.entries(files).map(([path, json]) => [resolve(process.cwd(), path), JSON.stringify(json)])),
  })
  const result = await runLinter(config)
  return (result.files[SRC] ?? []).map(({ text, line }) => ({ text, line }))
}

const missingName = (line: number) => ({ text: 'Interpolation parameter "name" was not provided', line })

describe('lint: checkInterpolationParams with namespaces', () => {
  beforeEach(async () => {
    vol.reset()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([SRC])
  })

  // the default namespace has a `greeting` without variables, so only the `home` value can report
  const files = {
    'locales/en/common.json': { greeting: 'Hi', footer_place: 'At the market square in {{city}}' },
    'locales/en/home.json': { greeting: 'Hello {{name}}', profile: { title: 'Profile of {{name}}' } },
  }

  it('reads the value from the namespace of useTranslation, of the ns: prefix, of the ns option and of the default', async () => {
    const issues = await lint([
      'function A() { const { t } = useTranslation("home"); return t("greeting") }',
      'function B() { const { t } = useTranslation(); return t("home:greeting") }',
      'function C() { const { t } = useTranslation(); return t("greeting", { ns: "home" }) }',
      'function D() { const { t } = useTranslation(); return t("footer_place") }',
      'function E() { const { t } = useTranslation(); return t("footer_place", { ciyt: "Bern" }) }',
      'function F() { const { t } = useTranslation(); return t("greeting") }',
      'function G() { const { t } = useTranslation("home"); return t("greeting", { name }) + t("common:greeting") }',
    ], files, { defaultNS: 'common' })

    expect(issues).toEqual([
      missingName(1),
      missingName(2),
      missingName(3),
      { text: 'Interpolation parameter "city" was not provided', line: 4 },
      { text: 'Interpolation parameter "city" was not provided', line: 5 },
      { text: 'Parameter "ciyt" is not used in translation string', line: 5 },
      // string concatenation, a separate check
      expect.objectContaining({ line: 7 }),
    ])
  })

  it('applies the keyPrefix within the namespace, for string keys and selectors', async () => {
    const issues = await lint([
      'const { t } = useTranslation("home", { keyPrefix: "profile" })',
      't("title")',
      't("title", { name })',
      't($ => $.title)',
      'function A() { const { t } = useTranslation("home")',
      '  return t($ => $.greeting) }',
    ], files, { defaultNS: 'common' })

    expect(issues).toEqual([missingName(2), missingName(4), missingName(6)])
  })

  it('reads a merged file with one object per namespace', async () => {
    const lines = [
      'const { t } = useTranslation("home")',
      't("greeting")',
      't("common:footer_place", { city })',
    ]
    const merged = { 'locales/en.json': { common: files['locales/en/common.json'], home: files['locales/en/home.json'] } }

    expect(await lint(lines, merged, { defaultNS: 'common', output: 'locales/{{language}}.json' })).toEqual([missingName(2)])
    expect(await lint(lines, merged, { defaultNS: 'common', output: 'locales/{{language}}.json', mergeNamespaces: true })).toEqual([missingName(2)])
  })

  it('reads the keys without a namespace with defaultNS: false', async () => {
    const issues = await lint([
      'const { t } = useTranslation()',
      't("greeting")',
      't("profile.title", { name })',
    ], { 'locales/en.json': { greeting: 'Hello {{name}}', profile: { title: 'Profile of {{name}}' } } }, { defaultNS: false, output: 'locales/{{language}}.json' })

    expect(issues).toEqual([missingName(2)])
  })

  it('counts the variables of every plural form', async () => {
    const issues = await lint([
      'const { t } = useTranslation("home")',
      't("item", { count })',
      't("item", { count, total })',
    ], { 'locales/en/home.json': { item_one: '{{count}} item', item_other: '{{count}} items for {{total}}' } })

    expect(issues).toEqual([{ text: 'Interpolation parameter "total" was not provided', line: 2 }])
  })
})
