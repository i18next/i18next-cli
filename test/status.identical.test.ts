import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const { runStatus } = await import('../src/index')

const config = (locales: string[], status: I18nextToolkitConfig['status'] = {}): I18nextToolkitConfig => ({
  locales,
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
  status,
})

const write = (files: Record<string, string | Record<string, any>>) => vol.fromJSON(Object.fromEntries(
  Object.entries(files).map(([path, content]) => [resolve(process.cwd(), path), typeof content === 'string' ? content : JSON.stringify(content)])
))

describe('status: values identical to the primary language (checkIdentical)', () => {
  let logged: string[]
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => Object.keys(vol.toJSON()).filter(p => p.includes('/src/')))
    logged = []
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { logged.push(args.map(String).join(' ')) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const output = () => logged.join('\n')

  it('shows English copied into de, counts it as translated and keeps the exit code', async () => {
    write({
      'src/app.ts': "t('title'); t('save'); t('cancel')",
      'locales/en/translation.json': { title: 'Welcome', save: 'Save', cancel: 'Cancel' },
      'locales/de/translation.json': { title: 'Willkommen', save: 'Save', cancel: 'Cancel' },
    })

    await runStatus(config(['en', 'de']))

    expect(processExitSpy).not.toHaveBeenCalled()
    expect(output()).toContain('100% (3/3 keys)')
    expect(output()).toContain('2 identical to en')
  })

  it("counts identical values as untranslated with checkIdentical: 'error'", async () => {
    write({
      'src/app.ts': "t('title'); t('save')",
      'locales/en/translation.json': { title: 'Welcome', save: 'Save' },
      'locales/de/translation.json': { title: 'Willkommen', save: 'Save' },
    })

    await runStatus(config(['en', 'de'], { checkIdentical: 'error' })).catch(() => {})

    expect(processExitSpy).toHaveBeenCalledWith(1)
    expect(output()).toContain('50% (1/2 keys)')
    expect(output()).toContain('1 identical to en')
  })

  it("is silent with checkIdentical: 'off'", async () => {
    write({
      'src/app.ts': "t('save')",
      'locales/en/translation.json': { save: 'Save' },
      'locales/de/translation.json': { save: 'Save' },
    })

    await runStatus(config(['en', 'de'], { checkIdentical: 'off' }))

    expect(output()).not.toContain('identical')
  })

  it('skips locales of the primary language and values that stay the same in every language', async () => {
    write({
      'src/app.ts': "t('color'); t('ok'); t('faq'); t('count'); t('site'); t('mail'); t('percent'); t('link')",
      'locales/en/translation.json': {
        color: 'Color',
        ok: 'OK',
        faq: 'FAQ',
        count: '{{count}}',
        site: 'https://www.example.com',
        mail: 'support@example.com',
        percent: '{{val, number}} %',
        link: '<0>{{url}}</0>',
      },
      'locales/en-GB/translation.json': { color: 'Color', ok: 'OK', faq: 'FAQ', count: '{{count}}', site: 'https://www.example.com', mail: 'support@example.com', percent: '{{val, number}} %', link: '<0>{{url}}</0>' },
      'locales/de/translation.json': { color: 'Farbe', ok: 'OK', faq: 'FAQ', count: '{{count}}', site: 'https://www.example.com', mail: 'support@example.com', percent: '{{val, number}} %', link: '<0>{{url}}</0>' },
    })

    await runStatus(config(['en', 'en-GB', 'de']))

    expect(output()).not.toContain('identical')
  })

  it('leaves keys in status.ignoreKeys out', async () => {
    write({
      'src/app.ts': "t('brand'); t('save')",
      'locales/en/translation.json': { brand: 'Acme Cloud', save: 'Save' },
      'locales/de/translation.json': { brand: 'Acme Cloud', save: 'Speichern' },
    })

    await runStatus(config(['en', 'de'], { ignoreKeys: ['brand'] }))

    expect(output()).not.toContain('identical')
  })

  it('marks identical keys in the detailed view, also a plural form the primary language lacks', async () => {
    write({
      'src/app.ts': "t('items', { count: 2 }); t('title')",
      'locales/en/translation.json': { items_one: 'One item', items_other: '{{count}} items', title: 'Welcome' },
      'locales/ru/translation.json': { items_one: '{{count}} элемент', items_few: '{{count}} items', items_many: '{{count}} элементов', items_other: '{{count}} элемента', title: 'Добро пожаловать' },
    })

    await runStatus(config(['en', 'ru']), { detail: 'ru' })

    expect(output()).toContain('≈ items_few  (identical to en)')
    expect(output()).toContain('1 value(s) are identical to "en"')
    expect(processExitSpy).not.toHaveBeenCalled()
  })
})
