import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/extractor'
import type { I18nextToolkitConfig, Plugin } from '../src/types'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

describe('plugin system: afterSync hook', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    // Make the glob mock robust enough to handle string and array patterns.
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      // Check if the pattern is for finding source files.
      const isSourcePattern = Array.isArray(pattern)
        ? pattern[0].includes('src/')
        : pattern.includes('src/')

      if (isSourcePattern) {
        return ['/src/App.tsx']
      }

      // Check if the pattern is for finding existing locale files.
      if (typeof pattern === 'string' && pattern.startsWith('locales/')) {
        return ['/locales/en/translation.json']
      }

      // Default fallback
      return []
    })
  })

  it('should be called with results and allow inspection of new keys', async () => {
    const sampleCode = `
      t('key.new', 'A new key');
      t('key.existing', 'An existing key');
    `
    const existingTranslations = { 'key.existing': 'An old value' }

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
      '/locales/en/translation.json': JSON.stringify(existingTranslations),
    })

    // This spy will act as our plugin's hook
    const afterSyncSpy = vi.fn()

    const newKeysPlugin = (): Plugin => ({
      name: 'new-keys-plugin',
      afterSync: afterSyncSpy, // Use the spy as the hook implementation
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        keySeparator: false, // Use flat keys for simpler comparison
      },
      plugins: [newKeysPlugin()],
    }

    await runExtractor(config)

    // 1. Assert that the hook was called
    expect(afterSyncSpy).toHaveBeenCalledTimes(1)

    // 2. Inspect the arguments passed to the hook
    const [results, receivedConfig] = afterSyncSpy.mock.calls[0]
    expect(results).toHaveLength(1)
    expect(receivedConfig).toEqual(config)

    // 3. Verify the content of the results to find the new key
    const primaryLangResult = results[0]
    const newKeys = Object.keys(primaryLangResult.newTranslations)
    const existingKeys = Object.keys(primaryLangResult.existingTranslations)

    const addedKeys = newKeys.filter(k => !existingKeys.includes(k))

    expect(addedKeys).toEqual(['key.new'])
  })
})
