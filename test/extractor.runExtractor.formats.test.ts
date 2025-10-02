import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/extractor'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

// Mock the 'fs/promises' module to use our in-memory file system from 'memfs'
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock the 'glob' module to control which files it "finds"
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

describe('extractor - runExtractor: output formats and namespace merging', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  const sampleCode = `
    t('key1', 'Value 1');
    t('ns1:keyA', 'Value A');
  `

  it('should write files in JavaScript ESM format', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.js',
        outputFormat: 'js',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.js')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')

    expect(fileContent).toContain('export default {')
    expect(fileContent).toContain('"key1": "Value 1"')
    expect(fileContent).toContain('};')
  })

  it('should write files in JavaScript CJS format', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.js',
        outputFormat: 'js-cjs',
      },
    }
    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.js')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')

    expect(fileContent).toContain('module.exports = {')
  })

  it('should write files in TypeScript ESM format with "as const"', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.ts',
        outputFormat: 'ts',
      },
    }
    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.ts')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')

    expect(fileContent).toContain('export default {')
    expect(fileContent).toContain('} as const;')
  })

  it('should merge all namespaces into a single file per language', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}.json', // No {{namespace}} placeholder
        mergeNamespaces: true,
      },
    }
    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en.json')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')
    const json = JSON.parse(fileContent as string)

    // The file should contain top-level keys for each namespace
    expect(json).toHaveProperty('translation')
    expect(json).toHaveProperty('ns1')
    expect(json.translation).toEqual({ key1: 'Value 1' })
    expect(json.ns1).toEqual({ keyA: 'Value A' })
  })

  it('should merge namespaces into a single JS file when combined', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}.js',
        mergeNamespaces: true,
        outputFormat: 'js-esm',
      },
    }
    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en.js')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')

    expect(fileContent).toContain('export default {')
    expect(fileContent).toContain('"translation": {')
    expect(fileContent).toContain('"ns1": {')
  })

  it('should preserve existing translations in secondary languages when mergeNamespaces is true', async () => {
  // Setup: A source file with one key, and existing translations for two keys
    vol.fromJSON({
      '/src/App.tsx': "t('key1')",
      '/locales/en.json': JSON.stringify({
        translation: { key1: 'value1_en', key2_old: 'old_value_en' },
      }),
      '/locales/de.json': JSON.stringify({
        translation: { key1: 'wert1_de', key2_old: 'alter_wert_de' },
      }),
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}.json',
        mergeNamespaces: true,
        keySeparator: false, // As per the user's config
        primaryLanguage: 'en',
        secondaryLanguages: ['de'],
      },
    }

    // Action: Run the extractor
    await runExtractor(config)

    // Assertions
    const enFileContent = JSON.parse(String(await vol.promises.readFile('/locales/en.json', 'utf-8')))
    const deFileContent = JSON.parse(String(await vol.promises.readFile('/locales/de.json', 'utf-8')))

    // English file should have the new key and the old key removed
    expect(enFileContent).toEqual({
      translation: { key1: 'value1_en' },
    })

    // German file should have its existing translation for key1 preserved
    // This is the part that will fail before the fix.
    expect(deFileContent).toEqual({
      translation: { key1: 'wert1_de' },
    })
  })

  it('should use a string for indentation when provided (e.g., a tab character)', async () => {
    // Setup: Use a key that will create a nested object to make indentation visible.
    vol.fromJSON({ '/src/App.tsx': "t('parent.child', 'value')" })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        defaultNS: 'translation',
        // Configure indentation with a tab character string
        indentation: '\t',
      },
    }

    // Action: Run the extractor
    await runExtractor(config)

    // Assertions: Check the content of the generated file
    const filePath = resolve(process.cwd(), 'locales/en/translation.json')
    const fileContent = await vol.promises.readFile(filePath, 'utf-8')

    // Manually create the expected output string with tab indentation and a trailing newline
    const expectedJson = {
      parent: {
        child: 'value'
      }
    }
    const expectedFileContent = JSON.stringify(expectedJson, null, '\t') + '\n'

    expect(fileContent).toBe(expectedFileContent)
  })
})
