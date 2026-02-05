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

describe('extractor - runExtractor: YAML support', () => {
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

  it('should write files in YAML format with .yaml extension', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
      },
    }

    await runExtractor(config)
    const translationPath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const ns1Path = resolve(process.cwd(), 'locales/en/ns1.yaml')
    const translationContent = (await vol.promises.readFile(translationPath)).toString('utf-8')
    const ns1Content = (await vol.promises.readFile(ns1Path)).toString('utf-8')

    expect(translationContent).toContain('key1: Value 1')
    expect(ns1Content).toContain('keyA: Value A')
  })

  it('should write files in YAML format with .yml extension', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yml',
        outputFormat: 'yaml',
      },
    }

    await runExtractor(config)
    const translationPath = resolve(process.cwd(), 'locales/en/translation.yml')
    const translationContent = (await vol.promises.readFile(translationPath)).toString('utf-8')

    expect(translationContent).toContain('key1: Value 1')
  })

  it('should use custom indentation for YAML output', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('nested.key', 'Value')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
        indentation: 4,
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    // With 4-space indentation, nested key should be indented
    expect(fileContent).toContain('nested:')
    expect(fileContent).toContain('    key: Value')
  })

  it('should read and update existing YAML files', async () => {
    const existingYaml = `key1: Old Value
key2: Should be removed
`
    vol.fromJSON({
      '/src/App.tsx': `
        t('key1', 'New Value')
        t('newKey', 'Brand new')
      `,
      '/locales/en/translation.yaml': existingYaml,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    // Default behavior preserves existing values (key1 stays "Old Value")
    expect(fileContent).toContain('key1: Old Value')
    expect(fileContent).toContain('newKey: Brand new')
    // key2 is removed since it's not in source
    expect(fileContent).not.toContain('key2')
  })

  it('should sync primary language defaults with YAML files when syncPrimaryWithDefaults is true', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        t('app.title', 'Welcome to My App')
        t('app.subtitle', 'Best app ever')
      `,
      '/locales/en/translation.yaml': `app:
  title: Old Welcome Message
  subtitle: Old subtitle
`,
      '/locales/de/translation.yaml': `app:
  title: Alte Willkommensnachricht
`,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['/src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
        defaultNS: 'translation',
      },
    }

    await runExtractor(config, { syncPrimaryWithDefaults: true })

    const enPath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const dePath = resolve(process.cwd(), 'locales/de/translation.yaml')
    const enContent = (await vol.promises.readFile(enPath)).toString('utf-8')
    const deContent = (await vol.promises.readFile(dePath)).toString('utf-8')

    expect(enContent).toContain('title: Welcome to My App')
    expect(enContent).toContain('subtitle: Best app ever')
    expect(deContent).toContain('title: Alte Willkommensnachricht')
    expect(deContent).toContain('subtitle: ""')
  })

  it('should write YAML when outputFormat is omitted but file extension is .yaml', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('key1', 'Value 1')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        // outputFormat is omitted - should infer from extension
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('key1: Value 1')
    // Should be YAML format (no JSON braces)
    expect(fileContent).not.toContain('{')
    expect(fileContent).not.toContain('}')
  })

  it('should write YAML when outputFormat is omitted but file extension is .yml', async () => {
    vol.fromJSON({ '/src/App.tsx': "t('key1', 'Value 1')" })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yml',
        // outputFormat is omitted - should infer from extension
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('key1: Value 1')
    // Should be YAML format (no JSON braces)
    expect(fileContent).not.toContain('{')
    expect(fileContent).not.toContain('}')
  })

  it('should handle nested objects correctly in YAML', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        t('level1.level2.level3', 'Deep value')
        t('level1.sibling', 'Sibling value')
      `,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('level1:')
    expect(fileContent).toContain('level2:')
    expect(fileContent).toContain('level3: Deep value')
    expect(fileContent).toContain('sibling: Sibling value')
  })

  it('should merge all namespaces into a single YAML file per language', async () => {
    vol.fromJSON({ '/src/App.tsx': sampleCode })
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}.yaml',
        outputFormat: 'yaml',
        mergeNamespaces: true,
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    expect(fileContent).toContain('translation:')
    expect(fileContent).toContain('ns1:')
    expect(fileContent).toContain('key1: Value 1')
    expect(fileContent).toContain('keyA: Value A')
  })

  it('should handle special characters in YAML values', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        t('colon', 'Value: with colon')
        t('quote', "Value with 'quotes'")
        t('multiline', 'Line 1\\nLine 2')
      `,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/App.tsx'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
      },
    }

    await runExtractor(config)
    const filePath = resolve(process.cwd(), 'locales/en/translation.yaml')
    const fileContent = (await vol.promises.readFile(filePath)).toString('utf-8')

    // YAML should properly quote/escape special characters
    expect(fileContent).toContain('colon')
    expect(fileContent).toContain('quote')
    expect(fileContent).toContain('multiline')
  })

  it('should synchronize secondary YAML files using runSyncer', async () => {
    vol.fromJSON({
      '/locales/en/translation.yaml': `app:
  title: Welcome
  description: App description
`,
      '/locales/de/translation.yaml': `app:
  title: Willkommen
`,
      '/locales/fr/translation.yaml': `app:
  title: Bienvenue
`,
    })

    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/locales/en/translation.yaml'])

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.yaml',
        outputFormat: 'yaml',
        defaultNS: 'translation',
      },
    }

    await runSyncer(config)

    const dePath = resolve(process.cwd(), 'locales/de/translation.yaml')
    const frPath = resolve(process.cwd(), 'locales/fr/translation.yaml')
    const deContent = (await vol.promises.readFile(dePath)).toString('utf-8')
    const frContent = (await vol.promises.readFile(frPath)).toString('utf-8')

    // Both should now have the description key (empty for secondary languages)
    expect(deContent).toContain('description: ""')
    expect(frContent).toContain('description: ""')
    // Existing translations should be preserved
    expect(deContent).toContain('title: Willkommen')
    expect(frContent).toContain('title: Bienvenue')
  })
})
