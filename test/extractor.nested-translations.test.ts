import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

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
    functions: ['t', '*.t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor: nested translations ($t(...) inside string)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) return ['src/App.tsx']
      if (typeof pattern === 'string' && pattern.startsWith('locales/')) return []
      return []
    })
  })

  it('extracts nested plural key used via $t(...) inside a string', async () => {
    const sampleCode = `
      import i18next from 'i18next'

      i18next.t(
        'You\\'ve indicated $t(item_count, {"count": {{indicated}} }) but provided numbers for $t(item_count, {"count": {{active}} }).',
        { indicated: 2, active: 1 }
      )
    `
    vol.fromJSON({
      'src/App.tsx': sampleCode,
    })

    const results = await extract(mockConfig)
    expect(results).toHaveLength(2)

    const enJson = results[0].newTranslations
    const deJson = results[1].newTranslations

    // Expect plural variants for item_count to be present for English
    expect(enJson).toHaveProperty('item_count_one')
    expect(enJson).toHaveProperty('item_count_other')

    // Secondary locale should have same keys (empty defaults)
    expect(deJson).toHaveProperty('item_count_one')
    expect(deJson).toHaveProperty('item_count_other')
    expect(deJson.item_count_one).toBe('')
    expect(deJson.item_count_other).toBe('')
  })
})
