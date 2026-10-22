import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter } from '../src/linter'
import { interpolationNames } from '../src/utils/message-format'
import type { I18nextToolkitConfig } from '../src/index'
import { normalize, resolve } from 'node:path'

// Platform paths, like linter.messageformat.test.ts: memfs keys as the linter resolves them, issue keys as
// getOutputPath normalizes them, so the tests pass on Windows too
const SRC = resolve(process.cwd(), 'src/App.tsx')
const abs = (p: string) => resolve(process.cwd(), p)
const out = (lng: string, ext = 'json') => normalize(`locales/${lng}/translation.${ext}`)

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (locales: string[], lint: I18nextToolkitConfig['lint'] = {}, extract: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
  locales,
  extract: {
    input: ['src/**/*.tsx'],
    output: 'locales/{{language}}/{{namespace}}.json',
    ...extract,
  },
  lint,
})

// Writes one translation file per locale (an object is written as JSON, a string as is) and returns the lint result
async function lint (cfg: I18nextToolkitConfig, resources: Record<string, Record<string, any> | string>, { code = '', ext = 'json' } = {}) {
  const files: Record<string, string> = { [SRC]: code }
  for (const [lng, values] of Object.entries(resources)) {
    files[abs(`locales/${lng}/translation.${ext}`)] = typeof values === 'string' ? values : JSON.stringify(values, null, 2)
  }
  vol.fromJSON(files)
  return runLinter(cfg)
}

const issuesOf = (result: Awaited<ReturnType<typeof runLinter>>, lng: string, ext = 'json') => result.files[out(lng, ext)] ?? []
const texts = (result: Awaited<ReturnType<typeof runLinter>>, lng: string, ext = 'json') => issuesOf(result, lng, ext).map(i => i.text)

describe('interpolationNames', () => {
  it('reads names, formats, nested paths and the unescape prefix', () => {
    expect(interpolationNames('Hi {{name}}, {{ user.name }} has {{val, number(minimumFractionDigits: 2)}}', {})).toEqual(['name', 'user.name', 'val'])
    expect(interpolationNames('{{- name}} and {{-html}} and {{first-name}}', {})).toEqual(['name', 'html', 'first-name'])
    expect(interpolationNames('Hi [[name]]', { interpolationPrefix: '[[', interpolationSuffix: ']]' })).toEqual(['name'])
  })

  it('reads like the i18next Interpolator: any name, unescaped only with `-` right after the prefix', () => {
    expect(interpolationNames('{{größe}} {{first name}} {{ }}', {})).toEqual(['größe', 'first name'])
    // i18next looks up the variable "- name" here, not "name"
    expect(interpolationNames('{{ - name}}', {})).toEqual(['- name'])
  })

  it('reads no variable from ICU braces in a project without extract.messageFormat', () => {
    expect(interpolationNames('{count, plural, one {{count} item} other {{count} items}}', {})).toEqual([])
  })
})

describe('lint: placeholders across locales (i18next format)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockImplementation(async (pattern: string | string[]) => {
      const p = String(pattern)
      if (!p.startsWith('locales/')) return [SRC]
      return [out('en', p.endsWith('.yaml') ? 'yaml' : 'json')]
    })
  })

  it('accepts matching placeholders: formats, spacing, unescaping, nesting, Trans tags, plurals, context', async () => {
    const result = await lint(config(['en', 'de', 'ru', 'ar', 'ja']), {
      en: {
        greeting: 'Hello {{name}}',
        total: 'Total: {{val, number}}',
        html: 'Hi {{- name}}',
        terms: 'See $t(legal.terms) and $t(common:brand)',
        rich: 'Click <0>here</0> or <1/>',
        items_one: 'One item',
        items_other: '{{count}} items',
        friend_male: '{{name}} is his friend',
        place_ordinal_one: '{{count}}st',
        place_ordinal_other: '{{count}}th',
      },
      de: {
        greeting: 'Hallo {{ name }}',
        total: 'Summe: {{val, currency(EUR)}}',
        html: 'Hallo {{-name}}',
        terms: 'Siehe $t(common:brand) und $t(legal.terms)',
        rich: '<1/> oder <0>hier</0> klicken',
        items_one: 'Ein Element',
        items_other: '{{count}} Elemente',
        friend_male: '{{name}} ist sein Freund',
        place_ordinal_other: '{{count}}.',
      },
      ru: { items_one: '{{count}} элемент', items_few: '{{count}} элемента', items_many: '{{count}} элементов', items_other: '{{count}} элемента' },
      ar: { items_zero: 'لا عناصر', items_one: 'عنصر واحد', items_two: 'عنصران', items_few: '{{count}} عناصر', items_many: '{{count}} عنصرًا', items_other: '{{count}} عنصر' },
      ja: { items_other: '{{count}}個のアイテム' },
    })
    expect(result.files).toEqual({})
    expect(result.success).toBe(true)
  })

  it('reports a renamed interpolation as a warning on the line of the key', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { title: 'Welcome', greeting: 'Hello {{name}}' },
      de: { title: 'Willkommen', greeting: 'Hallo {{nom}}' },
    })
    expect(issuesOf(result, 'de')).toEqual([{
      text: 'greeting: missing {{name}}, unexpected {{nom}} (compared with "en")',
      line: 3,
      type: 'placeholder',
      severity: 'warning',
    }])
    // a warning by default: existing CI runs keep passing
    expect(result.success).toBe(true)
  })

  it('reports a dropped $t() reference and a dropped Trans tag', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { terms: 'Read $t(legal.terms) first', rich: 'Click <0>here</0>' },
      de: { terms: 'Zuerst die Bedingungen lesen', rich: 'Hier klicken' },
    })
    expect(texts(result, 'de')).toEqual([
      'terms: missing $t(legal.terms) (compared with "en")',
      'rich: missing <0> (compared with "en")',
    ])
  })

  it('reports a renamed or dropped component tag, but not the basic HTML react-i18next keeps', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { bold: 'Click <bold>here</bold>', link: 'Read the <a href="/terms">terms</a>', basic: 'One<br/>two <strong>three</strong>' },
      de: { bold: 'Klick <fett>hier</fett>', link: 'Die Bedingungen lesen', basic: 'Eins zwei <i>drei</i><p>vier</p>' },
    })
    expect(texts(result, 'de')).toEqual([
      'bold: missing <bold>, unexpected <fett> (compared with "en")',
      'link: missing <a> (compared with "en")',
    ])
  })

  it('reads extract.transKeepBasicHtmlNodesFor', async () => {
    const result = await lint(config(['en', 'de'], {}, { transKeepBasicHtmlNodesFor: ['br', 'em'] }), {
      en: { text: 'One<br/>two <strong>three</strong>' },
      de: { text: 'Eins zwei <em>drei</em>' },
    })
    expect(texts(result, 'de')).toEqual(['text: missing <strong> (compared with "en")'])
  })

  it('groups only the plural suffixes i18next appends, not numbered keys', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { step_1: 'Enter {{a}}', step_2: 'Enter {{b}}' },
      de: { step_1: '{{b}} eingeben', step_2: '{{a}} eingeben' },
    })
    expect(texts(result, 'de')).toEqual([
      'step_1: missing {{a}}, unexpected {{b}} (compared with "en")',
      'step_2: missing {{b}}, unexpected {{a}} (compared with "en")',
    ])
  })

  it('compares plural forms as a group', async () => {
    const result = await lint(config(['en', 'de', 'ru']), {
      en: { items_one: 'One item', items_other: '{{count}} items' },
      // {{count}} left out of every form
      de: { items_one: 'Ein Element', items_other: 'Elemente' },
      // a form the primary language lacks brings in an unknown variable
      ru: { items_one: '{{count}} элемент', items_few: '{{count}} {{what}}', items_many: '{{count}} элементов', items_other: '{{count}} элемента' },
    })
    expect(texts(result, 'de')).toEqual(['items: missing {{count}} (compared with "en")'])
    expect(texts(result, 'ru')).toEqual(['items: unexpected {{what}} (compared with "en")'])
  })

  it('does not report missing placeholders of a partly translated plural, but still unexpected ones', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { items_one: '{{count}} item', items_other: '{{count}} items', files_one: 'One file', files_other: '{{count}} files' },
      de: { items_one: 'Ein Element', items_other: '', files_one: '{{anzahl}} Datei', files_other: '' },
    })
    expect(texts(result, 'de')).toEqual(['files: unexpected {{anzahl}} (compared with "en")'])
  })

  it('compares context keys exactly and skips keys only one side has, empty values and non-strings', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { friend: 'A friend', friend_female: '{{name}} is her friend', onlyEn: 'Hi {{name}}', empty: 'Hi {{name}}', count: 3 },
      de: { friend: 'Ein Freund', friend_female: 'Sie ist ihre Freundin', onlyDe: 'Hallo {{name}}', empty: '', count: 3 },
    })
    expect(texts(result, 'de')).toEqual(['friend_female: missing {{name}} (compared with "en")'])
  })

  it('walks nested keys and reports their line', async () => {
    const result = await lint(config(['en', 'de']), {
      en: { page: { header: { title: 'Hi {{name}}' } } },
      de: { page: { header: { title: 'Hallo' } } },
    })
    expect(issuesOf(result, 'de')).toEqual([expect.objectContaining({ text: 'page.header.title: missing {{name}} (compared with "en")', line: 4 })])
  })

  it('reads a custom interpolation prefix and suffix', async () => {
    const result = await lint(config(['en', 'de'], {}, { interpolationPrefix: '[[', interpolationSuffix: ']]' }), {
      en: { greeting: 'Hello [[name]]' },
      de: { greeting: 'Hallo [[nom]]' },
    })
    expect(texts(result, 'de')).toEqual(['greeting: missing [[name]], unexpected [[nom]] (compared with "en")'])
  })

  it('checks YAML files, without a line number', async () => {
    const result = await lint(config(['en', 'de'], {}, { output: 'locales/{{language}}/{{namespace}}.yaml' }), {
      en: 'greeting: Hello {{name}}\n',
      de: 'greeting: Hallo\n',
    }, { ext: 'yaml' })
    expect(issuesOf(result, 'de', 'yaml')).toEqual([expect.objectContaining({ text: 'greeting: missing {{name}} (compared with "en")', line: 0 })])
  })

  it("fails the run with checkTranslationPlaceholders: 'error' and is silent with 'off'", async () => {
    const resources = { en: { greeting: 'Hello {{name}}' }, de: { greeting: 'Hallo' } }
    const failing = await lint(config(['en', 'de'], { checkTranslationPlaceholders: 'error' }), resources)
    expect(issuesOf(failing, 'de')).toEqual([expect.objectContaining({ severity: 'error' })])
    expect(failing.success).toBe(false)

    const off = await lint(config(['en', 'de'], { checkTranslationPlaceholders: 'off' }), resources)
    expect(off.files).toEqual({})
  })

  it('skips a translation file that does not parse', async () => {
    const result = await lint(config(['en', 'de']), { en: { greeting: 'Hello {{name}}' }, de: '{ "greeting": ' })
    expect(result.files).toEqual({})
  })

  it('leaves ICU projects to the ICU check', async () => {
    const result = await lint(config(['en', 'de'], {}, { messageFormat: 'icu' }), {
      en: { greeting: 'Hello {name}' },
      de: { greeting: 'Hallo {name}' },
    })
    expect(result.files).toEqual({})
  })
})

describe('lint: checkInterpolationParams with unescaped interpolation', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([SRC])
  })

  it('reads {{-name}} as name, not as a parameter "-name"', async () => {
    vol.fromJSON({ [SRC]: "t('Hi {{-name}}', { name })" })
    const result = await runLinter(config(['en']))
    expect(result.files).toEqual({})
  })

  it('reports a missing parameter of {{- name}}', async () => {
    vol.fromJSON({ [SRC]: "t('Hi {{- name}}', {})" })
    const result = await runLinter(config(['en']))
    expect(result.files[SRC]?.map(i => i.text)).toEqual(['Interpolation parameter "name" was not provided'])
  })
})
