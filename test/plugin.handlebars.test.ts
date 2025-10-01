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

// --- A simple Handlebars plugin for demonstration ---
const handlebarsPlugin = (): Plugin => ({
  name: 'handlebars-plugin',
  async onEnd (keys: Map<string, ExtractedKey>) {
    const hbsFiles = await glob('src/**/*.hbs', { ignore: 'node_modules/**' })

    // Regex to find {{t 'key'}} patterns in Handlebars templates
    const keyRegex = /\{\{t\s+['"]([^'"]+)['"]/g

    for (const file of hbsFiles) {
      const content = await readFile(file, 'utf-8')
      let match
      while ((match = keyRegex.exec(content)) !== null) {
        const key = match[1]
        if (key) {
          const uniqueKey = `translation:${key}`
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

describe('plugin system: handlebars', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should extract keys from .hbs templates using a plugin', async () => {
    const sampleHbsCode = `
      <h1>{{t 'general.greeting' this}}</h1>
      <p>{{t 'general.welcome_message'}}</p>
    `

    // Mock glob. The core extractor finds no files, the plugin finds the .hbs file.
    const { glob } = await import('glob')
    vi.mocked(glob)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['/src/template.hbs'])

    vol.fromJSON({ '/src/template.hbs': sampleHbsCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        // The core extractor should only look at files it understands.
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [handlebarsPlugin()], // Enable the Handlebars plugin.
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assert that the plugin found the keys from the template.
    expect(extractedKeys).toContain('general.greeting')
    expect(extractedKeys).toContain('general.welcome_message')
  })
})
