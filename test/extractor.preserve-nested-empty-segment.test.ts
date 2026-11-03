import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const config: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
    preservePatterns: ['gearTypes.*'],
    removeUnusedKeys: true,
  },
}

describe('extractor: preserved keys with an empty segment', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/app.ts'])
  })

  it('keeps a nested empty-string key nested instead of flattening it', async () => {
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json')
    const existing = {
      gearTypes: { '': 'Unknown', trawlers: 'Trawlers' },
      title: 'Title',
    }
    vol.fromJSON({
      // eslint-disable-next-line no-template-curly-in-string
      '/src/app.ts': 't(`gearTypes.${type}`); t(\'title\')',
      [translationPath]: JSON.stringify(existing, null, 2),
    })

    await runExtractor(config)

    const result = JSON.parse(await vol.promises.readFile(translationPath, 'utf-8') as string)
    expect(result).toEqual(existing)
  })
})
