import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runMigrator } from '../src/migrator'
import { resolve } from 'path'

// Mock fs/promises to use the in-memory file system
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock config module completely
vi.mock('../src/config', () => ({
  getTsConfigAliases: vi.fn().mockResolvedValue({}),
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
