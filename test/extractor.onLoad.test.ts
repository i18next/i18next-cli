import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor, findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin } from '../src/index'
import { resolve } from 'path'

vi.mock('fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs
})
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

// Import runStatus after mocks so its internal modules use the mocked fs/glob
const { runStatus } = await import('../src/index')

const mockConfigBase: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx,svelte}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

/**
 * Minimal Svelte plugin that strips the <script> wrapper and returns the
 * inner content as TypeScript — mirroring real-world plugins like
 * i18next-cli-plugin-svelte.
 *
 * The return type is `string | undefined` matching the updated Plugin['onLoad']
 * signature (`MaybePromise<string | undefined>`).
 */
const makeSveltePlugin = (): Plugin => ({
  name: 'svelte-plugin',
  onLoad (code: string, filePath: string): string | undefined {
    if (!filePath.endsWith('.svelte')) return undefined
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g
    const parts: string[] = []
    let match: RegExpExecArray | null
    while ((match = scriptRegex.exec(code)) !== null) {
      parts.push(match[1])
    }
    return parts.join('\n;')
  },
})

describe('plugin onLoad: non-JS/TS file handling (issue #217)', () => {
  beforeEach(() => {
    vol.reset()
    vol.fromJSON({})
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  // ─── Regression test for issue #217 ──────────────────────────────────────
  // The Svelte source here uses TypeScript generic syntax (`useTranslation<'ns'>()`).
  // Without the core fix, processFile infers the syntax from '.svelte' (→ ecmascript,
  // no tsx), which causes SWC to throw on the TypeScript angle-bracket syntax, and
  // the outer catch re-throws as ExtractorError — aborting the run.
  it('extracts keys from a .svelte file that uses TypeScript syntax in its <script> block', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.svelte'])

    // The TypeScript generic <'translation'> is the crucial detail — SWC will
    // reject this if it tries to parse the transformed code as plain ecmascript.
    const svelteSource = `
      <script lang="ts">
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation<'translation'>()
        const label = t('svelte.button.label', 'Click me')
        const title = t('svelte.page.title', 'Home')
      </script>
      <button>{label}</button>
    `

    vol.fromJSON({ '/src/App.svelte': svelteSource })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [makeSveltePlugin()],
    }

    // Must NOT throw — this was the root of issue #217
    const { allKeys } = await findKeys(config)

    expect(allKeys.size).toBe(2)
    expect(allKeys.has('translation:svelte.button.label')).toBe(true)
    expect(allKeys.has('translation:svelte.page.title')).toBe(true)
    expect(allKeys.get('translation:svelte.button.label')?.defaultValue).toBe('Click me')
  })

  it('writes extracted keys to translation files for .svelte sources', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.svelte'])

    const svelteSource = `
      <script lang="ts">
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation<'translation'>()
        t('svelte.greeting', 'Hello world')
      </script>
    `

    vol.fromJSON({ '/src/App.svelte': svelteSource })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [makeSveltePlugin()],
    }

    await runExtractor(config)

    const enPath = resolve('/', 'locales/en/translation.json')
    const content = await vol.promises.readFile(enPath, 'utf-8')
    const json = JSON.parse(content as string)

    expect(json.svelte.greeting).toBe('Hello world')
  })

  it('processes a mix of .tsx and .svelte files in the same run', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx', '/src/Component.svelte'])

    const tsxSource = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('ts.key', 'From TypeScript')
    `
    // TypeScript generic syntax to trigger the parse-mode bug without the fix
    const svelteSource = `
      <script lang="ts">
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation<'translation'>()
        t('svelte.key', 'From Svelte')
      </script>
    `

    vol.fromJSON({
      '/src/App.tsx': tsxSource,
      '/src/Component.svelte': svelteSource,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [makeSveltePlugin()],
    }

    const { allKeys } = await findKeys(config)

    expect(allKeys.has('translation:ts.key')).toBe(true)
    expect(allKeys.has('translation:svelte.key')).toBe(true)
  })

  it('skips a .svelte file gracefully when no plugin handles it (no throw, no error)', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.svelte', '/src/Other.tsx'])

    vol.fromJSON({
      '/src/App.svelte': '<button>Not processed</button>',
      '/src/Other.tsx': `
        import { useTranslation } from 'react-i18next'
        const { t } = useTranslation()
        t('ts.only.key', 'Handled')
      `,
    })

    // No plugin registered — the .svelte file must be silently skipped
    const config: I18nextToolkitConfig = { ...mockConfigBase }

    const fileErrors: string[] = []
    const { allKeys } = await findKeys(config, undefined, fileErrors)

    // The .tsx key is found
    expect(allKeys.has('translation:ts.only.key')).toBe(true)
    // The unhandled .svelte file did NOT push an error (it was skipped, not failed)
    expect(fileErrors.filter(e => e.includes('App.svelte'))).toHaveLength(0)
  })

  it('does not crash when onLoad returns undefined for a non-native file', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.svelte'])

    vol.fromJSON({ '/src/App.svelte': '<div>ignored</div>' })

    // Plugin explicitly opts out by returning undefined
    const passthroughPlugin: Plugin = {
      name: 'passthrough',
      onLoad (_code: string, _path: string): undefined {
        return undefined
      },
    }

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [passthroughPlugin],
    }

    await expect(findKeys(config)).resolves.toBeDefined()
  })

  it('onLoad returning an empty string for a .svelte file produces zero keys without error', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/NoScript.svelte'])

    vol.fromJSON({ '/src/NoScript.svelte': '<h1>Just markup</h1>' })

    const emptyPlugin: Plugin = {
      name: 'svelte-empty',
      onLoad (_code: string, filePath: string): string | undefined {
        if (!filePath.endsWith('.svelte')) return undefined
        return '' // Svelte file with no <script> block
      },
    }

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [emptyPlugin],
    }

    const { allKeys } = await findKeys(config)
    expect(allKeys.size).toBe(0)
  })

  it('still records parse errors for genuinely broken .ts files even when an onLoad plugin is present', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/broken.ts'])

    // Syntactically invalid TypeScript
    vol.fromJSON({ '/src/broken.ts': 'const x = @@@@invalid' })

    const config: I18nextToolkitConfig = {
      ...mockConfigBase,
      plugins: [makeSveltePlugin()], // plugin present but won't touch .ts files
    }

    const fileErrors: string[] = []
    await findKeys(config, undefined, fileErrors)

    // The broken .ts file IS recorded as an error (native type, genuinely failed)
    expect(fileErrors.some(e => e.includes('broken.ts'))).toBe(true)
  })
})

describe('runStatus: non-JS/TS file handling (issue #217)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')

    // Return any memfs path under /src/ as a source file, mirroring status_test pattern
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () =>
      Object.keys(vol.toJSON()).filter(p => p.includes('/src/'))
    )

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw and correctly counts keys extracted from .svelte files', async () => {
    vol.fromJSON({
      '/src/App.svelte': `
        <script lang="ts">
          import { useTranslation } from 'react-i18next'
          const { t } = useTranslation<'translation'>()
          t('svelte.title', 'Home')
          t('svelte.subtitle', 'Welcome')
        </script>
      `,
      [resolve('/', 'locales/de/translation.json')]: JSON.stringify({
        svelte: { title: 'Startseite', subtitle: 'Willkommen' },
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.svelte'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
      plugins: [makeSveltePlugin()],
    }

    // Must not throw — this is the status-command equivalent of issue #217
    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('exits with code 1 when .svelte-extracted keys have missing secondary translations', async () => {
    vol.fromJSON({
      '/src/App.svelte': `
        <script lang="ts">
          import { useTranslation } from 'react-i18next'
          const { t } = useTranslation<'translation'>()
          t('page.title', 'Home')
          t('page.cta', 'Get started')
          t('page.footer', 'Footer text')
        </script>
      `,
      // de has only 1 of 3 keys translated
      [resolve('/', 'locales/de/translation.json')]: JSON.stringify({
        page: { title: 'Startseite' },
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.svelte'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
      plugins: [makeSveltePlugin()],
    }

    try {
      await runStatus(config)
    } catch {
      // process.exit mock throws — expected
    }

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         3'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de:'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('33% (1/3 keys)'))
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('does not exit with code 1 when all .svelte-extracted keys are fully translated', async () => {
    vol.fromJSON({
      '/src/Button.svelte': `
        <script lang="ts">
          import { useTranslation } from 'react-i18next'
          const { t } = useTranslation<'translation'>()
          t('button.save', 'Save')
          t('button.cancel', 'Cancel')
        </script>
      `,
      [resolve('/', 'locales/de/translation.json')]: JSON.stringify({
        button: { save: 'Speichern', cancel: 'Abbrechen' },
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.svelte'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
      plugins: [makeSveltePlugin()],
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         2'))
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('100% (2/2 keys)'))
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('skips .svelte files gracefully with no plugin and still reports on any .ts keys found', async () => {
    vol.fromJSON({
      '/src/helper.ts': `
        import { t } from 'i18next'
        t('ts.key')
      `,
      '/src/ignored.svelte': '<button>Not processed</button>',
      [resolve('/', 'locales/de/translation.json')]: JSON.stringify({}),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,svelte}'],
        output: 'locales/{{language}}/{{namespace}}.json',
        primaryLanguage: 'en',
      },
      // No svelte plugin — .svelte file must be silently skipped, not crash status
    }

    try {
      await runStatus(config)
    } catch {
      // process.exit mock throws — expected (de is missing ts.key)
    }

    // The .ts key was found; status ran to completion without crashing on .svelte
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔑 Keys Found:         1'))
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })
})
