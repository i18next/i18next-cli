import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'
import { toMessageFormatPlaceholders } from '../src/utils/message-format'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (messageFormat: 'i18next' | 'icu' | 'mf2'): I18nextToolkitConfig => ({
  locales: ['en', 'ru'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
    messageFormat,
  },
})

async function run (code: string, messageFormat: 'i18next' | 'icu' | 'mf2' = 'icu', files: Record<string, string> = {}) {
  vol.fromJSON({ '/src/App.tsx': code, ...files })
  const results = await extract(config(messageFormat))
  const values = (lng: string) => results.find(r => pathEndsWith(r.path, `/locales/${lng}/translation.json`))?.newTranslations
  return { en: values('en'), ru: values('ru') }
}

describe('extract with messageFormat icu / mf2', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('writes one key per t() plural instead of plural suffix keys', async () => {
    const { en, ru } = await run(`
      t('photos', '{count, plural, one {# photo} other {# photos}}', { count })
      t('rows', { count, defaultValue: '{count, plural, one {{count} row} other {{count} rows}}' })
    `)
    expect(en).toEqual({
      photos: '{count, plural, one {# photo} other {# photos}}',
      rows: '{count, plural, one {{count} row} other {{count} rows}}',
    })
    expect(ru).toEqual({ photos: '', rows: '' })
  })

  it('still writes plural suffix keys for the i18next format', async () => {
    const { ru } = await run("t('photos', 'photos', { count })", 'i18next')
    expect(Object.keys(ru!).sort()).toEqual(['photos_few', 'photos_many', 'photos_one', 'photos_other'])
  })

  it('writes no context keys, static or dynamic', async () => {
    const { en } = await run(`
      t('friend', '{context, select, male {A boyfriend} other {A friend}}', { context: gender })
      t('greet', 'Hello', { context: 'formal' })
      t('tasks', '{count, plural, one {# task} other {# tasks}}', { context: 'done', count })
    `)
    expect(en).toEqual({
      friend: '{context, select, male {A boyfriend} other {A friend}}',
      greet: 'Hello',
      tasks: '{count, plural, one {# task} other {# tasks}}',
    })
  })

  it('reads keys from comments without suffixes', async () => {
    const { en } = await run("// t('photos', '{count, plural, one {# photo} other {# photos}}', { count })")
    expect(en).toEqual({ photos: '{count, plural, one {# photo} other {# photos}}' })
  })

  it('does not treat $t() as nesting', async () => {
    const { en } = await run("t('a', 'See $t(b)')")
    expect(en).toEqual({ a: 'See $t(b)' })
  })

  it('writes <Trans> children with ICU placeholders, and one key with count or context', async () => {
    const { en, ru } = await run(`
      const x = <>
        <Trans i18nKey="welcome">Welcome, <strong>{{name}}</strong>!</Trans>
        <Trans i18nKey="items" count={count}>{{count}} items</Trans>
        <Trans i18nKey="friend" context={gender}>A friend</Trans>
        <Trans>Hello {{name}}</Trans>
      </>
    `)
    expect(en).toEqual({
      welcome: 'Welcome, <strong>{name}</strong>!',
      items: '{count} items',
      friend: 'A friend',
      // the key stays what react-i18next builds at runtime
      'Hello {{name}}': 'Hello {name}',
    })
    expect(ru).toEqual({ welcome: '', items: '', friend: '', 'Hello {{name}}': '' })
  })

  it('writes <Trans> children with MF2 placeholders', async () => {
    const { en } = await run('<Trans i18nKey="welcome">Welcome, <strong>{{name}}</strong>!</Trans>', 'mf2')
    expect(en).toEqual({ welcome: 'Welcome, <strong>{$name}</strong>!' })
  })

  it('converts {{name, format}} placeholders', () => {
    expect(toMessageFormatPlaceholders('{{ total, number }} of {{max}}', config('icu'))).toBe('{total, number} of {max}')
    expect(toMessageFormatPlaceholders('{{ total, number }} of {{max}}', config('mf2'))).toBe('{$total :number} of {$max}')
    expect(toMessageFormatPlaceholders('{{max}}', config('i18next'))).toBe('{{max}}')
  })

  it('escapes the text around the placeholders', () => {
    // in ICU an apostrophe before { quotes it ('{name}' would render as the text {name}), and literal braces are quoted
    expect(toMessageFormatPlaceholders("File '{{name}}' not found", config('icu'))).toBe("File ''{name}' not found")
    expect(toMessageFormatPlaceholders("Don't use {braces}", config('icu'))).toBe("Don't use '{'braces'}'")
    expect(toMessageFormatPlaceholders("Click '<1>Save</1>'", config('icu'))).toBe("Click ''<1>Save</1>'")
    // in MF2 braces and backslashes are escaped, apostrophes are text
    expect(toMessageFormatPlaceholders("File '{{name}}' {x} \\", config('mf2'))).toBe("File '{$name}' \\{x\\} \\\\")
  })

  it('extracts IcuTrans: i18nKey, or else defaultTranslation as the key', async () => {
    const { en } = await run(`
      import { IcuTrans } from 'react-i18next'
      const x = <>
        <IcuTrans i18nKey="invite" defaultTranslation="We invited <0>{user}</0>." content={[{ type: 'strong' }]} values={{ user }} />
        <IcuTrans defaultTranslation="Hello {name}" content={[]} values={{ name }} />
      </>
    `)
    expect(en).toEqual({ invite: 'We invited <0>{user}</0>.', 'Hello {name}': 'Hello {name}' })
  })

  it('extracts IcuTransWithoutContext and a renamed IcuTrans import', async () => {
    const { en } = await run(`
      import { IcuTransWithoutContext } from 'react-i18next/IcuTransWithoutContext'
      import { IcuTrans as Message } from 'react-i18next'
      const x = <>
        <IcuTransWithoutContext i18nKey="server" defaultTranslation="Hello <0>{name}</0>" content={[{ type: 'b' }]} values={{ name }} />
        <Message i18nKey="renamed" defaultTranslation="Renamed {name}" content={[]} values={{ name }} />
      </>
    `)
    expect(en).toEqual({ server: 'Hello <0>{name}</0>', renamed: 'Renamed {name}' })
  })

  it('puts IcuTrans with ns into that namespace', async () => {
    vol.fromJSON({ '/src/App.tsx': '<IcuTrans i18nKey="title" ns="common" defaultTranslation="Title" content={[]} />' })
    const results = await extract(config('icu'))
    expect(results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))?.newTranslations).toEqual({ title: 'Title' })
  })

  it('builds the messages of the icu.macro components like the macro does', async () => {
    const { en } = await run(`
      import { Trans, Plural, Select, SelectOrdinal } from 'react-i18next/icu.macro'
      const x = <>
      <Trans i18nKey="welcome">Welcome, <strong>{name}</strong>!</Trans>
      <Trans i18nKey="trainers">Trainers: { trainersCount, number }</Trans>
      <Trans i18nKey="photos">You have {plural\`\${count}, one {# photo} other {# photos}\`}</Trans>
      <Plural i18nKey="items" count={itemsCount} $0="There are no items." one="There is # item." other="There are # items." />
      <Plural
        i18nKey="table"
        count={itemsCount}
        values={{ location: 'table' }}
        $0={<Trans>There is <strong>no</strong> item on the <i>{location}</i>.</Trans>}
        other={<Trans>There are <strong>#</strong> items on the <i>{location}</i>.</Trans>}
      />
      <Select i18nKey="pronoun" switch={gender} male="He avoids bugs." female="She avoids bugs." other="They avoid bugs." />
      <SelectOrdinal i18nKey="place" count={position} one="#st" two="#nd" few="#rd" other="#th" />
      <Trans>Caught on {date\`\${catchDate}, short\`}</Trans>
      </>
    `)
    expect(en).toEqual({
      welcome: 'Welcome, <0>{name}</0>!',
      trainers: 'Trainers: {trainersCount, number}',
      photos: 'You have {count, plural, one {# photo} other {# photos}}',
      items: '{itemsCount, plural,  =0 {There are no items.} one {There is # item.} other {There are # items.}}',
      table: '{itemsCount, plural,  =0 {There is <0>no</0> item on the <1>{location}</1>.} other {There are <2>#</2> items on the <3>{location}</3>.}}',
      pronoun: '{gender, select,  male {He avoids bugs.} female {She avoids bugs.} other {They avoid bugs.}}',
      place: '{position, selectordinal,  one {#st} two {#nd} few {#rd} other {#th}}',
      // no i18nKey: the macro's message is the key
      'Caught on {catchDate, date, short}': 'Caught on {catchDate, date, short}',
    })
  })

  it('reads the defaults of an icu.macro <Trans> as JSX like the macro does', async () => {
    const { en } = await run(`
      import { Trans as T } from 'react-i18next/icu.macro'
      const x = <>
        <T i18nKey="caught" defaults="Caught on <strong>{ catchDate, date, short }</strong>!" />
        <T i18nKey="empty" defaults="Trainers: <strong>{ trainersCount, number }</strong>!" components={[]} />
      </>
    `)
    // an empty message falls back to the key, like any key without a default value
    expect(en).toEqual({ caught: 'Caught on <0>{catchDate, date, short}</0>!', empty: 'empty' })
  })

  it('treats <Trans> as react-i18next Trans when it is not imported from icu.macro', async () => {
    const { en } = await run(`
      import { Trans } from 'react-i18next'
      <Trans i18nKey="welcome">Welcome, <strong>{{name}}</strong>!</Trans>
    `)
    expect(en).toEqual({ welcome: 'Welcome, <strong>{name}</strong>!' })
  })

  it('removes plural suffix keys of an earlier i18next extraction', async () => {
    const { en } = await run("t('photos', '{count, plural, one {# photo} other {# photos}}', { count })", 'icu', {
      '/locales/en/translation.json': JSON.stringify({ photos_one: '{count, plural, one {# photo} other {# photos}}', photos_other: '{count, plural, one {# photo} other {# photos}}' }),
    })
    expect(en).toEqual({ photos: '{count, plural, one {# photo} other {# photos}}' })
  })
})
