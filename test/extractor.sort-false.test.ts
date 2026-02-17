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

describe('key order should not change with sort: false', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  it('should preserve key order in yml file across two runs', async () => {
    // Simulate user config
    const config: I18nextToolkitConfig = {
      locales: ['nl-NL', 'en-US'],
      extract: {
        input: 'src/**/*.{js,jsx,ts,tsx}',
        output: 'src/client/translations/{{language}}/{{namespace}}.yml',
        defaultNS: 'translation',
        functions: ['t', '*.t'],
        transComponents: ['Trans'],
        sort: false,
        generateBasePluralForms: false,
        disablePlurals: true,
        defaultValue: (key: string) => '',
      },
    }

    // Simulate source file
    const sampleCode = `
      t('zebra', 'Zebra')
      t('apple', 'Apple')
      t('snail', 'Snail')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const ymlPath = resolve(process.cwd(), 'src/client/translations/en-US/translation.yml')
    await vol.promises.mkdir(resolve(process.cwd(), 'src/client/translations/en-US'), { recursive: true })

    // First run
    await runExtractor(config)
    const persistedRaw1 = await vol.promises.readFile(ymlPath, 'utf-8')
    const persisted1 = persistedRaw1.toString().split('\n').filter(Boolean)
    const order1 = persisted1.map((line: string) => line.split(':')[0])

    // Simulate source file change
    // const sampleCode2 = `
    //   t('zebra', 'Zebra')
    //   t('apple', 'Apple')
    //   t('bread', 'Bread')
    //   t('snail', 'Snail')
    // `
    // vol.fromJSON({ '/src/App.tsx': sampleCode2 })

    // Second run
    await runExtractor(config)
    const persistedRaw2 = await vol.promises.readFile(ymlPath, 'utf-8')
    const persisted2 = persistedRaw2.toString().split('\n').filter(Boolean)
    const order2 = persisted2.map((line: string) => line.split(':')[0])

    // Assert that the order is preserved between runs
    expect(order2).toEqual(order1)
  })
})
