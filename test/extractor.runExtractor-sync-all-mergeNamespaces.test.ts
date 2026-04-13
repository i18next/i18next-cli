import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import { resolve } from 'node:path'
import { vol } from 'memfs'
import { glob } from 'glob'
import type { I18nextToolkitConfig } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

describe('extractor: --sync-all with mergeNamespaces (#233)', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  it('should clear secondary translations when syncAll is true and mergeNamespaces is enabled', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}.json',
        functions: ['t'],
        transComponents: ['Trans'],
        defaultNS: 'translation',
        mergeNamespaces: true,
      },
    }

    vol.fromJSON({
      '/src/app.ts': `
        import { t } from 'i18next'
        const title = t('ns1:app.title', 'Primary Default')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en.json')
    const dePath = resolve(process.cwd(), 'locales/de.json')

    // Prepopulate existing translations where DE already has a (now incorrect) translation
    vol.fromJSON({
      [enPath]: JSON.stringify({ ns1: { app: { title: 'Old EN' } } }, null, 2),
      [dePath]: JSON.stringify({ ns1: { app: { title: 'Alte DE' } } }, null, 2),
    })

    vi.mocked(glob).mockResolvedValue(['/src/app.ts'])

    const result = await runExtractor(config, { syncPrimaryWithDefaults: true, syncAll: true })
    expect(result.anyFileUpdated).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({ ns1: { app: { title: 'Primary Default' } } })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    // syncAll should clear the secondary translation (use configured default empty string)
    expect(deContent).toEqual({ ns1: { app: { title: '' } } })
  })
})
