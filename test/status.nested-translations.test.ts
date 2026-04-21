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

// Follow-up to issue #241:
// `extract` now preserves keys that are only referenced through `$t(...)`
// nested references in translation values. `status` must also count those
// keys when building its per-locale report, otherwise empty translations
// slip through the check.
describe('status: nested $t() references (follow-up to #241)', () => {
  let consoleLogSpy: any
  let processExitSpy: any

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
      return Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flags empty nested-reference plural forms in secondary locales', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import i18next from 'i18next'
        i18next.t('girlsAndBoys', { girls: 3, boys: 2 })
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        girlsAndBoys: 'They have $t(girls, {"count": {{girls}} }) and $t(boys, {"count": {{boys}} })',
        boys_one: '{{count}} boy',
        boys_other: '{{count}} boys',
        girls_one: '{{count}} girl',
        girls_other: '{{count}} girls'
      }),
      [resolve(process.cwd(), 'locales/pl/translation.json')]: JSON.stringify({
        girlsAndBoys: '',
        boys_one: '',
        boys_few: '',
        boys_many: '',
        boys_other: '',
        girls_one: '',
        girls_few: '',
        girls_many: '',
        girls_other: ''
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Expected when process.exit is called
    }

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    // 1 extracted key (`girlsAndBoys`) + 4 pl plural forms for `boys` + 4 for
    // `girls` = 9 keys total to check for pl. All empty → 0 translated.
    expect(logs).toMatch(/pl:.*0\/9 keys/)
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('counts translated nested-reference values as translated', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import i18next from 'i18next'
        i18next.t('girlsAndBoys', { girls: 3, boys: 2 })
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        girlsAndBoys: 'They have $t(girls, {"count": {{girls}} }) and $t(boys, {"count": {{boys}} })',
        boys_one: '{{count}} boy',
        boys_other: '{{count}} boys',
        girls_one: '{{count}} girl',
        girls_other: '{{count}} girls'
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        girlsAndBoys: 'Sie haben $t(girls, {"count": {{girls}} }) und $t(boys, {"count": {{boys}} })',
        boys_one: '{{count}} Junge',
        boys_other: '{{count}} Jungen',
        girls_one: '{{count}} Mädchen',
        girls_other: '{{count}} Mädchen'
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Not expected when all keys are translated
    }

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    // 1 extracted (`girlsAndBoys`) + 2 de plural forms for `boys` + 2 for
    // `girls` = 5 keys, all translated.
    expect(logs).toMatch(/de:.*5\/5 keys/)
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('flags absent nested-reference keys as absent', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    // Secondary is missing the boys_* / girls_* keys entirely (not even as
    // empty strings). Status should report them as absent.
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        import i18next from 'i18next'
        i18next.t('girlsAndBoys')
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        girlsAndBoys: 'They have $t(girls, {"count": {{girls}} }) and $t(boys, {"count": {{boys}} })',
        boys_one: '{{count}} boy',
        boys_other: '{{count}} boys',
        girls_one: '{{count}} girl',
        girls_other: '{{count}} girls'
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        girlsAndBoys: 'Sie haben ...'
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Expected
    }

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    // 1 translated (girlsAndBoys) / 5 total → 1/5
    expect(logs).toMatch(/de:.*1\/5 keys/)
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })
})
