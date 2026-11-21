import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const config: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
  },
}

describe('extractor: keys named like Object.prototype members', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/app.tsx'])
  })

  const read = (path: string) => JSON.parse(vol.readFileSync(path, 'utf-8') as string)

  it('writes constructor, toString and valueOf keys like any other key', async () => {
    vol.fromJSON({
      '/src/app.tsx': `
        t('constructor', 'Builder')
        t('toString', 'Text')
        t('valueOf', 'Value')
        t('page.constructor.title', 'Builder title')
      `,
      '/locales/de/translation.json': JSON.stringify({ toString: 'Text DE' }),
    })

    await runExtractor(config)

    expect(read('/locales/en/translation.json')).toEqual({
      constructor: 'Builder',
      page: { constructor: { title: 'Builder title' } },
      toString: 'Text',
      valueOf: 'Value',
    })
    expect(read('/locales/de/translation.json')).toEqual({
      constructor: '',
      page: { constructor: { title: '' } },
      toString: 'Text DE',
      valueOf: '',
    })
  })

  it('does not report a nesting conflict for constructor or toString segments', async () => {
    vol.fromJSON({
      '/src/app.tsx': `
        t('page.title', 'Title')
        t('page.constructor.title', 'Builder title')
        t('toString.label', 'Label')
      `,
    })

    await runExtractor(config)

    expect(read('/locales/en/translation.json')).toEqual({
      page: { title: 'Title', constructor: { title: 'Builder title' } },
      toString: { label: 'Label' },
    })
  })

  it('keeps a new constructor key with sort: false', async () => {
    vol.fromJSON({
      '/src/app.tsx': `
        t('b', 'B')
        t('a', 'A')
        t('constructor', 'Builder')
      `,
      '/locales/en/translation.json': JSON.stringify({ b: 'B', a: 'A' }),
    })

    await runExtractor({ ...config, extract: { ...config.extract, sort: false } })

    expect(Object.entries(read('/locales/en/translation.json'))).toEqual([
      ['b', 'B'],
      ['a', 'A'],
      ['constructor', 'Builder'],
    ])
  })
})
