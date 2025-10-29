import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runLocizeSync } from '../src/locize'
import { execa } from 'execa'
import { pathEndsWith, pathContains } from './utils/path'

// Mock execa as a named export (no default export in this environment)
vi.mock('execa', () => {
  return {
    execa: vi.fn().mockResolvedValue({ stdout: 'locize 1.0.0' }),
  }
})
const execaMock = vi.mocked(execa)

describe('locize: derive base path from functional extract.output', () => {
  // use execaMock inside tests

  beforeEach(() => {
    vi.clearAllMocks()
    // Make cwd deterministic
    vi.spyOn(process, 'cwd').mockReturnValue('/project')

    // Prevent tests from exiting the process when code under test calls process.exit
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {}) as any)
    // Silence error output during the test run
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should derive a sensible --path when extract.output is a function', async () => {
    const config: any = {
      locales: ['en', 'de'],
      extract: {
        primaryLanguage: 'en',
        input: ['src/**/*.ts'],
        // function returns per-namespace package-local paths
        output: (lng: string, ns?: string) => `packages/${ns ?? 'shared'}/locales/${lng}/${ns ?? 'shared'}.json`,
      },
      locize: {
        projectId: 'P',
        apiKey: 'K',
        version: 'v1',
      },
    }

    await runLocizeSync(config, { updateValues: true })

    // execa should have been called at least once
    expect(execaMock).toHaveBeenCalled()
    // Find the call that runs the actual locize command (the one with 'sync' as first arg)
    const syncCall = execaMock.mock.calls.find(call => call[0] === 'locize' && Array.isArray(call[1]) && (call[1] as string[]).includes('sync'))
    expect(syncCall).toBeDefined()

    // The command args should include --path and the derived base directory for the sample output
    const args = syncCall![1] as string[]
    const pathIndex = args.indexOf('--path')
    expect(pathIndex).toBeGreaterThan(-1)

    const derivedPath = args[pathIndex + 1]
    // For sample output packages/<ns>/locales/en/<ns>.json, the base candidate becomes 'packages/<ns>/locales'
    // Using primaryLanguage 'en' and process.cwd '/project' we expect resolved path to include '/project/packages'
    expect(pathContains(derivedPath, '/project/packages')).toBe(true)
    expect(pathEndsWith(derivedPath, '/locales')).toBe(true)
  })
})
