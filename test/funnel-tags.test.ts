import { vol } from 'memfs'
import { resolve } from 'path'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
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

// Pretend we are in an interactive terminal outside the 24h cooldown so the
// funnel line is actually printed.
vi.mock('../src/utils/funnel-msg-tracker', () => ({
  shouldShowFunnel: vi.fn(async () => true),
  recordFunnelShown: vi.fn(async () => {}),
}))

const { runStatus, runSyncer, runExtractor } = await import('../src/index')
const { runLinterCli } = await import('../src/linter')

/**
 * Attribution guard: every registration coming from a CLI funnel line must be
 * countable per command, so each line carries its own `?from=i18next_cli__<command>`
 * tag. Dropping or renaming a tag silently breaks the attribution series.
 */
const REGISTER = 'https://www.locize.app/register?from=i18next_cli__'

describe('locize funnel tags', () => {
  let logged: string[]

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    logged = []
    const capture = (...args: any[]) => { logged.push(args.map(String).join(' ')) }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(console, 'info').mockImplementation(capture)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const funnelLine = () => logged.find(l => l.includes(REGISTER))

  describe('status', () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
    }

    beforeEach(async () => {
      const { glob } = await import('glob')
      vi.mocked(glob).mockImplementation(async () => Object.keys(vol.toJSON()).filter(p => p.includes('/src/')))
      vol.fromJSON({
        [resolve(process.cwd(), 'src/file1.ts')]: "import { t } from 'i18next'; t('key.a'); t('key.b'); t('key.c'); t('key.d')",
      })
    })

    it('prints the gap, the fix and the status-tagged register link', async () => {
      vol.fromJSON({
        [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ key: { a: 'Wert A', b: 'Wert B' } }),
        [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({ key: { a: 'A', b: 'B', c: 'C', d: '' } }),
      })

      await runStatus(config).catch(() => {}) // exits 1 on incomplete translations

      const line = funnelLine()
      expect(line).toBeDefined()
      expect(line).toContain('3 untranslated keys (de 2, fr 1)')
      expect(line).toContain('npx i18next-cli localize')
      expect(line).toContain(`${REGISTER}status`)
    })

    it('names the single locale in the detailed view', async () => {
      vol.fromJSON({
        [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ key: { a: 'Wert A', b: 'Wert B' } }),
        [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({ key: { a: 'A', b: 'B', c: 'C', d: 'D' } }),
      })

      await runStatus(config, { detail: 'de' }).catch(() => {})

      expect(funnelLine()).toContain('2 untranslated keys in de')
    })

    it('prints nothing when every secondary locale is complete', async () => {
      vol.fromJSON({
        [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ key: { a: 'A', b: 'B', c: 'C', d: 'D' } }),
        [resolve(process.cwd(), 'locales/fr/translation.json')]: JSON.stringify({ key: { a: 'A', b: 'B', c: 'C', d: 'D' } }),
      })

      await runStatus(config)

      expect(funnelLine()).toBeUndefined()
    })
  })

  describe('sync', () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
        defaultNS: 'translation',
      },
    }
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    beforeEach(async () => {
      const { glob } = await import('glob')
      vi.mocked(glob).mockResolvedValue([enPath])
    })

    it('prints the gap and the sync-tagged register link after a sync that changed files', async () => {
      vol.fromJSON({
        [enPath]: JSON.stringify({ title: 'Welcome', subtitle: 'To the app', save: 'Save' }),
        [dePath]: JSON.stringify({ title: 'Willkommen' }),
      })

      await runSyncer(config)

      const line = funnelLine()
      expect(line).toContain('2 untranslated keys in de')
      expect(line).toContain(`${REGISTER}sync`)
    })

    it('prints nothing when the secondary locale ends up fully translated', async () => {
      vol.fromJSON({
        [enPath]: JSON.stringify({ title: 'Welcome' }),
        [dePath]: JSON.stringify({ title: 'Willkommen', obsolete: 'weg' }),
      })

      await runSyncer(config)

      expect(funnelLine()).toBeUndefined()
    })
  })

  describe('extract', () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
        functions: ['t'],
        defaultNS: 'translation',
      },
    }

    beforeEach(async () => {
      vi.spyOn(process, 'cwd').mockReturnValue('/')
      const { glob } = await import('glob')
      vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
      vol.fromJSON({ '/src/App.tsx': "t('a'); t('b')" })
    })

    it('prints the gap and the extract-tagged register link when files changed', async () => {
      await runExtractor(config)

      const line = funnelLine()
      expect(line).toContain('2 untranslated keys in de')
      expect(line).toContain(`${REGISTER}extract`)
    })

    it('prints nothing on --dry-run', async () => {
      await runExtractor(config, { isDryRun: true })

      expect(funnelLine()).toBeUndefined()
    })
  })

  describe('lint', () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
    }
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    beforeEach(async () => {
      const { glob } = await import('glob')
      vi.mocked(glob).mockImplementation(async (pattern: any) => String(pattern).startsWith('locales/') ? [enPath] : [])
    })

    it('prints the lint-tagged register link after a placeholder mismatch', async () => {
      vol.fromJSON({
        [enPath]: JSON.stringify({ greeting: 'Hello {{name}}' }),
        [dePath]: JSON.stringify({ greeting: 'Hallo {{nom}}' }),
      })

      await runLinterCli(config, { quiet: true })

      const line = funnelLine()
      expect(line).toContain('placeholder check while translators type')
      expect(line).toContain(`${REGISTER}lint`)
    })

    it('prints nothing when the placeholders match', async () => {
      vol.fromJSON({
        [enPath]: JSON.stringify({ greeting: 'Hello {{name}}' }),
        [dePath]: JSON.stringify({ greeting: 'Hallo {{name}}' }),
      })

      await runLinterCli(config, { quiet: true })

      expect(funnelLine()).toBeUndefined()
    })
  })

  describe('status: identical values', () => {
    it('counts English copied into de as untranslated in the funnel line', async () => {
      const { glob } = await import('glob')
      vi.mocked(glob).mockImplementation(async () => Object.keys(vol.toJSON()).filter(p => p.includes('/src/')))
      vol.fromJSON({
        [resolve(process.cwd(), 'src/file1.ts')]: "import { t } from 'i18next'; t('title'); t('save'); t('cancel')",
        [resolve(process.cwd(), 'locales/en/translation.json')]: JSON.stringify({ title: 'Welcome', save: 'Save', cancel: 'Cancel' }),
        [resolve(process.cwd(), 'locales/de/translation.json')]: JSON.stringify({ title: 'Willkommen', save: 'Save', cancel: '' }),
      })

      await runStatus({ locales: ['en', 'de'], extract: { input: ['src/**/*.ts'], output: 'locales/{{language}}/{{namespace}}.json' } }).catch(() => {})

      expect(funnelLine()).toContain('2 untranslated keys in de, 1 of them still identical to the primary language')
    })
  })
})
