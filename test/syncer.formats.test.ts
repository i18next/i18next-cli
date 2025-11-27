import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runSyncer } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve, dirname } from 'path'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'

const TEMP_DIR = resolve(process.cwd(), 'test/temp_syncer_files')

vi.mock('glob', () => ({ glob: vi.fn() }))

describe('syncer: file formats and namespace merging', () => {
  // Create a temporary directory for our real files before tests run
  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(TEMP_DIR, { recursive: true })
  })

  // Clean up the temporary directory after tests run
  afterEach(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true })
  })

  it('should correctly sync JavaScript ESM files using the real file system', async () => {
    // Define paths within our temp directory
    const enPath = resolve(TEMP_DIR, 'locales/en/translation.js')
    const dePath = resolve(TEMP_DIR, 'locales/de/translation.js')

    // Mock glob to find the real temp file
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    // Create the directories and write the real files
    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enContent = 'export default {\n  "key1": "Value 1",\n  "key2": "Value 2"\n};\n'
    const deContent = 'export default {\n  "key1": "Wert 1"\n};\n'
    await writeFile(enPath, enContent)
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        // Point the output to our temp directory
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.js`,
        outputFormat: 'js-esm',
      },
    }

    await runSyncer(config)

    // Read the updated file from the real file system
    const updatedDeContent = await readFile(dePath, 'utf-8')

    expect(updatedDeContent).toContain('"key2": ""')
    expect(updatedDeContent).toContain('export default')
  })

  it('should correctly sync TypeScript files using the real file system', async () => {
    // Define paths within our temp directory
    const enPath = resolve(TEMP_DIR, 'locales/en/index.ts')
    const dePath = resolve(TEMP_DIR, 'locales/de/index.ts')

    // Mock glob to find the real temp file
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    // Create the directories and write the real files
    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enContent = `export default {
  Accordion: {
    clickToClose: ', click to close details',
    clickToOpen: ', click to open details',
  },
  Button: {
    save: 'Save',
    cancel: 'Cancel',
  },
} as const;`

    const deContent = `export default {
  Accordion: {
    clickToClose: ', klicken zum Schließen',
    clickToOpen: ', klicken zum Öffnen',
  },
} as const;`

    await writeFile(enPath, enContent)
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.ts`,
        outputFormat: 'ts',
        defaultNS: 'index',
      },
    }

    await runSyncer(config)

    // Read the updated file from the real file system
    const updatedDeContent = await readFile(dePath, 'utf-8')

    // Should contain the missing keys with empty values (checking for JSON format)
    expect(updatedDeContent).toContain('Button')
    expect(updatedDeContent).toContain('"save": ""')
    expect(updatedDeContent).toContain('"cancel": ""')
    // Should preserve existing translations
    expect(updatedDeContent).toContain('"clickToClose": ", klicken zum Schließen"')
    expect(updatedDeContent).toContain('"clickToOpen": ", klicken zum Öffnen"')
    // Should maintain TypeScript format
    expect(updatedDeContent).toContain('export default')
    expect(updatedDeContent).toContain('as const')
  })

  it('should correctly sync merged namespace files', async () => {
    const enPath = resolve(TEMP_DIR, 'locales/en.json')
    const dePath = resolve(TEMP_DIR, 'locales/de.json')

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enTranslations = {
      translation: { key1: 'Value 1', key2: 'Value 2' },
      common: { keyA: 'Value A' },
    }
    const deTranslations = {
      translation: { key1: 'Wert 1' },
      common: { keyA: 'Wert A', keyB: 'Extra Key' },
    }
    await writeFile(enPath, JSON.stringify(enTranslations))
    await writeFile(dePath, JSON.stringify(deTranslations))

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}.json`,
        mergeNamespaces: true,
      },
    }

    await runSyncer(config)

    const updatedDeContent = await readFile(dePath, 'utf-8')
    const updatedDeJson = JSON.parse(updatedDeContent)

    expect(updatedDeJson).toEqual({
      translation: { key1: 'Wert 1', key2: '' },
      common: { keyA: 'Wert A' },
    })
  })

  it('should correctly sync JSON5 files and preserve comments', async () => {
    const enPath = resolve(TEMP_DIR, 'locales/en/translation.json5')
    const dePath = resolve(TEMP_DIR, 'locales/de/translation.json5')

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enContent = `{
      // English comment
      "key1": "Value 1",
      "key2": "Value 2"
    }`
    const deContent = `{
      // German comment
      "key1": "Wert 1"
    }`
    await writeFile(enPath, enContent)
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.json5`,
        outputFormat: 'json5',
      },
    }

    await runSyncer(config)

    const updatedDeContent = await readFile(dePath, 'utf-8')
    expect(updatedDeContent).toContain('// German comment')
    expect(updatedDeContent).toContain('"key2": ""')
    expect(updatedDeContent.trim().startsWith('{')).toBe(true)
    expect(updatedDeContent.trim().endsWith('}')).toBe(true)
  })

  it('should sync JSON5 when outputFormat is omitted but file extension is .json5', async () => {
    const enPath = resolve(TEMP_DIR, 'locales/en/translation.json5')
    const dePath = resolve(TEMP_DIR, 'locales/de/translation.json5')

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enContent = `{
      "key1": "Value 1"
    }`
    const deContent = `{
      "key1": "Wert 1"
    }`
    await writeFile(enPath, enContent)
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.json5`,
        // outputFormat omitted
      },
    }

    await runSyncer(config)

    const updatedDeContent = await readFile(dePath, 'utf-8')
    expect(updatedDeContent).toContain('"key1": "Wert 1"')
    expect(updatedDeContent.trim().startsWith('{')).toBe(true)
    expect(updatedDeContent.trim().endsWith('}')).toBe(true)
  })

  it('should sync as JSON (not JSON5) when outputFormat is json5 but file extension is .json', async () => {
    const enPath = resolve(TEMP_DIR, 'locales/en/translation.json')
    const dePath = resolve(TEMP_DIR, 'locales/de/translation.json')

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue([enPath])

    await mkdir(dirname(enPath), { recursive: true })
    await mkdir(dirname(dePath), { recursive: true })

    const enContent = `{
      "key1": "Value 1"
    }`
    const deContent = `{
      "key1": "Wert 1"
    }`
    await writeFile(enPath, enContent)
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.json`,
        outputFormat: 'json5',
      },
    }

    await runSyncer(config)

    const updatedDeContent = await readFile(dePath, 'utf-8')
    expect(updatedDeContent).toContain('"key1": "Wert 1"')
    expect(updatedDeContent.trim().startsWith('{')).toBe(true)
    expect(updatedDeContent.trim().endsWith('}')).toBe(true)
    expect(updatedDeContent).not.toContain('//')
  })
})
