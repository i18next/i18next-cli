import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/extractor/core/key-finder'
import type { I18nextToolkitConfig } from '../src/types'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

describe('extractor: comment-parser', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should not extract keys from non-translation functions inside comments', async () => {
    const sampleCode = `
      // test("shows error state when prefs fail", async () => {
      //   server.use(http.get("/api/v1/user/prefs", () => {}));
      // });
      const myKey = t('real.key');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json'
      },
    }

    const { allKeys } = await findKeys(config)

    expect(allKeys.size).toBe(1)
    expect(allKeys.has('translation:real.key')).toBe(true)
  })

  it('should extract keys with opposite quote types inside strings', async () => {
    const sampleCode = `
      // t("comment's key")
      const myKey = t('real.key');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json'
      },
    }

    const { allKeys } = await findKeys(config)

    expect(allKeys.size).toBe(2)
    expect(allKeys.has('translation:real.key')).toBe(true)
    expect(allKeys.has('translation:comment\'s key')).toBe(true)
  })

  it('should handle escaped quotes in comment strings', async () => {
    const sampleCode = `
      // t('it\\'s a test')
      // t("say \\"hello\\"")
      const myKey = t('real.key');
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json'
      },
    }

    const { allKeys } = await findKeys(config)

    expect(allKeys.size).toBe(3)
    expect(allKeys.has('translation:real.key')).toBe(true)
    expect(allKeys.has('translation:it\'s a test')).toBe(true)
    expect(allKeys.has('translation:say "hello"')).toBe(true)
  })
})
