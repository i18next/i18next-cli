import { vol } from 'memfs'
import { glob } from 'glob'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extract, findKeys } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config: I18nextToolkitConfig = {
  locales: ['en', 'fr'],
  extract: {
    input: ['/src/*.tsx'],
    output: '/locales/{{language}}/{{namespace}}.json',
    nsSeparator: '|',
    keySeparator: false,
    contextSeparator: '//context:',
    primaryLanguage: 'en',
    removeUnusedKeys: false,
    defaultValue: (key, _ns, locale, value) => locale === 'en' ? value ?? key : '',
  },
}

function source (code: string, existing?: Record<string, string>) {
  vol.fromJSON({
    '/src/App.tsx': code,
    ...(existing ? { '/locales/en/labels.json': JSON.stringify(existing) } : {}),
  })
  vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
}

async function labels () {
  const results = await extract(config)
  const result = results.find(r => r.locale === 'en' && r.namespace === 'labels')
  if (!result) throw new Error('Missing English labels result')
  return result.newTranslations
}

describe('native source-default selection', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
  })

  const defaults = [
    { declaration: '', expression: "'{{count}} widgets'" },
    { declaration: '', expression: '`{{count}} widgets`' },
    { declaration: '', expression: "('{{count}} widgets')" },
    { declaration: "const widgets = '{{count}} widgets';", expression: 'widgets' },
    { declaration: "const text = { widgets: '{{count}} widgets' };", expression: 'text.widgets' },
    { declaration: "const suffix = 'widgets';", expression: "'{{count}} ' + suffix" },
  ]

  it.each(defaults)('preserves resolved $expression defaults in every source order', async ({ declaration, expression }) => {
    const calls = [
      "t('labels|items', { count: 2 });",
      'const view = <Trans i18nKey="labels|items" count={2}>JSX items</Trans>;',
      `t('labels|items', ${expression}, { count: 2 });`,
    ]
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      vol.reset()
      const code = declaration + '\n' + order.map(i => calls[i]).join('\n')
      source(code)
      expect(await labels()).toMatchObject({
        items_one: '{{count}} widgets',
        items_other: '{{count}} widgets',
      })
      const { allKeys } = await findKeys(config)
      expect(allKeys.get('labels:items_other')?.explicitDefault).toBe(false)

      source(code, { items_one: 'One widget', items_other: 'Many widgets' })
      expect(await labels()).toMatchObject({ items_one: 'One widget', items_other: 'Many widgets' })
    }
  })

  it.each([
    '<Trans i18nKey="labels|welcome" />',
    '<Trans i18nKey="labels|welcome"></Trans>',
    '<Trans i18nKey="labels|welcome">{/* no text */}</Trans>',
  ])('does not select synthesized text from %s over real children', async empty => {
    const text = 'const view = <Trans i18nKey="labels|welcome">Welcome</Trans>;'
    for (const order of [[`const empty = ${empty};`, text], [text, `const empty = ${empty};`]]) {
      vol.reset()
      source(order.join('\n'))
      expect(await labels()).toEqual({ welcome: 'Welcome' })
    }
    vol.reset()
    source(`const empty = ${empty};`)
    const { allKeys } = await findKeys(config)
    expect(allKeys.get('labels:welcome')?.defaultValueSource).toBe('fallback')
  })

  it('never lets an empty default outrank text, and keeps literal namespace-like JSX text', async () => {
    for (const order of [['text', 'empty'], ['empty', 'text']]) {
      const lines = {
        text: 'const text = <Trans i18nKey="labels|welcome">Welcome</Trans>;',
        empty: 'const empty = <Trans i18nKey="labels|welcome" defaults="" />;',
      }
      vol.reset()
      source(`
        ${order.map(name => lines[name as keyof typeof lines]).join('\n')}
        const literal = <Trans i18nKey="labels|literal">labels|literal</Trans>;
        t('labels|literal');
      `)
      expect(await labels()).toEqual({ welcome: 'Welcome', literal: 'labels|literal' })
    }
    vol.fromJSON({
      '/locales/en/labels.json': JSON.stringify({ welcome: { old: 'Stale object' } }),
      '/locales/fr/labels.json': JSON.stringify({ welcome: 'Bienvenue' }),
    })
    const results = await extract(config)
    expect(results.find(r => r.locale === 'en' && r.namespace === 'labels')?.newTranslations)
      .toEqual({ welcome: 'Welcome', literal: 'labels|literal' })
    expect(results.find(r => r.locale === 'fr' && r.namespace === 'labels')?.newTranslations)
      .toMatchObject({ welcome: 'Bienvenue' })
  })

  it('settles an empty default against a key fallback the same way in every order', async () => {
    const emptyConfig = { ...config, extract: { ...config.extract, defaultValue: '' } }
    const outputs = []
    for (const calls of [
      "t('labels|k'); t('labels|k', ''); t('labels|n', { count: 2 }); t('labels|n', '', { count: 2 });",
      "t('labels|k', ''); t('labels|k'); t('labels|n', '', { count: 2 }); t('labels|n', { count: 2 });",
    ]) {
      vol.reset()
      source(calls)
      const results = await extract(emptyConfig)
      outputs.push(results.find(r => r.locale === 'en' && r.namespace === 'labels')?.newTranslations)
    }
    expect(outputs[0]).toEqual(outputs[1])
    expect(outputs[0]).toMatchObject({ k: '' })
  })

  it('writes what i18next 27 and react-i18next 18 render for an empty default', async () => {
    source(`
      t('labels|call', '');
      t('labels|option', { defaultValue: '' });
      const blank = <Trans i18nKey="labels|blank" defaults="" />;
      const children = <Trans i18nKey="labels|children" defaults="">Children text</Trans>;
    `)
    const results = await extract({ ...config, extract: { ...config.extract, defaultValue: undefined } })
    // t() returns an explicit '' default; Trans falls back to its children, then the key
    expect(results.find(r => r.locale === 'en' && r.namespace === 'labels')?.newTranslations)
      .toEqual({ call: '', option: '', blank: 'blank', children: 'Children text' })
  })

  it('uses the children when defaults is not a string literal', async () => {
    source(`
      const dynamic = <Trans i18nKey="labels|dynamic" defaults={someDefault}>Children text</Trans>;
      const counted = <Trans i18nKey="labels|counted" count={2} defaults={someDefault}>{{ count }} children</Trans>;
    `)
    expect(await labels()).toMatchObject({ dynamic: 'Children text', counted_other: '{{count}} children' })
  })

  it('selects resolved defaults across files and ordinal/context variants without erasing translations', async () => {
    const call = "const text = { widgets: '{{count}} widgets' }; t('labels|items', text.widgets, { count: 2, ordinal: true, context: 'female' });"
    const jsx = 'const view = <Trans i18nKey="labels|items" count={2} ordinal context="female">JSX items</Trans>;'
    for (const callFirst of [false, true]) {
      vol.reset()
      vol.fromJSON({ '/src/a.tsx': callFirst ? call : jsx, '/src/b.tsx': callFirst ? jsx : call })
      vi.mocked(glob).mockResolvedValue(['/src/b.tsx', '/src/a.tsx'])
      expect(await labels()).toMatchObject({ 'items//context:female_ordinal_other': '{{count}} widgets' })
      vol.fromJSON({ '/locales/en/labels.json': JSON.stringify({ 'items//context:female_ordinal_other': 'Existing ordinal text' }) })
      expect(await labels()).toMatchObject({ 'items//context:female_ordinal_other': 'Existing ordinal text' })
    }
  })

  it.each(['section.', 'section'])('handles resolved defaults and options variables with prefix %s', async prefix => {
    const declaration = `
      const { t } = useTranslation('labels', { keyPrefix: '${prefix}' });
      const options = { count: 2 };
      const text = { widgets: '{{count}} widgets' };
    `
    const implicit = "t('items', options);"
    const jsx = 'const view = <Trans t={t} i18nKey="items" count={2}>JSX items</Trans>;'
    const explicit = "t('items', text.widgets, options);"
    for (const calls of [[implicit, jsx, explicit], [explicit, jsx, implicit]]) {
      vol.reset()
      source(declaration + calls.join('\n') + "\ni18next.t('other|items', { count: 2 });")
      expect(await labels()).toMatchObject({ [`${prefix}items_other`]: '{{count}} widgets' })
    }
    vol.reset()
    source(declaration + implicit + '\n' + jsx)
    expect(await labels()).toMatchObject({ [`${prefix}items_other`]: 'JSX items' })
  })
})
