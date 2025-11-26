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

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor: --sync-all', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  it('should update primary from code defaults and clear secondary translations when syncAll is true', async () => {
    vol.fromJSON({
      '/src/app.ts': `
        import { t } from 'i18next'
        const title = t('app.title', 'Primary Default')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    // Prepopulate existing translations where DE already has a (now incorrect) translation
    vol.fromJSON({
      [enPath]: JSON.stringify({ app: { title: 'Old EN' } }, null, 2),
      [dePath]: JSON.stringify({ app: { title: 'Alte DE' } }, null, 2),
    })

    vi.mocked(glob).mockResolvedValue(['/src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true, syncAll: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({ app: { title: 'Primary Default' } })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    // syncAll should clear the secondary translation (use configured default empty string)
    expect(deContent).toEqual({ app: { title: '' } })
  })
})
