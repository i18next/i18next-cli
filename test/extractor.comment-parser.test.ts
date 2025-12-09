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
      // t("comment's key")
      // t('comment"s key')
      // t(\`comment's key TWO\`)
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

    // This will fail before the fix because "shows error state when prefs fail" will be extracted.
    // The correct behavior is to only find the key from the actual t() call.
    expect(allKeys.size).toBe(4)
    expect(allKeys.has('translation:real.key')).toBe(true)
    expect(allKeys.has('translation:comment\'s key')).toBe(true)
    expect(allKeys.has('translation:comment"s key')).toBe(true)
    expect(allKeys.has('translation:comment\'s key TWO')).toBe(true)
  })
})
