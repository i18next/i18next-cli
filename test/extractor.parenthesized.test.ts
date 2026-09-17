import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
  },
}

const run = async (code: string, config = mockConfig) => {
  vol.fromJSON({ '/src/App.tsx': code })
  const results = await extract(config)
  return results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))!.newTranslations
}

describe('extractor: parenthesized expressions (#295)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('extracts a parenthesized key and ternary branches', async () => {
    const translations = await run(`
      t(('plainKey'));
      t(isOpen ? 'openKey' : ('closedKey'));
      t((cond ? ('a') : 'b'));
    `)

    expect(translations).toEqual({
      plainKey: 'plainKey',
      openKey: 'openKey',
      closedKey: 'closedKey',
      a: 'a',
      b: 'b',
    })
  })

  it('extracts through a parenthesized options object', async () => {
    const translations = await run(`
      t('item', ({ count }));
      t('friend', ({ context: gender }));
    `)

    expect(translations).toEqual({
      item_one: 'item',
      item_other: 'item',
      friend: 'friend',
    })
  })

  it('honours parenthesized option values', async () => {
    const translations = await run(`
      t('greeting', { defaultValue: ('Hello') });
      t('label', { context: ('male') });
    `)

    expect(translations).toEqual({
      greeting: 'Hello',
      label_male: 'label',
    })
  })

  it('extracts a parenthesized namespace option', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('nsKey', { ns: ('other') });" })
    const results = await extract(mockConfig)
    const other = results.find(r => pathEndsWith(r.path, '/locales/en/other.json'))

    expect(other?.newTranslations).toEqual({ nsKey: 'nsKey' })
  })

  it('extracts a parenthesized selector and key array', async () => {
    const translations = await run(`
      t((($) => $.sel.key));
      t((['arrOne', 'arrTwo']));
    `)

    expect(translations).toEqual({
      sel: { key: 'sel.key' },
      arrOne: 'arrOne',
      arrTwo: 'arrTwo',
    })
  })

  it('extracts a parenthesized default value argument', async () => {
    const translations = await run("t('welcome', ('Welcome!'));")

    expect(translations).toEqual({ welcome: 'Welcome!' })
  })
})
