import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runLocizeSync } from '../src/locize'
import { pathEndsWith } from './utils/path'
import type { I18nextToolkitConfig } from '../src/types'
import { execa } from 'execa'
import inquirer from 'inquirer'

vi.mock('inquirer')
vi.mock('execa')

describe('locize', () => {
  let consoleErrorSpy: any
  let exitSpy: any
  let mockConfig: I18nextToolkitConfig

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')

    mockConfig = {
      locales: ['en'],
      extract: {
        input: ['src/'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      locize: {
        projectId: 'test-project-id',
      },
    }

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should call execa with the correct arguments for a successful sync', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
    await runLocizeSync(mockConfig)
    // Find the call that runs the actual `sync` command (the first call is `--version`)
    const calls = vi.mocked(execa).mock.calls
    const syncCall = calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
    expect(syncCall).toBeDefined()
    const syncArgs = syncCall![1] as string[]
    expect(syncArgs).toEqual(expect.arrayContaining(['sync', '--project-id', 'test-project-id']))

    // Ensure the --path value ends with 'locales' in a cross-platform safe way
    const pathIndex = syncArgs.findIndex(a => a === '--path')
    expect(pathIndex).toBeGreaterThan(-1)
    const pathValue = syncArgs[pathIndex + 1]
    expect(pathEndsWith(pathValue, '/locales')).toBe(true)
    // Ensure options were passed (stdio: 'pipe')
    const syncOptions = (syncCall as unknown as any[])[2]
    expect(syncOptions).toEqual(expect.objectContaining({ stdio: 'pipe' }))
  })

  it('should exit gracefully if locize-cli is not found', async () => {
    const error: any = new Error('Not found')
    error.code = 'ENOENT'
    vi.mocked(execa).mockRejectedValue(error)
    await runLocizeSync(mockConfig)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('`locize-cli` command not found'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should trigger interactive setup on auth failure and retry with new credentials', async () => {
    const authError: any = new Error('Auth failed')
    authError.stderr = 'missing required argument'
    // Mock the entire sequence of execa calls
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: 'v1.0.0', stderr: '' } as any)   // 1. `checkLocizeCliExists` succeeds
      .mockRejectedValueOnce(authError)                                 // 2. First `sync` call fails
      .mockResolvedValueOnce({ stdout: 'Success!', stderr: '' } as any) // 3. Second `sync` call (retry) succeeds

    vi.mocked(inquirer.prompt).mockResolvedValue({
      projectId: 'new-project-id',
      apiKey: 'new-api-key',
      version: 'latest',
      save: false,
    })

    await runLocizeSync(mockConfig)

    expect(execa).toHaveBeenCalledTimes(3)

    const secondCallArgs = vi.mocked(execa).mock.calls[2][1]
    expect(secondCallArgs).toContain('new-project-id')
    expect(secondCallArgs).toContain('new-api-key')
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
