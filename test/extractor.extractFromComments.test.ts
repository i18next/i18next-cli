import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'
import { resolve } from 'path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
  },
}

describe('extractor: extractFromComments option', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should extract keys from comments by default', async () => {
    const sampleCode = `
      // t('comment.key', 'From comment')
      /* t('block.comment.key', 'From block comment') */
      t('code.key', 'From code');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(file).toBeDefined()
    expect(file!.newTranslations).toEqual({
      comment: { key: 'From comment' },
      block: { comment: { key: 'From block comment' } },
      code: { key: 'From code' },
    })
  })

  it('should NOT extract keys from comments when extractFromComments is false', async () => {
    const sampleCode = `
      // t('comment.key', 'From comment')
      /* t('block.comment.key', 'From block comment') */
      t('code.key', 'From code');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        extractFromComments: false,
      },
    }

    const results = await extract(config)
    const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(file).toBeDefined()
    expect(file!.newTranslations).toEqual({
      code: { key: 'From code' },
    })
    expect(file!.newTranslations).not.toHaveProperty('comment')
    expect(file!.newTranslations).not.toHaveProperty('block')
  })

  it('keeps the existing keys a commented template literal matches instead of extracting it (#304)', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        // ([1, 2, 3, 4] as const).map((q) => t(\`QUARTER.\${q}\`));
        // t(\`status.\${deepObject.status}\`)
        // t(\`\${section}.\${item}\`)
        ;(['5'] as const).map((q) => t(\`QUARTER.\${q}\`, 'Q5'))
      `,
    })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(resolve(process.cwd(), 'locales/en/translation.json'), JSON.stringify({
      QUARTER: { 1: 'Q1', 2: 'Q2' },
      status: { 200: 'OK' },
      unused: 'gone',
    }))

    const results = await extract({ ...mockConfig, extract: { ...mockConfig.extract, removeUnusedKeys: true } })
    const file = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(file!.newTranslations).toEqual({
      QUARTER: { 1: 'Q1', 2: 'Q2', 5: 'Q5' },
      status: { 200: 'OK' },
    })
  })
})
