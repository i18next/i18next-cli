import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

describe("sort: 'locize' preset", () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  it('orders keys exactly like locize-published files (UTF-16 code-unit sort)', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{js,jsx,ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: 'locize',
      },
    }

    const sampleCode = `
      t('zebra', 'Zebra')
      t('Apple', 'Apple')
      t('apple', { count: 1 })
      t('banana', 'Banana')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    await runExtractor(config)

    const jsonPath = resolve(process.cwd(), 'locales/en/translation.json')
    const persisted = JSON.parse((await vol.promises.readFile(jsonPath, 'utf-8')).toString())
    const keys = Object.keys(persisted)

    // locize publishes with Object.keys(resources).sort(): case-sensitive
    // code-unit order ('Apple' < lowercase keys) and plain alphabetical plural
    // suffixes (apple_one < apple_other), with no canonical CLDR plural order.
    expect(keys).toEqual([...keys].sort())
    expect(keys[0]).toBe('Apple')
    const one = keys.indexOf('apple_one')
    const other = keys.indexOf('apple_other')
    expect(one).toBeGreaterThan(-1)
    expect(other).toBeGreaterThan(-1)
    expect(one).toBeLessThan(other)
  })

  it('is idempotent across two runs', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{js,jsx,ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: 'locize',
      },
    }

    vol.fromJSON({ '/src/App.tsx': "t('b'); t('a'); t('C')" })

    await runExtractor(config)
    const jsonPath = resolve(process.cwd(), 'locales/en/translation.json')
    const first = (await vol.promises.readFile(jsonPath, 'utf-8')).toString()

    await runExtractor(config)
    const second = (await vol.promises.readFile(jsonPath, 'utf-8')).toString()

    expect(second).toBe(first)
    expect(Object.keys(JSON.parse(first))).toEqual(['C', 'a', 'b'])
  })
})
