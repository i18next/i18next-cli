import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock all the action handlers that cli.ts imports and calls
const mockRunStatus = vi.fn()
const mockRunExtractor = vi.fn()
const mockRunSyncer = vi.fn()
const mockRunTypesGenerator = vi.fn()
const mockRunLinter = vi.fn()
const mockRunInit = vi.fn()
const mockRunMigrator = vi.fn()
const mockRunLocizeSync = vi.fn()

// Mock the modules that contain the service functions
vi.mock('../src/status', () => ({ runStatus: mockRunStatus }))
vi.mock('../src/extractor', () => ({ runExtractor: mockRunExtractor }))
vi.mock('../src/syncer', () => ({ runSyncer: mockRunSyncer }))
vi.mock('../src/types-generator', () => ({ runTypesGenerator: mockRunTypesGenerator }))
vi.mock('../src/linter', () => ({ runLinter: mockRunLinter }))
vi.mock('../src/init', () => ({ runInit: mockRunInit }))
vi.mock('../src/migrator', () => ({ runMigrator: mockRunMigrator }))
vi.mock('../src/locize', () => ({ runLocizeSync: mockRunLocizeSync }))

// Mock config loaders as they are a common dependency
const mockEnsureConfig = vi.fn()
const mockLoadConfig = vi.fn()
vi.mock('../src/config', () => ({
  ensureConfig: mockEnsureConfig,
  loadConfig: mockLoadConfig,
}))

describe('CLI command parsing and dispatching', () => {
  let originalArgv: string[]
  let exitSpy: any

  // A valid, minimal config to prevent crashes
  const validMockConfig = {
    locales: ['en'],
    extract: {
      input: ['src/'],
      output: 'locales/{{language}}/{{namespace}}.json',
    }
  }

  beforeEach(() => {
    vi.resetAllMocks()
    originalArgv = process.argv
    process.argv = []
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
  })

  it('should parse the "status" command and call runStatus', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'status', 'en']
    const config = { locales: ['en'], extract: {} }
    mockLoadConfig.mockResolvedValue(config)

    await import('../src/cli')

    expect(mockRunStatus).toHaveBeenCalledTimes(1)
    // Assert the actual two-argument call signature
    expect(mockRunStatus).toHaveBeenCalledWith(config, { detail: 'en', namespace: undefined })
  })

  it('should parse the "extract --ci" command and exit with error if files are updated', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'extract', '--ci']

    mockEnsureConfig.mockResolvedValue(validMockConfig)
    // Simulate runExtractor returning `true` (files were updated)
    mockRunExtractor.mockResolvedValue(true)

    await import('../src/cli')

    // Allow async operations in the action handler to complete
    await new Promise(resolve => setImmediate(resolve))

    // Assert that the CI-specific exit code is called
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should parse the "sync" command and call runSyncer', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'sync']
    mockEnsureConfig.mockResolvedValue({})
    await import('../src/cli')
    expect(mockRunSyncer).toHaveBeenCalledTimes(1)
  })

  it('should parse the "types" command and call runTypesGenerator', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'types']
    mockEnsureConfig.mockResolvedValue({ types: { input: [] } })
    await import('../src/cli')
    expect(mockRunTypesGenerator).toHaveBeenCalledTimes(1)
  })

  it('should parse the "lint" command and call runLinter', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'lint']
    mockLoadConfig.mockResolvedValue({ extract: { input: [] } })
    await import('../src/cli')
    expect(mockRunLinter).toHaveBeenCalledTimes(1)
  })

  it('should parse the "init" command and call runInit', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'init']
    await import('../src/cli')
    expect(mockRunInit).toHaveBeenCalledTimes(1)
  })

  it('should parse the "migrate-config" command and call runMigrator', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'migrate-config']
    await import('../src/cli')
    expect(mockRunMigrator).toHaveBeenCalledTimes(1)
  })

  it('should parse the "locize-sync" command with options', async () => {
    vi.resetModules()
    process.argv = ['node', 'cli.ts', 'locize-sync', '--dry-run', '--update-values']
    mockEnsureConfig.mockResolvedValue({})
    await import('../src/cli')
    expect(mockRunLocizeSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true, updateValues: true })
    )
  })
})
