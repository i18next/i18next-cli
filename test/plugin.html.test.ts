import { glob } from 'glob'
import { readFile } from 'node:fs/promises'
import type { Plugin, ExtractedKey, I18nextToolkitConfig } from '../src/index'
import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'

/**
 * An example plugin to extract translation keys from HTML files.
 * This plugin is a proof-of-concept and uses a simple regex-based approach.
 *
 * It demonstrates extending the toolkit for non-JS/TS files.
 * The plugin finds all `data-i18n` attributes in HTML files.
 *
 * @returns A configured i18next-cli Plugin object.
 */
const htmlPlugin = (): Plugin => ({
  name: 'html-plugin',

  /**
   * The `onEnd` hook is used here to run after the main AST-based extraction.
   * It scans for HTML files and adds any keys it finds to the final collection.
   *
   * @param keys - The map of keys extracted so far by the core extractor and other plugins.
   */
  async onEnd (keys: Map<string, ExtractedKey>) {
    // Find all HTML files based on the input pattern.
    // In a real plugin, this pattern might come from plugin-specific options.
    const htmlFiles = await glob('src/**/*.html', { ignore: 'node_modules/**' })

    const keyRegex = /data-i18n="([^"]+)"/g

    for (const file of htmlFiles) {
      const content = await readFile(file, 'utf-8')
      let match

      while ((match = keyRegex.exec(content)) !== null) {
        const key = match[1]
        if (key) {
          const uniqueKey = `translation:${key}` // Assume default namespace
          if (!keys.has(uniqueKey)) {
            keys.set(uniqueKey, {
              key,
              defaultValue: key, // Use key as default value
              ns: 'translation',
            })
          }
        }
      }
    }
  },
})

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'], // Core extractor looks at TSX
    output: 'locales/{{lng}}/{{ns}}.json',
    functions: ['t'], // Add this - it was missing!
    transComponents: ['Trans'], // Add this too if needed
    defaultNS: 'translation', // Add default namespace
  },
  plugins: [htmlPlugin()], // Enable the HTML plugin
}

describe('plugin system: html', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')

    // Mock glob to "find" one TSX file (for the core) and one HTML file (for the plugin)
    // The key issue was using absolute paths that don't exist in the virtual file system
    ;(glob as any)
      .mockResolvedValueOnce(['src/App.tsx']) // For core extractor's input - use relative path
      .mockResolvedValueOnce(['src/index.html']) // For plugin's internal glob call - use relative path
  })

  it('should extract keys from data-i18n attributes in HTML files', async () => {
    const tsxCode = `
      // This file is processed by the core extractor
      t('a.tsx.key', 'From TSX');
    `
    const htmlCode = `
      <!DOCTYPE html>
      <html>
        <body>
          <h1 data-i18n="html.title">This will be translated</h1>
          <p data-i18n="html.description"></p>
        </body>
      </html>
    `

    // Use relative paths that match what glob returns
    vol.fromJSON({
      'src/App.tsx': tsxCode,
      'src/index.html': htmlCode,
    })

    const keys = await findKeys(mockConfig)
    const extractedKeys = Array.from(keys.values()).map(k => k.key)

    // Verify that keys from BOTH the core extractor and the HTML plugin are present
    expect(extractedKeys).toContain('a.tsx.key')
    expect(extractedKeys).toContain('html.title')
    expect(extractedKeys).toContain('html.description')

    // Test the complete extracted key objects, not just the keys
    const tsxKey = keys.get('translation:a.tsx.key')
    expect(tsxKey).toEqual({
      key: 'a.tsx.key',
      ns: 'translation',
      defaultValue: 'From TSX'
    })

    const htmlTitleKey = keys.get('translation:html.title')
    expect(htmlTitleKey).toEqual({
      key: 'html.title',
      defaultValue: 'html.title',
      ns: 'translation'
    })

    const htmlDescriptionKey = keys.get('translation:html.description')
    expect(htmlDescriptionKey).toEqual({
      key: 'html.description',
      defaultValue: 'html.description',
      ns: 'translation'
    })

    // Alternative approach: test all keys at once
    expect(keys).toEqual(new Map([
      ['translation:a.tsx.key', {
        key: 'a.tsx.key',
        ns: 'translation',
        defaultValue: 'From TSX'
      }],
      ['translation:html.title', {
        key: 'html.title',
        defaultValue: 'html.title',
        ns: 'translation'
      }],
      ['translation:html.description', {
        key: 'html.description',
        defaultValue: 'html.description',
        ns: 'translation'
      }]
    ]))
  })
})
