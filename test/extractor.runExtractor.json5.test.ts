import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import { runSyncer } from '../src/syncer'
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

describe('extractor - runExtractor: JSON5 support', () => {
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

  it('should write files in JSON5 format', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        outputFormat: 'json5',
      },
    }

    await runExtractor(config)
    const translationPath = resolve(process.cwd(), 'locales/en/translation.json5')
    const ns1Path = resolve(process.cwd(), 'locales/en/ns1.json5')
    const translationContent = (await vol.promises.readFile(translationPath)).toString('utf-8')
    const ns1Content = (await vol.promises.readFile(ns1Path)).toString('utf-8')

    expect(translationContent).toContain('"key1": "Value 1"')
    expect(ns1Content).toContain('"keyA": "Value A"')
    expect(translationContent.trim().startsWith('{')).toBe(true)
    expect(translationContent.trim().endsWith('}')).toBe(true)
  })

  it('should preserve comments and formatting in existing JSON5 files', async () => {
    const existingJson5 = `{
      // This is a comment
      "key1": "Old Value",
      // Another comment
    }`
    vol.fromJSON({
      '/src/App.tsx': `
        t('key1', 'New Value')
        t('thisIsNew', 'this is really new')
      `,
      '/locales/en/translation.json5': existingJson5,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        outputFormat: 'json5',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.json5')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('// This is a comment')
    expect(fileContent).toContain('// Another comment')
    expect(fileContent).toContain('"thisIsNew": "this is really new"')
  })

  it('should use custom indentation for JSON5 output', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('key1', 'Value')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        outputFormat: 'json5',
        indentation: 4,
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.json5')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('    "key1": "Value"')
  })

  it('should sync primary language defaults with code when syncPrimaryWithDefaults is true', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        t('app.title', 'Welcome to My App')
        t('app.subtitle', 'Best app ever')
        t('app.existing', 'New default value')
      `,
      '/locales/en/translation.json5': `{
        "app": {
          "title": "Old Welcome Message",
          "subtitle": "Old subtitle",
          "existing": "Existing translation",
          "preserved": "Should stay"
        }
      }`,
      '/locales/de/translation.json5': `{
        "app": {
          "title": "Alte Willkommensnachricht",
          "existing": "Bestehende Übersetzung"
        }
      }`,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['/src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        outputFormat: 'json5',
        defaultNS: 'translation',
      },
    }

    await runExtractor(config, { syncPrimaryWithDefaults: true })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json5')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json5')
    const enContent = (await vol.promises.readFile(enPath)).toString('utf-8')
    const deContent = (await vol.promises.readFile(dePath)).toString('utf-8')

    expect(enContent).toContain('"title": "Welcome to My App"')
    expect(enContent).toContain('"subtitle": "Best app ever"')
    expect(enContent).toContain('"existing": "New default value"')
    expect(enContent).not.toContain('"preserved": "Should stay"')
    expect(deContent).toContain('"title": "Alte Willkommensnachricht"')
    expect(deContent).toContain('"existing": "Bestehende Übersetzung"')
    expect(deContent).toContain('"subtitle": ""')
  })

  it('should sync all secondary translations with syncAll option', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        t('app.title', 'Primary Default')
      `,
      '/locales/en/translation.json5': `{
        "app": { "title": "Old EN" }
      }`,
      '/locales/de/translation.json5': `{
        "app": { "title": "Alte DE" }
      }`,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['/src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        outputFormat: 'json5',
        defaultNS: 'translation',
      },
    }

    await runExtractor(config, { syncPrimaryWithDefaults: true, syncAll: true })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json5')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json5')
    const enContent = (await vol.promises.readFile(enPath)).toString('utf-8')
    const deContent = (await vol.promises.readFile(dePath)).toString('utf-8')

    expect(enContent).toContain('"title": "Primary Default"')
    expect(deContent).toContain('"title": ""')
  })

  it('should synchronize secondary languages using runSyncer', async () => {
    vol.fromJSON({
      '/locales/en/translation.json5': `{
        "app": { "title": "Welcome" }
      }`,
      '/locales/de/translation.json5': `{
        "app": { "title": "Willkommen" }
      }`,
      '/locales/fr/translation.json5': `{
        "app": { "title": "Bienvenue" }
      }`,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: ['/src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        // outputFormat: 'json5',
        defaultNS: 'translation',
        defaultValue: '[MISSING]',
      },
    }

    await runSyncer(config)

    const dePath = resolve(process.cwd(), 'locales/de/translation.json5')
    const frPath = resolve(process.cwd(), 'locales/fr/translation.json5')
    const deContent = (await vol.promises.readFile(dePath)).toString('utf-8')
    const frContent = (await vol.promises.readFile(frPath)).toString('utf-8')

    expect(deContent).toContain('"title": "Willkommen"')
    expect(frContent).toContain('"title": "Bienvenue"')
  })

  it('should write JSON5 when outputFormat is omitted but file extension is .json5', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('key1', 'Value')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json5',
        // outputFormat is not specified
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.json5')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    // Should be valid JSON5 (trailing comma allowed, comments can be added later)
    expect(fileContent).toContain('"key1": "Value"')
    expect(fileContent.trim().startsWith('{')).toBe(true)
    expect(fileContent.trim().endsWith('}')).toBe(true)
  })

  it('should write JSON (not JSON5) when outputFormat is json5 but file extension is .json', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('key1', 'Value')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        outputFormat: 'json5',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.json')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    // Should still be valid JSON (no comments, no trailing comma)
    expect(fileContent).toContain('"key1": "Value"')
    expect(fileContent.trim().startsWith('{')).toBe(true)
    expect(fileContent.trim().endsWith('}')).toBe(true)
    // Should not contain any comments
    expect(fileContent).not.toContain('//')
  })
})
