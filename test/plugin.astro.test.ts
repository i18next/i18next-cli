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

// --- Astro plugin ---
const astroPlugin = (): Plugin => ({
  name: 'astro-plugin',
  async onEnd (keys: Map<string, ExtractedKey>) {
    const astroFiles = await glob('src/**/*.astro', { ignore: 'node_modules/**' })

    // Regex patterns for Astro files:
    // 1. Frontmatter script: t('key') or i18next.t('key')
    const scriptRegex = /\b(?:i18next\.)?t\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*[^)]+)?\)/g

    // 2. Template expressions: {t('key')} or {i18next.t('key')}
    const templateRegex = /\{\s*(?:i18next\.)?t\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*[^)]+)?\)\s*\}/g

    const addKey = (key: string) => {
      if (key) {
        const uniqueKey = `translation:${key}`
        if (!keys.has(uniqueKey)) {
          keys.set(uniqueKey, { key, defaultValue: key, ns: 'translation' })
        }
      }
    }

    for (const file of astroFiles) {
      const content = await readFile(file, 'utf-8')
      let match

      // Find all script matches
      while ((match = scriptRegex.exec(content)) !== null) {
        addKey(match[1])
      }

      // Find all template matches
      while ((match = templateRegex.exec(content)) !== null) {
        addKey(match[1])
      }
    }
  },
})

describe('plugin system: astro', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should extract keys from .astro files using a plugin', async () => {
    const sampleAstroCode = `---
import i18next from 'i18next';

const title = t('page.title');
const description = i18next.t('page.description');
---

<html>
  <head>
    <title>{t('meta.title')}</title>
  </head>
  <body>
    <h1>{title}</h1>
    <p>{i18next.t('welcome.message')}</p>
    <div>{t('content.body')}</div>
  </body>
</html>
    `

    // Mock glob. The first call (for the core extractor) finds nothing.
    // The second call (for the plugin) finds our Astro file.
    const { glob } = await import('glob')
    vi.mocked(glob)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['src/pages/index.astro'])

    vol.fromJSON({ 'src/pages/index.astro': sampleAstroCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        // The core extractor should ONLY look at files it understands (JS/TS).
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [astroPlugin()], // The plugin will handle .astro files.
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assert that the plugin found keys from both frontmatter and template
    expect(extractedKeys).toContain('page.title')
    expect(extractedKeys).toContain('page.description')
    expect(extractedKeys).toContain('meta.title')
    expect(extractedKeys).toContain('welcome.message')
    expect(extractedKeys).toContain('content.body')
  })

  it('should handle complex Astro patterns', async () => {
    const complexAstroCode = `---
const { t } = Astro.locals;
const items = ['key1', 'key2'].map(k => t(\`items.\${k}\`));
---

<ul>
  {items.map(item => (
    <li>{t('list.item', { defaultValue: item })}</li>
  ))}
</ul>

<footer>{t('footer.copyright', { year: new Date().getFullYear() })}</footer>
    `

    const { glob } = await import('glob')
    vi.mocked(glob)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['src/components/List.astro'])

    vol.fromJSON({ 'src/components/List.astro': complexAstroCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [astroPlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    expect(extractedKeys).toContain('list.item')
    expect(extractedKeys).toContain('footer.copyright')
  })
})
