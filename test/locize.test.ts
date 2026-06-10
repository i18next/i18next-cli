import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runLocizeSync, LocizeCommandError, maskApiKey } from '../src/locize'
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

  it('should forward --reference-language-only false when --src-lng-only is "false"', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
    await runLocizeSync(mockConfig, { srcLngOnly: 'false' })
    const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
    const syncArgs = syncCall![1] as string[]
    const idx = syncArgs.findIndex(a => a === '--reference-language-only')
    expect(idx).toBeGreaterThan(-1)
    expect(syncArgs[idx + 1]).toBe('false')
  })

  it('should forward --reference-language-only true when --src-lng-only is "true"', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
    await runLocizeSync(mockConfig, { srcLngOnly: 'true' })
    const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
    const syncArgs = syncCall![1] as string[]
    const idx = syncArgs.findIndex(a => a === '--reference-language-only')
    expect(idx).toBeGreaterThan(-1)
    expect(syncArgs[idx + 1]).toBe('true')
  })

  it('should forward the boolean from config (sourceLanguageOnly: false)', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
    await runLocizeSync({ ...mockConfig, locize: { ...mockConfig.locize, sourceLanguageOnly: false } })
    const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
    const syncArgs = syncCall![1] as string[]
    const idx = syncArgs.findIndex(a => a === '--reference-language-only')
    expect(idx).toBeGreaterThan(-1)
    expect(syncArgs[idx + 1]).toBe('false')
  })

  it('should not forward --reference-language-only when --src-lng-only is omitted', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
    await runLocizeSync(mockConfig)
    const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
    const syncArgs = syncCall![1] as string[]
    expect(syncArgs).not.toContain('--reference-language-only')
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

  describe('auto-translate passthrough', () => {
    const getSyncArgs = () => {
      const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
      return syncCall![1] as string[]
    }

    it('forwards --auto-translate true from CLI options', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      await runLocizeSync(mockConfig, { autoTranslate: true })
      const args = getSyncArgs()
      const idx = args.findIndex(a => a === '--auto-translate')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe('true')
    })

    it('forwards --auto-translate false when explicitly disabled', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      await runLocizeSync(mockConfig, { autoTranslate: 'false' })
      const args = getSyncArgs()
      const idx = args.findIndex(a => a === '--auto-translate')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe('false')
    })

    it('does not forward --auto-translate when omitted', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      await runLocizeSync(mockConfig)
      expect(getSyncArgs()).not.toContain('--auto-translate')
    })

    it('reads autoTranslate and autoTranslateReview from config', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      mockConfig.locize = { ...mockConfig.locize, autoTranslate: true, autoTranslateReview: true }
      await runLocizeSync(mockConfig)
      const args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--auto-translate') + 1]).toBe('true')
      expect(args[args.findIndex(a => a === '--auto-translate-review') + 1]).toBe('true')
    })

    it('CLI option takes precedence over config for autoTranslate', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      mockConfig.locize = { ...mockConfig.locize, autoTranslate: true }
      await runLocizeSync(mockConfig, { autoTranslate: 'false' })
      const args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--auto-translate') + 1]).toBe('false')
    })

    it('joins autoTranslateLanguages array into a comma-separated list', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      mockConfig.locize = { ...mockConfig.locize, autoTranslateLanguages: ['de', 'fr'] }
      await runLocizeSync(mockConfig)
      const args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--auto-translate-languages') + 1]).toBe('de,fr')
    })
  })

  describe('throwOnError', () => {
    it('throws a LocizeCommandError instead of exiting on command failure', async () => {
      const cmdError: any = new Error('boom')
      cmdError.stderr = 'auto-translation is not enabled for this project'
      vi.mocked(execa)
        .mockResolvedValueOnce({ stdout: 'v1.0.0', stderr: '' } as any) // version check
        .mockRejectedValueOnce(cmdError)

      await expect(runLocizeSync(mockConfig, { throwOnError: true })).rejects.toThrow(LocizeCommandError)
      expect(exitSpy).not.toHaveBeenCalled()
      expect(inquirer.prompt).not.toHaveBeenCalled() // no interactive credential retry
    })

    it('exposes stderr on the thrown error', async () => {
      const cmdError: any = new Error('boom')
      cmdError.stderr = 'machine translation not activated'
      vi.mocked(execa)
        .mockResolvedValueOnce({ stdout: 'v1.0.0', stderr: '' } as any)
        .mockRejectedValueOnce(cmdError)

      try {
        await runLocizeSync(mockConfig, { throwOnError: true })
        expect.unreachable('should have thrown')
      } catch (error: any) {
        expect(error).toBeInstanceOf(LocizeCommandError)
        expect(error.stderr).toContain('machine translation not activated')
      }
    })

    it('throws (not exits) when the locize-cli binary is missing', async () => {
      const error: any = new Error('Not found')
      error.code = 'ENOENT'
      vi.mocked(execa).mockRejectedValue(error)
      await expect(runLocizeSync(mockConfig, { throwOnError: true })).rejects.toThrow(/locize-cli/)
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('still exits without throwOnError (standalone command behavior unchanged)', async () => {
      const cmdError: any = new Error('boom')
      cmdError.stderr = 'some other failure'
      vi.mocked(execa)
        .mockResolvedValueOnce({ stdout: 'v1.0.0', stderr: '' } as any)
        .mockRejectedValueOnce(cmdError)

      await runLocizeSync(mockConfig)
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  describe('credential resolution', () => {
    const getSyncArgs = () => {
      const syncCall = vi.mocked(execa).mock.calls.find(c => Array.isArray(c[1]) && (c[1] as string[]).includes('sync'))
      return syncCall![1] as string[]
    }

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('falls back to LOCIZE_PROJECTID / LOCIZE_API_KEY env vars and forwards them as flags', async () => {
      // Explicit flags matter: locize-cli itself prefers a ~/.locize config
      // file over env vars, so a stale ~/.locize would otherwise hijack the run.
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      vi.stubEnv('LOCIZE_PROJECTID', 'env-project-id')
      vi.stubEnv('LOCIZE_API_KEY', 'env-api-key')
      delete mockConfig.locize
      await runLocizeSync(mockConfig)
      const args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--project-id') + 1]).toBe('env-project-id')
      expect(args[args.findIndex(a => a === '--api-key') + 1]).toBe('env-api-key')
    })

    it('config takes precedence over env vars', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      vi.stubEnv('LOCIZE_PROJECTID', 'env-project-id')
      await runLocizeSync(mockConfig) // config has projectId: 'test-project-id'
      const args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--project-id') + 1]).toBe('test-project-id')
    })

    it('forwards apiEndpoint from config / LOCIZE_API_ENDPOINT env', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      mockConfig.locize = { ...mockConfig.locize, apiEndpoint: 'https://api-dev.locize.app' }
      await runLocizeSync(mockConfig)
      let args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--api-endpoint') + 1]).toBe('https://api-dev.locize.app')

      vi.mocked(execa).mockClear()
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      delete mockConfig.locize!.apiEndpoint
      vi.stubEnv('LOCIZE_API_ENDPOINT', 'https://api-staging.locize.app')
      await runLocizeSync(mockConfig)
      args = getSyncArgs()
      expect(args[args.findIndex(a => a === '--api-endpoint') + 1]).toBe('https://api-staging.locize.app')
    })

    it('does not forward --api-endpoint when unset', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: 'Success!', stderr: '' } as any)
      await runLocizeSync(mockConfig)
      expect(getSyncArgs()).not.toContain('--api-endpoint')
    })
  })

  describe('maskApiKey', () => {
    it('masks legacy UUID keys keeping the first and last 3 characters', () => {
      const key = '181f1234-abcd-ef01-2345-67890b9420f1'
      const masked = maskApiKey(key)
      expect(masked.startsWith('181')).toBe(true)
      expect(masked.endsWith('0f1')).toBe(true)
      expect(masked).toHaveLength(key.length)
      // everything between is masked except the dashes
      expect(masked.slice(3, -3)).toMatch(/^[*-]+$/)
    })

    it('masks lz_pat_ tokens keeping the prefix + 4 chars and the last 4', () => {
      const masked = maskApiKey('lz_pat_4xK9mNqR2vBpW7tHsL3cYdE8fUjAoZ1i')
      expect(masked.startsWith('lz_pat_4xK9')).toBe(true)
      expect(masked.endsWith('oZ1i')).toBe(true)
      expect(masked.slice(11, -4)).toMatch(/^\*+$/)
      expect(masked).toHaveLength('lz_pat_4xK9mNqR2vBpW7tHsL3cYdE8fUjAoZ1i'.length)
    })

    it('masks lz_api_ tokens the same way', () => {
      const masked = maskApiKey('lz_api_4xK9mNqR2vBpW7tHsL3cYdE8fUjAoZ1i')
      expect(masked.startsWith('lz_api_4xK9')).toBe(true)
      expect(masked.endsWith('oZ1i')).toBe(true)
      expect(masked.slice(11, -4)).toMatch(/^\*+$/)
    })

    it('returns very short non-prefixed values unchanged', () => {
      expect(maskApiKey('abc123')).toBe('abc123')
      expect(maskApiKey('')).toBe('')
    })
  })
})
