import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/extractor/core/key-finder'
import type { I18nextToolkitConfig, Plugin, ExtractedKey } from '../src/types'
import { glob } from 'glob'
import { readFile } from 'node:fs/promises'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// --- A simple Vue plugin for demonstration ---
const vuePlugin = (): Plugin => ({
  name: 'vue-plugin',
  async onEnd (keys: Map<string, ExtractedKey>) {
    // 1. Find all .vue files
    const vueFiles = await glob('src/**/*.vue', { ignore: 'node_modules/**' })

    // 2. Regex to find t('key') inside Vue templates
    // This regex looks for: {{ t('...') }}, :prop="t('...')", and t('...') in JS sections
    const keyRegex = /(?:\{\{\s*t\s*\(\s*['"]([^'"]+)['"])|(?:t\s*\(\s*['"]([^'"]+)['"])/g

    for (const file of vueFiles) {
      const content = await readFile(file, 'utf-8')
      let match

      // 3. Find all matches and add them to the keys map
      while ((match = keyRegex.exec(content)) !== null) {
        // The key could be in capture group 1 or 2 depending on the pattern
        const key = match[1] || match[2]
        if (key) {
          const uniqueKey = `translation:${key}` // Assume default namespace
          if (!keys.has(uniqueKey)) {
            keys.set(uniqueKey, {
              key,
              defaultValue: key,
              ns: 'translation',
            })
          }
        }
      }
    }
  },
})

describe('plugin system: vue', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should extract keys from a .vue <template> block using a plugin', async () => {
    const sampleVueCode = `
      <script setup>
      import { useI18n } from 'vue-i18n';
      const { t } = useI18n();
      // This key below would be found by the core JS parser
      const aJavaScriptKey = t('key.from.script');
      </script>

      <template>
        <p>{{ t('key.from.template.interpolation') }}</p>

        <button :aria-label="t('key.from.template.attribute')">
          Click Me
        </button>
      </template>
    `

    // Mock glob to find one JS file (for the core) and one Vue file (for the plugin)
    const { glob } = await import('glob')
    vi.mocked(glob)
      .mockResolvedValueOnce(['/src/App.js']) // Core extractor input
      .mockResolvedValueOnce(['/src/App.vue']) // Plugin's internal glob call

    vol.fromJSON({
      '/src/App.js': "t('a.js.key');", // A normal JS key
      '/src/App.vue': sampleVueCode,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{js,ts}'], // Core extractor only looks at JS/TS
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [vuePlugin()],
    }

    // Action: Run the key finder
    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assertions: Check that keys from both the core parser and the Vue plugin are present
    expect(extractedKeys).toContain('a.js.key')
    expect(extractedKeys).toContain('key.from.script')
    expect(extractedKeys).toContain('key.from.template.interpolation')
    expect(extractedKeys).toContain('key.from.template.attribute')
  })
})
