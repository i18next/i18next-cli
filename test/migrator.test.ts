import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrator } from '../src/migrator'
import { resolve } from 'path'

// Mock fs/promises to use the in-memory file system
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock config module completely
vi.mock('../src/config', () => ({
  getJitiAliases: vi.fn().mockResolvedValue({}),
}))

// Mock jiti completely
vi.mock('jiti', () => ({
  createJiti: vi.fn(() => ({
    import: vi.fn(),
  })),
}))

// Mock node:url
vi.mock('node:url', () => ({
  pathToFileURL: vi.fn((path) => ({ href: `file://${path}` })),
}))

const oldConfigPath = resolve(process.cwd(), 'i18next-parser.config.js')
const newConfigPath = resolve(process.cwd(), 'i18next.config.ts')

describe('migrator', () => {
  let consoleLogSpy: any
  let consoleWarnSpy: any

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()

    // Spy on console methods
    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Set up a clean working directory
    vol.fromJSON({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should do nothing if no legacy config file is found', async () => {
    // 1. Setup: The virtual file system is empty (no config files)

    // 2. Action: Run the migrator
    await runMigrator()

    // 3. Assertions
    expect(consoleLogSpy).toHaveBeenCalledWith('No i18next-parser.config.* found. Nothing to migrate.')
    expect(consoleLogSpy).toHaveBeenCalledWith('Tried: i18next-parser.config.js, .mjs, .cjs, .ts')

    // Assert that no new file was created
    expect(vol.existsSync(newConfigPath)).toBe(false)
  })

  it('should skip migration if a new config file already exists', async () => {
    // 1. Setup: Create both old and new config files
    vol.fromJSON({
      [oldConfigPath]: 'module.exports = {}',
      [newConfigPath]: 'export default {}',
    })

    // 2. Action: Run the migrator
    await runMigrator()

    // 3. Assertions
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Warning: A new configuration file already exists at "i18next.config.ts". Migration skipped to avoid overwriting.'
    )
  })

  it('should handle custom config path with no extension', async () => {
    const customConfigPath = 'my-custom-config'
    const fullCustomPathJs = resolve(process.cwd(), `${customConfigPath}.js`)

    // Create a custom config file with .js extension
    vol.fromJSON({
      [fullCustomPathJs]: 'module.exports = { locales: ["en"] }',
    })

    // Action: Run migrator with custom path (no extension)
    await runMigrator(customConfigPath)

    // Assertions: Should find the file and log attempting to migrate
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Attempting to migrate legacy config from:')
    )
  })

  it('should warn when custom config path is not found', async () => {
    const customConfigPath = 'nonexistent-config'

    // Action: Run migrator with non-existent custom path
    await runMigrator(customConfigPath)

    // Assertions
    expect(consoleLogSpy).toHaveBeenCalledWith(
      `No legacy config file found at or near: ${customConfigPath}`
    )
    expect(consoleLogSpy).toHaveBeenCalledWith('Tried extensions: .js, .mjs, .cjs, .ts')
  })

  it('should support -c flag for migrate-config command', async () => {
    // This test verifies that the CLI correctly accepts both positional and -c flag arguments
    // We don't need to test the actual migration logic here, just the argument parsing

    const customConfigPath = 'custom.config.mjs'
    const fullCustomPath = resolve(process.cwd(), customConfigPath)

    vol.fromJSON({
      [fullCustomPath]: 'export default { locales: ["en"] }',
    })

    // Action: Run migrator with custom path
    await runMigrator(customConfigPath)

    // Assertions: Should attempt to migrate from the custom path
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Attempting to migrate legacy config from:')
    )
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(customConfigPath)
    )
  })

  // Integration test that works without complex mocking
  it('should detect different file extensions in the correct order', async () => {
    const basePath = 'test-config'
    const jsPath = resolve(process.cwd(), `${basePath}.js`)
    const mjsPath = resolve(process.cwd(), `${basePath}.mjs`)
    const cjsPath = resolve(process.cwd(), `${basePath}.cjs`)
    const tsPath = resolve(process.cwd(), `${basePath}.ts`)

    // Create multiple config files
    vol.fromJSON({
      [jsPath]: 'module.exports = { locales: ["en"] }',
      [mjsPath]: 'export default { locales: ["en"] }',
      [cjsPath]: 'module.exports = { locales: ["en"] }',
      [tsPath]: 'export default { locales: ["en"] }',
    })

    // Action: Run migrator with base path (no extension)
    await runMigrator(basePath)

    // Assertions: Should find the first available file (.js comes first in the extension list)
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Attempting to migrate legacy config from:')
    )
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${basePath}.js`)
    )
  })
})

// These tests run the migrator against real files: the module reads process.cwd() when it loads,
// so it is imported after the chdir, and the mocks above that fake the file system are lifted.
describe('migrator: mapping of the i18next-parser options', () => {
  const cwd = process.cwd()
  let dir: string
  let warnings: string[]
  // The file system mock above also covers this module, so take the real one
  let fs: typeof import('node:fs/promises')

  const migrate = async (legacy: string) => {
    await fs.writeFile(join(dir, 'i18next-parser.config.mjs'), legacy)
    process.chdir(dir)
    vi.resetModules()
    vi.doUnmock('fs/promises')
    vi.doUnmock('node:url')
    const { runMigrator } = await import('../src/migrator')
    await runMigrator()
    const out = await fs.readFile(join(dir, 'i18next.config.ts'), 'utf-8')
    // The generated file is `defineConfig(<json>);`
    const config = JSON.parse(out.slice(out.indexOf('defineConfig(') + 13, out.lastIndexOf(');')))
    return { out, extract: config.extract }
  }

  beforeEach(async () => {
    fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    dir = await fs.mkdtemp(join(tmpdir(), 'i18next-cli-migrate-'))
    warnings = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation((msg: string) => { warnings.push(String(msg)) })
  })

  afterEach(async () => {
    process.chdir(cwd)
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('maps keepRemoved: true to removeUnusedKeys: false', async () => {
    const { extract } = await migrate('export default { keepRemoved: true }')
    expect(extract.removeUnusedKeys).toBe(false)
    expect(warnings.some(w => w.includes('preservePatterns'))).toBe(false)
  })

  it('leaves removeUnusedKeys alone without keepRemoved', async () => {
    const { extract } = await migrate('export default { locales: ["en"] }')
    expect(extract).not.toHaveProperty('removeUnusedKeys')
  })

  it('maps a keepRemoved pattern list to removeUnusedKeys: false and warns with the patterns', async () => {
    const { extract } = await migrate("export default { keepRemoved: ['^errors_', /^dyn_/] }")
    expect(extract.removeUnusedKeys).toBe(false)
    const warning = warnings.find(w => w.includes('preservePatterns'))
    expect(warning).toContain('^errors_')
    expect(warning).toContain('/^dyn_/')
    expect(warning).toContain('globs')
  })

  it('copies pluralSeparator and indentation', async () => {
    const { extract } = await migrate("export default { pluralSeparator: '-', indentation: 4 }")
    expect(extract.pluralSeparator).toBe('-')
    expect(extract.indentation).toBe(4)
    expect(extract).not.toHaveProperty('disablePlurals')
  })

  it('maps pluralSeparator: false to disablePlurals: true', async () => {
    const { extract } = await migrate('export default { pluralSeparator: false }')
    expect(extract.disablePlurals).toBe(true)
    expect(extract).not.toHaveProperty('pluralSeparator')
  })

  it('collects functions, componentFunctions and namespaceFunctions from all lexer entries', async () => {
    const { extract } = await migrate(`export default { lexers: {
      js: [{ lexer: 'JsxLexer', functions: ['t', '__'], componentFunctions: ['Trans'], namespaceFunctions: ['useTranslation'] }],
      ts: ['JavascriptLexer'],
      tsx: [{ lexer: 'JsxLexer', functions: ['__', 'translate'], componentFunctions: ['Translation'], namespaceFunctions: ['withTranslation'] }, 'JsxLexer'],
      hbs: ['HandlebarsLexer'],
      default: [{ lexer: 'JavascriptLexer', functions: ['i18n'] }],
    } }`)
    expect(extract.functions).toEqual(['t', '__', 'translate', 'i18n', '*.t'])
    expect(extract.transComponents).toEqual(['Trans', 'Translation'])
    expect(extract.useTranslationNames).toEqual(['useTranslation', 'getT', 'useT', 'withTranslation'])
  })

  it('keeps t, Trans and the hooks next to custom lexer names, as i18next-parser does for other file types', async () => {
    const { extract } = await migrate(`export default { lexers: {
      js: [{ lexer: 'JsxLexer', functions: ['translate'], componentFunctions: ['T'], namespaceFunctions: ['useMyTranslation'] }],
    } }`)
    expect(extract.functions).toEqual(['t', 'translate', '*.t'])
    expect(extract.transComponents).toEqual(['Trans', 'T'])
    expect(extract.useTranslationNames).toEqual(['useTranslation', 'getT', 'useT', 'useMyTranslation'])
  })

  it('keeps the defaults when the lexers carry no options', async () => {
    const { extract } = await migrate("export default { lexers: { js: ['JsxLexer'], default: ['JavascriptLexer'] } }")
    expect(extract.functions).toEqual(['t', '*.t'])
    expect(extract.transComponents).toEqual(['Trans'])
    expect(extract).not.toHaveProperty('useTranslationNames')
  })

  it('writes sort: false so the files keep their order', async () => {
    expect((await migrate('export default {}')).extract.sort).toBe(false)
  })

  it('keeps sort: true when the parser config had it', async () => {
    expect((await migrate('export default { sort: true }')).extract.sort).toBe(true)
  })

  it.each([
    ['customValueTemplate', "{ customValueTemplate: { message: 'Hello' } }"],
    ['resetDefaultValueLocale', "{ resetDefaultValueLocale: 'en' }"],
    ['defaultValue', '{ defaultValue: (locale, ns, key) => key }'],
    ['failOnUpdate', '{ failOnUpdate: true }'],
    ['createOldCatalogs', '{ createOldCatalogs: true }'],
  ])('warns once about %s', async (option, legacy) => {
    await migrate(`export default ${legacy}`)
    expect(warnings.filter(w => w.includes(`"${option}"`))).toHaveLength(1)
  })

  it('suggests extract --ci for failOnUpdate', async () => {
    await migrate('export default { failOnUpdate: true }')
    expect(warnings.find(w => w.includes('failOnUpdate'))).toContain('extract --ci')
  })

  it('does not warn about options that are not used', async () => {
    await migrate('export default { createOldCatalogs: false, defaultValue: "", failOnUpdate: false }')
    expect(warnings.filter(w => /customValueTemplate|resetDefaultValueLocale|defaultValue|failOnUpdate|createOldCatalogs/.test(w))).toEqual([])
  })
})
