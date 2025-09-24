import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runMigrator } from '../src/migrator'
import { resolve } from 'path'

// Mock fs/promises to use the in-memory file system
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// We need to mock the dynamic import() used to load the old config
vi.mock('import', () => ({
  default: vi.fn(),
}))

const oldConfigPath = resolve(process.cwd(), 'i18next-parser.config.js')
const newConfigPath = resolve(process.cwd(), 'i18next.config.ts')

describe('migrator', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    // Spy on console logs to verify output
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should successfully migrate a legacy config file', async () => {
  // 1. Setup: Create a fake legacy config file
    const legacyConfig = {
      locales: ['en', 'fr'],
      output: 'locales/$LOCALE/$NAMESPACE.json',
      input: ['src/**/*.js'], // Using an array for input
    }
    vol.fromJSON({
      [oldConfigPath]: `module.exports = ${JSON.stringify(legacyConfig)}`,
    })
    vi.doMock(oldConfigPath, () => ({ default: legacyConfig }))

    // 2. Action: Run the migrator
    await runMigrator()

    // 3. Assertions
    const newConfigFileContent = String(await vol.promises.readFile(newConfigPath, 'utf-8'))

    // Make the assertion robust by parsing the generated object
    const objectStringMatch = newConfigFileContent.match(/defineConfig\(([\s\S]*)\)/)
    expect(objectStringMatch).not.toBeNull()

    const generatedConfig = JSON.parse(objectStringMatch![1])

    expect(console.log).toHaveBeenCalledWith('✅ Success! Migration complete.')
    expect(generatedConfig.locales).toEqual(['en', 'fr'])
    expect(generatedConfig.extract.input).toEqual(['src/**/*.js']) // Correctly asserts the array
    expect(generatedConfig.extract.output).toBe('locales/{{language}}/{{namespace}}.json')
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
    expect(console.warn).toHaveBeenCalledWith(
      'Warning: A new configuration file already exists at "i18next.config.ts". Migration skipped to avoid overwriting.'
    )
  })

  it('should do nothing if no legacy config file is found', async () => {
    // 1. Setup: The virtual file system is empty

    // 2. Action: Run the migrator
    await runMigrator()

    // 3. Assertions
    expect(console.log).toHaveBeenCalledWith('No i18next-parser.config.js found. Nothing to migrate.')
    // Assert that no new file was created by checking if access throws an error
    await expect(vol.promises.access(newConfigPath)).rejects.toThrow()
  })
})
