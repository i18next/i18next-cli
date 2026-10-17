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

describe('status with messageFormat icu', () => {
  let consoleLogSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => Object.keys(vol.toJSON()).filter(p => p.includes('/src/')))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Process exit called') })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts a plural or context message as one key, without suffix holes', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'ru'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
        messageFormat: 'icu',
      },
    }
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        t('photos', '{count, plural, one {# photo} other {# photos}}', { count })
        t('friend', '{context, select, male {A boyfriend} other {A friend}}', { context: gender })
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        photos: '{count, plural, one {# photo} other {# photos}}',
        friend: '{context, select, male {A boyfriend} other {A friend}}',
      }),
      [resolve(process.cwd(), 'locales/ru/translation.json')]: JSON.stringify({
        photos: '{count, plural, one {# фото} few {# фото} many {# фото} other {# фото}}',
        friend: '{context, select, male {Парень} other {Друг}}',
      }),
    })

    await runStatus(config)

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(logs).toMatch(/ru:.*100% \(2\/2 keys\)/)
  })
})
