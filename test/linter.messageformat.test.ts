import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter, runLinterCli } from '../src/linter'
import { pluralCategories } from '../src/utils/message-format'
import type { I18nextToolkitConfig } from '../src/index'
import { normalize, resolve } from 'node:path'

// Platform paths, like status.test.ts: memfs keys as the linter resolves them, issue keys as getOutputPath
// normalizes them, so the tests pass on Windows too
const SRC = resolve(process.cwd(), 'src/App.tsx')
const abs = (p: string) => resolve(process.cwd(), p)
const out = (lng: string) => normalize(`locales/${lng}/translation.json`)

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (messageFormat: 'i18next' | 'icu' | 'mf2', locales: string[], extra: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
  locales,
  extract: {
    input: ['src/**/*.tsx'],
    output: 'locales/{{language}}/{{namespace}}.json',
    messageFormat,
    ...extra,
  },
})

// Writes one translation.json per locale and returns the lint result
async function lint (cfg: I18nextToolkitConfig, resources: Record<string, Record<string, any>>, code = '') {
  const files: Record<string, string> = { [SRC]: code }
  for (const [lng, values] of Object.entries(resources)) {
    files[abs(`locales/${lng}/translation.json`)] = JSON.stringify(values, null, 2)
  }
  vol.fromJSON(files)
  return runLinter(cfg)
}

const texts = (result: Awaited<ReturnType<typeof runLinter>>, lng: string) =>
  (result.files[out(lng)] ?? []).map(i => i.text)

describe('pluralCategories (same rule as Locize)', () => {
  it('requires the categories whole numbers below one million select, allows all CLDR categories', () => {
    expect(pluralCategories('ru', 'cardinal')?.required.sort()).toEqual(['few', 'many', 'one', 'other'])
    expect(pluralCategories('fr', 'cardinal')?.required.sort()).toEqual(['one', 'other'])
    expect(pluralCategories('fr', 'cardinal')?.allowed).toContain('many')
    expect(pluralCategories('cs', 'cardinal')?.required.sort()).toEqual(['few', 'one', 'other'])
    expect(pluralCategories('cs', 'cardinal')?.allowed).toContain('many')
    expect(pluralCategories('ar', 'cardinal')?.required.sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero'])
    expect(pluralCategories('en', 'ordinal')?.required.sort()).toEqual(['few', 'one', 'other', 'two'])
  })

  it('knows nothing about a locale Intl does not support', () => {
    expect(pluralCategories('xx', 'cardinal')).toBeUndefined()
    expect(pluralCategories('E', 'cardinal')).toBeUndefined()
  })
})

describe('lint with messageFormat: icu', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockImplementation(async (pattern: string | string[]) =>
      String(pattern).startsWith('locales/') ? [out('en')] : [SRC])
  })

  it('accepts valid messages in en, ru, fr, cs and ar', async () => {
    const result = await lint(config('icu', ['en', 'ru', 'fr', 'cs', 'ar']), {
      en: { photos: '{count, plural, =0 {No photos} one {# photo} other {# photos}}', greeting: 'Hello {name}', place: '{pos, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}' },
      ru: { photos: '{count, plural, =0 {Нет фото} one {# фото} few {# фото} many {# фото} other {# фото}}', greeting: 'Привет, {name}' },
      fr: { photos: '{count, plural, one {# photo} other {# photos}}', greeting: 'Bonjour {name}' },
      cs: { photos: '{count, plural, one {# fotka} few {# fotky} other {# fotek}}', greeting: 'Ahoj {name}' },
      ar: { photos: '{count, plural, zero {لا صور} one {صورة} two {صورتان} few {# صور} many {# صورة} other {# صورة}}', greeting: 'مرحبا {name}' },
    })
    expect(result.files).toEqual({})
    expect(result.success).toBe(true)
  })

  it('allows the categories a locale knows but whole numbers up to 1000 never select (fr many, cs many)', async () => {
    const result = await lint(config('icu', ['en', 'fr', 'cs']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}' },
      fr: { photos: '{count, plural, one {# photo} many {# de photos} other {# photos}}' },
      cs: { photos: '{count, plural, one {# fotka} few {# fotky} many {# fotky} other {# fotek}}' },
    })
    expect(result.files).toEqual({})
  })

  it('counts a category as present when exact selectors cover every whole number it is used for', async () => {
    const result = await lint(config('icu', ['en', 'fr', 'ar', 'ru']), {
      en: { photos: '{count, plural, =0 {No photos} =1 {One photo} other {# photos}}' },
      fr: { photos: '{count, plural, =0 {Aucune photo} =1 {Une photo} other {# photos}}' },
      ar: { photos: '{count, plural, =0 {لا صور} one {صورة} =2 {صورتان} few {# صور} many {# صورة} other {# صورة}}' },
      // ru `one` is also 21, 31, ..., so =1 does not cover it
      ru: { photos: '{count, plural, =0 {Нет фото} =1 {Одно фото} few {# фото} many {# фото} other {# фото}}' },
    })
    expect(Object.keys(result.files)).toEqual([out('ru')])
    expect(texts(result, 'ru')).toEqual(['photos: plural {count} is missing the "ru" categories one'])
  })

  it('reports a syntax error with file, key, parser message and line', async () => {
    const result = await lint(config('icu', ['en']), {
      en: { ok: 'Fine', greeting: 'Hello {name' },
    })
    expect(result.success).toBe(false)
    const [issue] = result.files[out('en')]
    expect(issue.text).toBe('greeting: ICU syntax error: EXPECT_ARGUMENT_CLOSING_BRACE at column 7')
    expect(issue.type).toBe('messageFormat')
    expect(issue.line).toBe(3)
  })

  it('hints at i18next interpolation when a message with {{ does not parse', async () => {
    const result = await lint(config('icu', ['en']), { en: { greeting: 'Hello {{name}}' } })
    expect(texts(result, 'en')[0]).toContain('i18next interpolation like {{name}} does not work with ICU, use {name}')
  })

  it('requires a plural to have an other case (a syntax error at runtime)', async () => {
    const result = await lint(config('icu', ['en']), { en: { photos: '{count, plural, one {# photo}}' } })
    expect(texts(result, 'en')).toEqual(['photos: ICU syntax error: MISSING_OTHER_CLAUSE at column 30'])
  })

  it('reports a renamed and a missing argument against the primary language', async () => {
    const result = await lint(config('icu', ['en', 'de']), {
      en: { greeting: 'Hello {name}, you have {count, plural, one {# message} other {# messages}}' },
      de: { greeting: 'Hallo {nmae}, du hast # Nachrichten' },
    })
    expect(texts(result, 'de')).toEqual(['greeting: arguments differ from "en": missing {name}, {count}, unexpected {nmae}'])
    expect(texts(result, 'en')).toEqual([])
  })

  it('does not count # as an argument, and skips empty (untranslated) values', async () => {
    const result = await lint(config('icu', ['en', 'de']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}', later: 'Hello {name}' },
      de: { photos: '{count, plural, one {ein Foto} other {{count} Fotos}}', later: '' },
    })
    expect(result.files).toEqual({})
  })

  it('reports the ru categories that whole numbers need', async () => {
    const result = await lint(config('icu', ['en', 'ru']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}' },
      ru: { photos: '{count, plural, one {# фото} other {# фото}}' },
    })
    expect(texts(result, 'ru')).toEqual(['photos: plural {count} is missing the "ru" categories few, many'])
  })

  it('reads a language code with _ like Intl, so ru_RU needs the ru categories', async () => {
    const result = await lint(config('icu', ['en', 'ru_RU']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}' },
      ru_RU: { photos: '{count, plural, one {# фото} other {# фото}}' },
    })
    expect(texts(result, 'ru_RU')).toEqual(['photos: plural {count} is missing the "ru_RU" categories few, many'])
  })

  it('reports categories a locale does not use, like zero or few in en', async () => {
    const result = await lint(config('icu', ['en']), {
      en: { photos: '{count, plural, zero {No photos} one {# photo} few {# photos} other {# photos}}' },
    })
    expect(texts(result, 'en')).toEqual(['photos: plural {count} has categories "en" does not use: zero, few'])
  })

  it('reports the missing ar categories', async () => {
    const result = await lint(config('icu', ['en', 'ar']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}' },
      ar: { photos: '{count, plural, one {صورة} few {# صور} many {# صورة} other {# صورة}}' },
    })
    expect(texts(result, 'ar')).toEqual(['photos: plural {count} is missing the "ar" categories zero, two'])
  })

  it('checks selectordinal against the ordinal categories', async () => {
    const result = await lint(config('icu', ['en']), {
      en: { place: '{pos, selectordinal, one {#st} few {#rd} other {#th}}' },
    })
    expect(texts(result, 'en')).toEqual(['place: selectordinal {pos} is missing the "en" categories two'])
  })

  it('checks a plural nested in a select, and its arguments', async () => {
    const en = '{gender, select, female {She has {count, plural, one {# photo} other {# photos}}} other {They have {count, plural, one {# photo} other {# photos}}}}'
    const result = await lint(config('icu', ['en', 'ru']), {
      en: { photos: en },
      ru: { photos: '{gender, select, female {У неё {count, plural, one {# фото} few {# фото} many {# фото} other {# фото}}} other {У них {num, plural, one {# фото} other {# фото}}}}' },
    })
    expect(texts(result, 'ru')).toEqual([
      'photos: arguments differ from "en": unexpected {num}',
      'photos: plural {num} is missing the "ru" categories few, many',
    ])
  })

  it('requires only other for a locale Intl does not know', async () => {
    const result = await lint(config('icu', ['en', 'xx']), {
      en: { photos: '{count, plural, one {# photo} other {# photos}}' },
      xx: { photos: '{count, plural, few {# photos} other {# photos}}' },
    })
    expect(result.files).toEqual({})
  })

  it('reads nested keys and reports them with the key separator', async () => {
    const result = await lint(config('icu', ['en']), { en: { gallery: { photos: '{count, plural, one {# photo} few {x} other {# photos}}' } } })
    const [issue] = result.files[out('en')]
    expect(issue.text).toBe('gallery.photos: plural {count} has categories "en" does not use: few')
    expect(issue.line).toBe(3)
  })

  it('lints a single file per language (output without {{namespace}})', async () => {
    vol.fromJSON({
      [SRC]: '',
      [abs('locales/en.json')]: JSON.stringify({ greeting: 'Hello {name}' }),
      [abs('locales/de.json')]: JSON.stringify({ greeting: 'Hallo {nmae}' }),
    })
    const result = await runLinter(config('icu', ['en', 'de'], { output: 'locales/{{language}}.json' }))
    expect(result.files[normalize('locales/de.json')].map(i => i.text)).toEqual(['greeting: arguments differ from "en": missing {name}, unexpected {nmae}'])
  })

  it('does not read ICU braces as i18next interpolation in t() calls', async () => {
    const code = `
      t('rows', '{count, plural, one {{count} row} other {{count} rows}}', { count })
      t('friend', '{gender, select, male {{name}} other {{name}}}', { gender, name })
    `
    const result = await lint(config('icu', ['en']), { en: {} }, code)
    expect(result.files).toEqual({})

    // the i18next format reads `male {{name}}` as {{name}} interpolation and misses `gender`
    vol.reset()
    const i18nextResult = await lint(config('i18next', ['en']), { en: {} }, code)
    expect(i18nextResult.files[SRC]?.map(i => i.text)).toContain('Parameter "gender" is not used in translation string')
  })

  it('checks ICU arguments of t() calls against the values passed', async () => {
    const code = `
      t('greeting', 'Hello {name}', { nmae })
      t('photos', { count })
    `
    const result = await lint(config('icu', ['en']), { en: { photos: '{count, plural, one {# photo} other {# photos}}' } }, code)
    expect(result.files[SRC].map(i => i.text)).toEqual([
      'Interpolation parameter "name" was not provided',
      'Parameter "nmae" is not used in translation string',
    ])
  })

  it('leaves translation files alone with the default i18next format', async () => {
    const result = await lint(config('i18next', ['en']), { en: { greeting: 'Hello {name' } })
    expect(result.files).toEqual({})
  })

  it('prints translation file issues as "ICU message" in the CLI output', async () => {
    const logs: string[] = []
    const logger = { info: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as any))
    vol.fromJSON({ [SRC]: '', [abs('locales/en/translation.json')]: '{\n  "greeting": "Hello {name"\n}' })

    await runLinterCli(config('icu', ['en']), { logger: logger as any })

    const output = logs.join('\n')
    expect(output).toContain(out('en'))
    expect(output).toContain('2: Error: ICU message: "greeting: ICU syntax error: EXPECT_ARGUMENT_CLOSING_BRACE at column 7"')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

describe('lint with messageFormat: mf2', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockImplementation(async (pattern: string | string[]) =>
      String(pattern).startsWith('locales/') ? [out('en')] : [SRC])
  })

  const plural = (...variants: string[]) => `.input {$count :number}\n.match $count\n${variants.join('\n')}`

  it('accepts valid messages in en and ru, with * as other and exact number keys', async () => {
    const result = await lint(config('mf2', ['en', 'ru']), {
      en: { photos: plural('0 {{No photos}}', 'one {{{$count} photo}}', '* {{{$count} photos}}'), greeting: 'Hello {$name}' },
      ru: { photos: plural('one {{{$count} фото}}', 'few {{{$count} фото}}', 'many {{{$count} фото}}', '* {{{$count} фото}}'), greeting: 'Привет, {$name}' },
    })
    expect(result.files).toEqual({})
  })

  it('counts exact number keys towards a category like ICU =1', async () => {
    const result = await lint(config('mf2', ['en']), {
      en: { photos: plural('0 {{No photos}}', '1 {{One photo}}', '* {{{$count} photos}}') },
    })
    expect(result.files).toEqual({})
  })

  it('reports syntax and data model errors', async () => {
    const result = await lint(config('mf2', ['en']), {
      en: { greeting: 'Hello {$name', photos: plural('one {{{$count} photo}}') },
    })
    const issues = texts(result, 'en')
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatch(/^greeting: MF2 syntax error: /)
    expect(issues[1]).toMatch(/^photos: MF2 syntax error: .*missing-fallback/)
  })

  it('reports a renamed variable against the primary language', async () => {
    const result = await lint(config('mf2', ['en', 'de']), {
      en: { greeting: 'Hello {$name}' },
      de: { greeting: 'Hallo {$nmae}' },
    })
    expect(texts(result, 'de')).toEqual(['greeting: arguments differ from "en": missing {$name}, unexpected {$nmae}'])
  })

  it('warns about a space inside {{ }} the primary language does not have', async () => {
    const result = await lint(config('mf2', ['en', 'de', 'fr']), {
      en: { photos: plural('one {{{$count} photo}}', '* {{{$count} photos}}') },
      de: { photos: plural('one {{ {$count} Foto}}', '* {{{$count} Fotos}}') },
      fr: { photos: plural('one {{{$count} photo}}', '* {{{$count} photos}}') },
    })
    expect(result.success).toBe(true)
    expect(Object.keys(result.files)).toEqual([out('de')])
    expect(result.files[out('de')]).toEqual([expect.objectContaining({
      text: 'photos: whitespace at the start or end of a pattern differs from "en", MF2 shows it as text',
      severity: 'warning',
    })])
  })

  it('reports the ru categories that whole numbers need, and unused en categories', async () => {
    const result = await lint(config('mf2', ['en', 'ru']), {
      en: { photos: plural('one {{{$count} photo}}', 'few {{{$count} photos}}', '* {{{$count} photos}}') },
      ru: { photos: plural('one {{{$count} фото}}', '* {{{$count} фото}}') },
    })
    expect(texts(result, 'en')).toEqual(['photos: plural {$count} has categories "en" does not use: few'])
    expect(texts(result, 'ru')).toEqual(['photos: plural {$count} is missing the "ru" categories few, many'])
  })

  it('checks select=ordinal through a .local declaration, and skips select=exact', async () => {
    const result = await lint(config('mf2', ['en']), {
      en: {
        place: '.input {$pos :number}\n.local $n = {$pos :integer select=ordinal}\n.match $n\none {{{$pos}st}}\nfew {{{$pos}rd}}\n* {{{$pos}th}}',
        exact: '.input {$count :number select=exact}\n.match $count\n1 {{one}}\n* {{many}}',
      },
    })
    expect(texts(result, 'en')).toEqual(['place: ordinal {$n} is missing the "en" categories two'])
  })

  it('does not read MF2 variants as i18next interpolation in t() calls', async () => {
    const code = `
      t('photos', '.input {$count :number} .match $count one {{{$count} photo}} * {{{$count} photos}}', { count })
      t('greeting', 'Hello {$name}', { nmae })
    `
    const result = await lint(config('mf2', ['en']), { en: {} }, code)
    expect(result.files[SRC].map(i => i.text)).toEqual([
      'Interpolation parameter "name" was not provided',
      'Parameter "nmae" is not used in translation string',
    ])
  })
})
