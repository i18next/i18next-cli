import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import type { I18nextToolkitConfig } from '../src/index'

// Mock filesystem used by extractor (both sync and promises layers)
vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock glob so extractor only scans test files we create in memfs
vi.mock('glob', () => ({ glob: vi.fn() }))

const { runStatus } = await import('../src/index')

// Covers i18next-cli issue #243:
// When source uses a dynamic context (`t('key', { context: a })` where `a`
// cannot be statically resolved), the extractor only registers the base key
// and tags it as "accepting context". Context variants like `key_a`, `key_b`
// live in the primary translation file. Status must still count them and
// flag the secondary locales' empty values as untranslated.
describe('status: dynamic context variants (issue #243)', () => {
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

  it('flags empty context variants in secondary locales when context is dynamic', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    // Fully dynamic context — extractor can only tag `key` as accepting context.
    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        function render(a: string) {
          const { t } = useTranslation();
          return t('key', { context: a })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        key: 'some text',
        key_a: 'value A',
        key_b: 'value B'
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: 'Ein Text',
        key_a: '',
        key_b: ''
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Expected when process.exit is called
    }

    // Status should report the German locale as incomplete because key_a
    // and key_b have empty values.
    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(logs).toContain('de:')
    // 3 keys total (key, key_a, key_b), 1 translated.
    expect(logs).toMatch(/de:.*1\/3 keys/)
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('does not double-count when a context variant is also an extracted key', async () => {
    // If the dev accidentally has an explicit `t('key_a')` call *and* the
    // dynamic `t('key', { context: a })`, status should only count `key_a`
    // once.
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        function render(a: string) {
          const { t } = useTranslation();
          t('key_a')
          return t('key', { context: a })
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        key: 'some text',
        key_a: 'value A',
        key_b: 'value B'
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: 'Ein Text',
        key_a: 'Wert A',
        key_b: ''
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Expected
    }

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    // 3 total keys (key, key_a, key_b) — key_a counted once even though it's
    // both an extracted key and a discovered context variant.
    expect(logs).toMatch(/de:.*2\/3 keys/)
  })

  it('does not scan primary when no key accepts context', async () => {
    // Sanity check: if the source never uses dynamic context, status behaves
    // exactly as before and does not spuriously count translation-file-only
    // keys as if they were extracted.
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json'
      }
    }

    vol.fromJSON({
      [resolve(process.cwd(), 'src/App.tsx')]: `
        function render() {
          const { t } = useTranslation();
          return t('key')
        }
      `,
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({
        key: 'some text',
        orphan_a: 'orphan A'
      }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({
        key: 'Ein Text'
      })
    })

    try {
      await runStatus(config)
    } catch (e) {
      // Not expected to throw since 1/1 translated
    }

    const logs = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    // Only 1 key (`key`) — orphan_a is not considered because nothing is
    // tagged as accepting context.
    expect(logs).toMatch(/de:.*1\/1 keys/)
  })
})
