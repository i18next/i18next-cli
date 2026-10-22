import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runLinter, runLinterCli } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'node:path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const SRC = resolve(process.cwd(), 'src/App.tsx')
const BASELINE = resolve(process.cwd(), 'i18next-lint-baseline.json')

const config = (lint: I18nextToolkitConfig['lint'] = {}): I18nextToolkitConfig => ({
  locales: ['en'],
  extract: { input: ['src/**/*.tsx'], output: 'locales/{{language}}/{{namespace}}.json' },
  lint,
})

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} }
const baselineFile = () => JSON.parse(String(vol.readFileSync(BASELINE)))

describe('lint baseline', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue([SRC])
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Process exit called') })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const legacy = 'const A = () => <div><p>Hello</p><button>Save</button><span>Save</span></div>'

  it('--update-baseline writes the counts per file and issue, and lint then passes', async () => {
    vol.fromJSON({ [SRC]: legacy })

    await runLinterCli(config(), { quiet: true, logger: quietLogger, updateBaseline: true })

    expect(baselineFile()).toEqual({ 'src/App.tsx': { 'hardcoded: Hello': 1, 'hardcoded: Save': 2 } })
    const result = await runLinter(config())
    expect(result).toMatchObject({ success: true, files: {}, existingIssues: 3, staleBaselineEntries: 0, message: 'No new issues found (3 in the baseline).' })
  })

  it('fails only on new issues; moved code stays in the baseline, a third "Save" is new', async () => {
    vol.fromJSON({ [SRC]: legacy })
    await runLinterCli(config(), { quiet: true, logger: quietLogger, updateBaseline: true })

    vol.fromJSON({ [SRC]: `// a new first line\n\n${legacy.replace('</div>', '<p>Save</p><button>Delete</button></div>')}` })
    const result = await runLinter(config())

    expect(result.success).toBe(false)
    expect(result.files[SRC].map(i => i.text)).toEqual(['Save', 'Delete'])
    expect(result.existingIssues).toBe(3)
    expect(result.message).toBe('Linter found 2 potential issues (3 more in the baseline).')
  })

  it('counts fixed issues as stale entries', async () => {
    vol.fromJSON({ [SRC]: legacy })
    await runLinterCli(config(), { quiet: true, logger: quietLogger, updateBaseline: true })

    vol.fromJSON({ [SRC]: 'const A = () => <div><p>Hello</p></div>' })
    const result = await runLinter(config())

    expect(result).toMatchObject({ success: true, existingIssues: 1, staleBaselineEntries: 2 })
  })

  it('reads lint.baseline and holds translation-file issues too', async () => {
    const path = resolve(process.cwd(), 'ci/lint-baseline.json')
    vol.fromJSON({
      [SRC]: '',
      [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ greeting: 'Hello {{name}}' }),
      [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ greeting: 'Hallo' }),
      [path]: JSON.stringify({ 'locales/de/translation.json': { 'placeholder: greeting: missing {{name}} (compared with "en")': 1 } }),
    })
    const { glob } = await import('glob')
    ;(glob as any).mockImplementation(async (pattern: string) => String(pattern).startsWith('locales/') ? ['locales/en/translation.json'] : [SRC])

    const result = await runLinter({ ...config({ baseline: 'ci/lint-baseline.json' }), locales: ['en', 'de'] })

    expect(result).toMatchObject({ files: {}, existingIssues: 1 })
  })

  it('throws on a baseline that does not parse', async () => {
    vol.fromJSON({ [SRC]: legacy, [BASELINE]: '{ not json' })

    await expect(runLinter(config())).rejects.toThrow(/could not parse the lint baseline/)
  })
})
