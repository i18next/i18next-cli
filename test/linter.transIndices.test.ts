import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'node:path'

const SRC = resolve(process.cwd(), 'src/App.tsx')

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (lint: I18nextToolkitConfig['lint'] = {}, extract: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: 'locales/{{language}}/{{namespace}}.json',
    ...extract,
  },
  lint,
})

// Lints one source file against the English translation files (namespace → values), returns the <Trans> issues
async function lint (code: string, resources: Record<string, Record<string, any>>, cfg = config()) {
  const files: Record<string, string> = { [SRC]: code }
  for (const [ns, values] of Object.entries(resources)) {
    files[resolve(process.cwd(), `locales/en/${ns}.json`)] = JSON.stringify(values)
  }
  vol.fromJSON(files)
  const result = await runLinter(cfg)
  return { result, issues: (result.files[SRC] ?? []).filter(i => i.type === 'transIndex') }
}

const trans = (children: string) => `import { Trans } from 'react-i18next'
export const App = ({ link, cond, items }) => <Trans i18nKey="k">${children}</Trans>
`

describe('lint: <Trans> tags against the children (checkTransIndices)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([SRC])
  })

  it('reports the {\' \'} a formatter inserts, which shifts every later index', async () => {
    const code = `import { Trans } from 'react-i18next'
export const Disclosure = () => (
  <Trans ns="reminder" i18nKey="disclosure">
    Each reminder needs{' '}
    <Bold>a contact with an email address</Bold>{' '}
    (depending on the channel)
  </Trans>
)
`
    const wrong = await lint(code, { reminder: { disclosure: 'Each reminder needs <1>a contact with an email address</1> (depending on the channel)' } })
    expect(wrong.issues).toEqual([{
      text: 'reminder:disclosure: <1> points to the text " ", which replaces its content',
      line: 3,
      type: 'transIndex',
      severity: 'warning',
    }])

    const right = await lint(code, { reminder: { disclosure: 'Each reminder needs <2>a contact with an email address</2> (depending on the channel)' } })
    expect(right.issues).toEqual([])
  })

  // what react-i18next renders decides: a tag is reported when it does not render what it wraps
  it.each([
    ['an element', 'Hello{\' \'}<Bold>world</Bold>', 'Hello <2>world</2>', []],
    ['a text child', 'Hello{\' \'}<Bold>world</Bold>', 'Hello <1>world</1>', ['<1> points to the text " ", which replaces its content']],
    ['past the last child', 'Hello <Bold>world</Bold>', 'Hello <2>world</2>', ['<2> points past the last child (2 children), so it renders without its markup']],
    ['the space between elements', '<Bold>a</Bold> <Bold>b</Bold>', '<0>a</0> <1>b</1>', ['<1> points to the text " ", which replaces its content']],
    ['elements on their own lines', '\n  <Bold>a</Bold>\n  <Bold>b</Bold>\n', '<0>a</0> <1>b</1>', []],
    ['nested indices', 'Text{\' \'}<P>before <Bold>bold</Bold></P>', 'Text <2>before <1>bold</1></2>', []],
    ['a nested text child', 'Text{\' \'}<P>before <Bold>bold</Bold></P>', 'Text <2><0>before</0> bold</2>', ['<2> > <0> points to the text "before ", which replaces its content']],
    ['an expression that may render an element', 'See {link}', 'See <1>here</1>', []],
    ['a conditional', 'See {cond ? \'plain\' : <Bold>bold</Bold>}', 'See <1>here</1>', []],
    // react-i18next renders the content of a tag on an interpolation object: "Total 5"
    ['an interpolation object', 'Total {{ total }}', 'Total <1>{{total}}</1>', []],
    ['a kept <br/>, which takes an index', 'Hello<br/><Bold>x</Bold>', 'Hello<br/><2>x</2>', []],
    ['content on a <br/>', 'Hello<br/><Bold>x</Bold>', 'Hello<br/><1>x</1>', ['<1> points to <br/>, which cannot have content (React throws)']],
    ['an empty tag on an element with text', 'Hello{\' \'}<Bold>world</Bold>', 'Hello <2/>', ['<2/> is empty, so the element it points to renders without its text']],
    ['an empty tag on an element without text', 'Click <Icon />', 'Click <1/>', []],
    ['a kept <p>, which opens its children', '<p>Intro <Bold>x</Bold></p>', '<p>Intro <1>x</1></p>', []],
    ['a text child inside a kept <p>', '<p>Intro <Bold>x</Bold></p>', '<p><0>Intro</0> x</p>', ['<p> > <0> points to the text "Intro ", which replaces its content']],
    ['a dynamic list', 'Items: <ul i18nIsDynamicList>{items.map(i => <li key={i}>{i}</li>)}</ul>', 'Items: <1><0>x</0></1>', []],
    ['an &nbsp; at the end of a line, which stays a child', 'Price&nbsp;\n  <Bold>x</Bold>&nbsp;\n  <Bold>y</Bold>', 'Price <1>x</1> <3>y</3>', []],
    // React passes a single child as is, so react-i18next indexes into an array the expression returns
    ['an expression as the only child', '{items}', 'Pick <1>one</1>', []],
    ['a list without i18nIsDynamicList', 'Items: <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>', 'Items: <1><0>a</0><1>b</1></1>', []],
    ['a tag that is no markup', 'Hello <Bold>world</Bold>', 'Hello <b>world</b> <1>x</1>', []],
  ])('%s', async (_, children, value, problems) => {
    const { issues } = await lint(trans(children), { translation: { k: value } })
    expect(issues.map(i => i.text)).toEqual(problems.map(p => `translation:k: ${p}`))
  })

  it('checks every plural and context form the extractor resolves, and the namespace of useTranslation', async () => {
    const code = `import { Trans, useTranslation } from 'react-i18next'
export const App = ({ count }) => {
  const { t } = useTranslation('billing', { keyPrefix: 'list' })
  return (
    <>
      <Trans t={t} i18nKey="item" count={count}><Bold>{{ count }}</Bold> invoice</Trans>
      <Trans t={t} i18nKey="friend" context="male">A <Bold>friend</Bold></Trans>
    </>
  )
}
`
    const { issues } = await lint(code, {
      billing: {
        list: {
          item_one: '<0>{{count}}</0> invoice',
          item_other: '{{count}} <1>invoices</1>',
          friend_male: 'A <0>friend</0>',
        },
      },
    })
    expect(issues.map(i => [i.line, i.text])).toEqual([
      [6, 'billing:list.item_other: <1> points to the text " invoice", which replaces its content'],
      [7, 'billing:list.friend_male: <0> points to the text "A ", which replaces its content'],
    ])
  })

  it('skips a <Trans> with components, a key it cannot resolve and a missing value', async () => {
    const code = `import { Trans } from 'react-i18next'
export const App = ({ key }) => <>
  <Trans i18nKey="a" components={{ bold: <b /> }}>Hello <Bold>world</Bold></Trans>
  <Trans i18nKey={key}>Hello <Bold>world</Bold></Trans>
  <Trans i18nKey="missing">Hello <Bold>world</Bold></Trans>
</>
`
    const { issues } = await lint(code, { translation: { a: 'Hello <5>world</5>' } })
    expect(issues).toEqual([])
  })

  it('is off with \'off\', and fails the run with \'error\'', async () => {
    const off = await lint(trans('Hello <Bold>world</Bold>'), { translation: { k: 'Hello <2>world</2>' } }, config({ checkTransIndices: 'off' }))
    expect(off.issues).toEqual([])

    const error = await lint(trans('Hello <Bold>world</Bold>'), { translation: { k: 'Hello <2>world</2>' } }, config({ checkTransIndices: 'error' }))
    expect(error.issues.map(i => i.severity)).toEqual(['error'])
    expect(error.result.success).toBe(false)
  })

  it('reads a merged translation file', async () => {
    const files = {
      [SRC]: trans('Hello <Bold>world</Bold>'),
      [resolve(process.cwd(), 'locales/en.json')]: JSON.stringify({ translation: { k: 'Hello <2>world</2>' } }),
    }
    vol.fromJSON(files)
    const result = await runLinter(config({}, { output: 'locales/{{language}}.json' }))
    expect((result.files[SRC] ?? []).filter(i => i.type === 'transIndex').map(i => i.text)).toEqual(['translation:k: <2> points past the last child (2 children), so it renders without its markup'])
  })
})
