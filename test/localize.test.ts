import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runLocalize } from '../src/localize/localize'
import { LocizeCommandError, runLocizeSync, runLocizeDownload } from '../src/locize'
import { ensureConfig, loadConfig } from '../src/config'
import { runExtractor } from '../src/extractor'
import { runInstrumenter } from '../src/instrumenter/index'
import { detectStack, hasStackPlugin } from '../src/localize/detect'
import { openBrowser, promptLocizeCredentials } from '../src/utils/locize-onboarding'
import { execa } from 'execa'
import inquirer from 'inquirer'
import { glob } from 'glob'
import type { DetectedStack } from '../src/localize/detect'
import type { I18nextToolkitConfig } from '../src/types'

vi.mock('inquirer')
vi.mock('execa')
vi.mock('glob', () => ({ glob: vi.fn().mockResolvedValue([]) }))
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('../src/config', () => ({
  ensureConfig: vi.fn(),
  loadConfig: vi.fn(),
}))
vi.mock('../src/heuristic-config', () => ({
  detectConfig: vi.fn().mockResolvedValue(null),
}))
vi.mock('../src/extractor', () => ({
  runExtractor: vi.fn(),
}))
vi.mock('../src/instrumenter/index', () => ({
  runInstrumenter: vi.fn(),
  findExistingI18nInitFile: vi.fn().mockResolvedValue(null),
}))
vi.mock('../src/locize', () => {
  class LocizeCommandError extends Error {
    stdout: string
    stderr: string
    constructor (message: string, output: { stdout?: string, stderr?: string } = {}) {
      super(message)
      this.name = 'LocizeCommandError'
      this.stdout = output.stdout || ''
      this.stderr = output.stderr || ''
    }
  }
  return {
    LocizeCommandError,
    maskApiKey: (key: string) => key,
    runLocizeSync: vi.fn(),
    runLocizeDownload: vi.fn(),
  }
})
vi.mock('../src/utils/locize-onboarding', () => ({
  openBrowser: vi.fn().mockResolvedValue(true),
  promptLocizeCredentials: vi.fn(),
}))
vi.mock('../src/localize/detect', async () => {
  const actual = await vi.importActual<typeof import('../src/localize/detect')>('../src/localize/detect')
  return {
    ...actual,
    detectStack: vi.fn(),
    hasStackPlugin: vi.fn().mockReturnValue(false),
  }
})

const reactStack: DetectedStack = {
  framework: 'react',
  hasI18next: false,
  hasTypeScript: true,
  initFile: null,
  hasAppRouter: false,
  hasParaglide: false,
}

const makeConfig = (locize?: I18nextToolkitConfig['locize']): I18nextToolkitConfig => ({
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.tsx'],
    output: 'public/locales/{{language}}/{{namespace}}.json',
  },
  ...(locize ? { locize } : {}),
})

describe('runLocalize', () => {
  let exitSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    vol.reset()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    vi.mocked(glob).mockResolvedValue([])
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack })
    vi.mocked(hasStackPlugin).mockReturnValue(false)
    vi.mocked(ensureConfig).mockResolvedValue(makeConfig({ projectId: 'pid', apiKey: 'key' }))
    vi.mocked(loadConfig).mockResolvedValue(makeConfig({ projectId: 'pid', apiKey: 'key' }))
    vi.mocked(runInstrumenter).mockResolvedValue({
      files: [], totalCandidates: 3, totalTransformed: 3, totalSkipped: 0, totalLanguageChanges: 0, extractedKeys: [],
    } as any)
    vi.mocked(runExtractor).mockResolvedValue({ anyFileUpdated: true, hasErrors: false, results: [] } as any)
    vi.mocked(runLocizeSync).mockResolvedValue(undefined as any)
    vi.mocked(runLocizeDownload).mockResolvedValue(undefined as any)
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: '' } as any) // clean git tree
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true })

    delete process.env.LOCIZE_PROJECTID
    delete process.env.LOCIZE_API_KEY
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs the full happy path in order: instrument → extract → sync(auto-translate) → download', async () => {
    await runLocalize({ ci: true, yes: true })

    expect(runInstrumenter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isInteractive: false, isDryRun: false })
    )
    expect(runExtractor).toHaveBeenCalled()
    expect(runLocizeSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoTranslate: true, throwOnError: true })
    )
    expect(runLocizeDownload).toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()

    const instrumentOrder = vi.mocked(runInstrumenter).mock.invocationCallOrder[0]
    const extractOrder = vi.mocked(runExtractor).mock.invocationCallOrder[0]
    const syncOrder = vi.mocked(runLocizeSync).mock.invocationCallOrder[0]
    const downloadOrder = vi.mocked(runLocizeDownload).mock.invocationCallOrder[0]
    expect(instrumentOrder).toBeLessThan(extractOrder)
    expect(extractOrder).toBeLessThan(syncOrder)
    expect(syncOrder).toBeLessThan(downloadOrder)
  })

  it('uses interactive instrumentation by default and non-interactive with --yes', async () => {
    vi.mocked(ensureConfig).mockResolvedValue(makeConfig({ projectId: 'pid', apiKey: 'key' }))
    await runLocalize({})
    expect(runInstrumenter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isInteractive: true }))

    vi.mocked(runInstrumenter).mockClear()
    await runLocalize({ yes: true })
    expect(runInstrumenter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isInteractive: false }))
  })

  it('skips instrument in --ci without --yes', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig({ projectId: 'pid', apiKey: 'key' }))
    await runLocalize({ ci: true })
    expect(runInstrumenter).not.toHaveBeenCalled()
    expect(runExtractor).toHaveBeenCalled() // flow continues
  })

  it('fails in --ci without credentials, pointing at the env vars', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig())
    await runLocalize({ ci: true })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(runLocizeSync).not.toHaveBeenCalled()
  })

  it('reads credentials from LOCIZE_PROJECTID / LOCIZE_API_KEY env vars in --ci', async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig())
    process.env.LOCIZE_PROJECTID = 'env-pid'
    process.env.LOCIZE_API_KEY = 'env-key'
    await runLocalize({ ci: true })
    expect(runLocizeSync).toHaveBeenCalledWith(
      expect.objectContaining({ locize: expect.objectContaining({ projectId: 'env-pid', apiKey: 'env-key' }) }),
      expect.anything()
    )
  })

  it('degrades gracefully on Vue without a stack plugin: instrument skipped, flow continues', async () => {
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack, framework: 'vue' })
    await runLocalize({ yes: true })
    expect(runInstrumenter).not.toHaveBeenCalled()
    expect(runExtractor).toHaveBeenCalled()
    expect(runLocizeSync).toHaveBeenCalled()
  })

  it('runs instrument on Vue when a matching stack plugin is configured', async () => {
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack, framework: 'vue' })
    vi.mocked(hasStackPlugin).mockReturnValue(true)
    await runLocalize({ yes: true })
    expect(runInstrumenter).toHaveBeenCalled()
  })

  it('Paraglide without i18next: exits gracefully without instrument/extract/sync', async () => {
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack, framework: 'svelte', hasParaglide: true })
    await runLocalize({ yes: true })
    expect(runInstrumenter).not.toHaveBeenCalled()
    expect(runExtractor).not.toHaveBeenCalled()
    expect(runLocizeSync).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('Paraglide with i18next also present: skips instrument but continues', async () => {
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack, hasParaglide: true, hasI18next: true })
    await runLocalize({ yes: true })
    expect(runInstrumenter).not.toHaveBeenCalled()
    expect(runExtractor).toHaveBeenCalled()
    expect(runLocizeSync).toHaveBeenCalled()
  })

  it('prompts before re-instrumenting a project that already uses i18next', async () => {
    vi.mocked(detectStack).mockResolvedValue({ ...reactStack, hasI18next: true, initFile: 'src/i18n.ts' })
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false })
    await runLocalize({})
    expect(inquirer.prompt).toHaveBeenCalled()
    expect(runInstrumenter).not.toHaveBeenCalled()
    expect(runExtractor).toHaveBeenCalled()
  })

  it('aborts when the git tree is dirty and the user declines', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: ' M src/App.tsx', stderr: '' } as any)
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false })
    await runLocalize({})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(runInstrumenter).not.toHaveBeenCalled()
  })

  it('continues with a warning on a dirty tree under --yes', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: ' M src/App.tsx', stderr: '' } as any)
    await runLocalize({ yes: true })
    expect(inquirer.prompt).not.toHaveBeenCalled()
    expect(runInstrumenter).toHaveBeenCalled()
  })

  it('stops before Locize when extraction reports errors', async () => {
    vi.mocked(runExtractor).mockResolvedValue({ anyFileUpdated: false, hasErrors: true, results: [] } as any)
    await runLocalize({ yes: true })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(runLocizeSync).not.toHaveBeenCalled()
  })

  it('stops after extraction with --skip-locize', async () => {
    await runLocalize({ yes: true, skipLocize: true })
    expect(runExtractor).toHaveBeenCalled()
    expect(runLocizeSync).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('retries the sync without auto-translate and exits 1 when AI is not enabled', async () => {
    vi.mocked(runLocizeSync)
      .mockRejectedValueOnce(new LocizeCommandError('failed', { stderr: 'auto-translation is not enabled for this project' }))
      .mockResolvedValueOnce(undefined as any)
    const logSpy = vi.mocked(console.log)

    await runLocalize({ ci: true, yes: true })

    expect(runLocizeSync).toHaveBeenCalledTimes(2)
    const firstCall = vi.mocked(runLocizeSync).mock.calls[0][1]
    const secondCall = vi.mocked(runLocizeSync).mock.calls[1][1]
    expect(firstCall).toEqual(expect.objectContaining({ autoTranslate: true }))
    expect(secondCall.autoTranslate).toBeUndefined()
    expect(exitSpy).toHaveBeenCalledWith(1)
    const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
    expect(logged).toMatch(/EDITOR, TM\/MT\/AI, ORDERING/)
  })

  it('does not misclassify unrelated sync failures as AI-not-enabled', async () => {
    vi.mocked(runLocizeSync).mockRejectedValue(new LocizeCommandError('boom', { stderr: 'connection refused' }))
    await runLocalize({ ci: true, yes: true })
    expect(runLocizeSync).toHaveBeenCalledTimes(1) // no retry
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('ignores the echoed command line in error.message when classifying sync failures', async () => {
    // execa error messages echo the invoked command (incl. --auto-translate);
    // only the captured stderr/stdout may drive the AI-not-enabled retry.
    vi.mocked(runLocizeSync).mockRejectedValue(
      new LocizeCommandError('Command failed: locize sync --auto-translate true', { stderr: '' })
    )
    await runLocalize({ ci: true, yes: true })
    expect(runLocizeSync).toHaveBeenCalledTimes(1) // no retry
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('does not request auto-translate with --skip-translate', async () => {
    await runLocalize({ ci: true, yes: true, skipTranslate: true })
    const syncOptions = vi.mocked(runLocizeSync).mock.calls[0][1]
    expect(syncOptions.autoTranslate).toBeUndefined()
  })

  it('treats a download failure as non-fatal', async () => {
    vi.mocked(runLocizeDownload).mockRejectedValue(new LocizeCommandError('cdn hiccup'))
    await runLocalize({ ci: true, yes: true })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('propagates --dry-run to instrument, extract and sync, and skips the download', async () => {
    await runLocalize({ dryRun: true, yes: true })
    expect(runInstrumenter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isDryRun: true }))
    expect(runExtractor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isDryRun: true }))
    expect(runLocizeSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }))
    expect(runLocizeDownload).not.toHaveBeenCalled()
  })

  it('ends the dry run before sync when no credentials are configured', async () => {
    vi.mocked(ensureConfig).mockResolvedValue(makeConfig())
    await runLocalize({ dryRun: true, yes: true })
    expect(runLocizeSync).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('prompts for credentials interactively when missing and uses them for the sync', async () => {
    vi.mocked(ensureConfig).mockResolvedValue(makeConfig())
    vi.mocked(promptLocizeCredentials).mockResolvedValue({ projectId: 'new-pid', apiKey: 'new-key' })

    await runLocalize({ yes: true })

    expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('from=i18next_cli__localize'), expect.anything())
    expect(runLocizeSync).toHaveBeenCalledWith(
      expect.objectContaining({ locize: expect.objectContaining({ projectId: 'new-pid', apiKey: 'new-key' }) }),
      expect.anything()
    )
  })

  it('exits with guidance when the user provides no API key', async () => {
    vi.mocked(ensureConfig).mockResolvedValue(makeConfig())
    vi.mocked(promptLocizeCredentials).mockResolvedValue({ projectId: 'new-pid' })
    await runLocalize({ yes: true })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(runLocizeSync).not.toHaveBeenCalled()
  })

  it('polls between download rounds while target languages stay untranslated (interactive)', async () => {
    // Primary language has keys on disk, the target language file never appears
    // → every poll round is incomplete and all rounds run.
    vol.fromJSON({ '/public/locales/en/translation.json': '{"a":"A","b":"B"}' })
    vi.mocked(glob).mockResolvedValue(['public/locales/en/translation.json'] as any)

    vi.useFakeTimers()
    try {
      const promise = runLocalize({ yes: true })
      await vi.advanceTimersByTimeAsync(60000) // covers both inter-round delays
      await promise
      expect(runLocizeDownload).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling as soon as all target languages are translated', async () => {
    vol.fromJSON({
      '/public/locales/en/translation.json': '{"a":"A","b":"B"}',
      '/public/locales/de/translation.json': '{"a":"A (de)","b":"B (de)"}',
    })
    vi.mocked(glob).mockResolvedValue(['public/locales/en/translation.json'] as any)

    await runLocalize({ yes: true })
    expect(runLocizeDownload).toHaveBeenCalledTimes(1)
  })

  it('downloads once without polling in --ci', async () => {
    await runLocalize({ ci: true, yes: true })
    expect(runLocizeDownload).toHaveBeenCalledTimes(1)
  })

  it('prints the agent prompt and exits before any config load', async () => {
    const logSpy = vi.mocked(console.log)
    await runLocalize({ printAgentPrompt: true })
    expect(ensureConfig).not.toHaveBeenCalled()
    expect(loadConfig).not.toHaveBeenCalled()
    expect(detectStack).not.toHaveBeenCalled()
    const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
    expect(logged).toContain('i18next-cli locize-sync --auto-translate true')
  })
})
