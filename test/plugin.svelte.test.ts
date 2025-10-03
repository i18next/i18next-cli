import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin, ExtractedKey } from '../src/types'
import { glob } from 'glob'
import { readFile } from 'node:fs/promises'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// --- Svelte plugin ---
const sveltePlugin = (): Plugin => ({
  name: 'svelte-plugin',
  async onEnd (keys: Map<string, ExtractedKey>) {
    const svelteFiles = await glob('src/**/*.svelte', { ignore: 'node_modules/**' })

    // Regex for template syntax: {$t('...')} or {$i18n.t('...')}
    const templateRegex = /\{\$(?:i18n\.)?t\s*\(\s*['"]([^'"]+)['"]\s*\)\}/g
    // Regex for script syntax: t('...') or $i18n.t('...')
    const scriptRegex = /(?:\$i18n\.)?t\s*\(\s*['"]([^'"]+)['"]\)/g

    const addKey = (key: string) => {
      if (key) {
        const uniqueKey = `translation:${key}`
        if (!keys.has(uniqueKey)) {
          keys.set(uniqueKey, { key, defaultValue: key, ns: 'translation' })
        }
      }
    }

    for (const file of svelteFiles) {
      const content = await readFile(file, 'utf-8')
      let match

      // Find all template matches
      while ((match = templateRegex.exec(content)) !== null) {
        addKey(match[1])
      }

      // Find all script matches
      while ((match = scriptRegex.exec(content)) !== null) {
        addKey(match[1])
      }
    }
  },
})

describe('plugin system: svelte', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should extract keys from .svelte files using a plugin', async () => {
    const sampleSvelteCode = `
      <script>
        let $i18n = { t: (key) => key };
        const aKeyInScript = $i18n.t('a.key.in.script');
      </script>

      <div>
        <i class="fa-solid fa-circle-info"></i>&ensp;{$i18n.t('test.not-detected-ensp')}
      </div>
    `

    // Mock glob. The first call (for the core extractor) finds nothing.
    // The second call (for the plugin) finds our Svelte file.
    const { glob } = await import('glob')
    vi.mocked(glob)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['/src/App.svelte'])

    vol.fromJSON({ '/src/App.svelte': sampleSvelteCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        // The core extractor should ONLY look at files it understands (JS/TS).
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [sveltePlugin()], // The plugin will handle .svelte files.
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assert that the plugin found keys from both the <script> and the template.
    expect(extractedKeys).toContain('a.key.in.script')
    expect(extractedKeys).toContain('test.not-detected-ensp')
  })
})
