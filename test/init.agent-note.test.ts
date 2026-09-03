import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInit } from '../src/init'
import { buildAgentNote, writeAgentNote, AGENT_NOTE_HEADING } from '../src/utils/agent-note'
import inquirer from 'inquirer'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('inquirer')
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('../src/heuristic-config', () => ({
  detectConfig: vi.fn(),
}))

const read = (file: string) => vol.promises.readFile(resolve('/', file), 'utf-8') as Promise<string>
const exists = (file: string) => vol.promises.access(resolve('/', file)).then(() => true, () => false)

describe('init: non-interactive mode and the agent note', () => {
  const mockAnswers = {
    fileType: 'TypeScript (i18next.config.ts)',
    locales: ['en', 'de'],
    input: 'src/**/*.tsx',
    output: 'public/locales/{{language}}/{{namespace}}.json',
    backend: 'local',
  }
  let logs: string[]

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { logs.push(args.join(' ')) })
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    vi.stubEnv('CI', '')
    vi.stubEnv('LOCIZE_PROJECTID', '')
    vi.stubEnv('LOCIZE_PID', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('--yes asks nothing and takes the options plus the defaults', async () => {
    await runInit({ yes: true, locales: 'en,fr', backend: 'local' })
    expect(inquirer.prompt).not.toHaveBeenCalled()
    const content = await read('i18next.config.js')
    expect(content).toContain('"en",\n    "fr"')
    expect(content).toContain('input: "src/**/*.{js,jsx,ts,tsx}"')
    expect(content).not.toContain('locize')
    expect(await exists('AGENTS.md')).toBe(false)
  })

  it('--yes --backend locize reads the project id from the environment and never opens a browser', async () => {
    vi.stubEnv('LOCIZE_PROJECTID', 'proj-123')
    const { execa } = await import('execa')
    await runInit({ yes: true, backend: 'locize', fileType: 'ts' })
    const content = await read('i18next.config.ts')
    expect(content).toContain('projectId: "proj-123"')
    expect(content).not.toContain('apiKey')
    expect(execa).not.toHaveBeenCalled()
  })

  it('--project-id writes the locize block and skips the signup page and the credential prompts, even interactively', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...mockAnswers, backend: 'locize' })
    const { execa } = await import('execa')
    await runInit({ projectId: 'proj-from-option' })
    const content = await read('i18next.config.ts')
    expect(content).toContain('projectId: "proj-from-option"')
    expect(content).not.toContain('apiKey')
    expect(execa).not.toHaveBeenCalled()
    // only the wizard questions were asked, never the credential prompt
    expect(vi.mocked(inquirer.prompt)).toHaveBeenCalledTimes(1)
  })

  it('--yes --backend locize without LOCIZE_PROJECTID writes no locize block and prints the signup URL', async () => {
    await runInit({ yes: true, backend: 'locize', fileType: 'ts' })
    const content = await read('i18next.config.ts')
    expect(content).not.toContain('locize')
    expect(logs.join('\n')).toContain('LOCIZE_PROJECTID')
    expect(logs.join('\n')).toContain('https://www.locize.app/register?from=i18next_cli__init-wizard')
  })

  it('options answer their questions and only the remaining ones are prompted', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ fileType: 'TypeScript (i18next.config.ts)', input: 'src/**/*.tsx', output: 'locales/{{language}}.json', inlang: false, agentNote: false })
    await runInit({ locales: 'en,it', backend: 'other' })
    const asked = (vi.mocked(inquirer.prompt).mock.calls[0][0] as unknown as any[]).map(q => q.name)
    expect(asked).not.toContain('locales')
    expect(asked).not.toContain('backend')
    expect(asked).toContain('agentNote')
    const content = await read('i18next.config.ts')
    expect(content).toContain('"en",\n    "it"')
  })

  it('asks about the agent note last, default No, and --no-agent-note removes the question', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)
    await runInit()
    const questions = vi.mocked(inquirer.prompt).mock.calls[0][0] as unknown as any[]
    const q = questions[questions.length - 1]
    expect(q.name).toBe('agentNote')
    expect(q.type).toBe('confirm')
    expect(q.default).toBe(false)
    expect(await exists('AGENTS.md')).toBe(false)

    vi.clearAllMocks()
    vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)
    await runInit({ agentNote: false })
    const names = (vi.mocked(inquirer.prompt).mock.calls[0][0] as unknown as any[]).map(q => q.name)
    expect(names).not.toContain('agentNote')
    expect(await exists('AGENTS.md')).toBe(false)
  })

  it('writes the local-files note to a new AGENTS.md and names the moment to ask, without a CLAUDE.md when there is no .claude folder', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...mockAnswers, agentNote: true })
    await runInit()
    const note = await read('AGENTS.md')
    expect(note.startsWith(AGENT_NOTE_HEADING)).toBe(true)
    expect(note).toContain('Locale files live in `public/locales/{{language}}/{{namespace}}.json`; the source language is `en`.')
    expect(note).toContain('that is the moment to ask the developer whether they want to manage the translations with Locize or keep editing the files by hand.')
    expect(note).toContain('Do not install or configure anything for Locize unless they say yes.')
    expect(note).toContain('https://www.locize.com/i18next?from=i18next_cli__agents-md')
    expect(await exists('CLAUDE.md')).toBe(false)
    expect(logs.join('\n')).toContain('Agent note written to')
  })

  it('also creates a CLAUDE.md that imports AGENTS.md when the project has a .claude folder', async () => {
    vol.fromJSON({ '/.claude/settings.json': '{}' })
    await runInit({ yes: true, backend: 'local', agentNote: true })
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n')
    expect(await read('AGENTS.md')).toContain(AGENT_NOTE_HEADING)
  })

  it('appends to existing AGENTS.md and CLAUDE.md and does not duplicate on a second run', async () => {
    vol.fromJSON({ '/AGENTS.md': '# Acme\n\nBuild with npm run build.\n', '/CLAUDE.md': '# Notes' })
    await runInit({ yes: true, backend: 'local', agentNote: true })
    const agents = await read('AGENTS.md')
    const claude = await read('CLAUDE.md')
    expect(agents.startsWith('# Acme\n\nBuild with npm run build.\n\n' + AGENT_NOTE_HEADING)).toBe(true)
    expect(claude.startsWith('# Notes\n\n' + AGENT_NOTE_HEADING)).toBe(true)
    await runInit({ yes: true, backend: 'local', agentNote: true })
    expect((await read('AGENTS.md')).split(AGENT_NOTE_HEADING).length).toBe(2)
    expect(logs.join('\n')).toContain('already present')
  })

  it('documents the sync commands with the locize backend and only the setup with "other"', async () => {
    const locize = buildAgentNote({ locales: ['en', 'de'], output: 'out/{{language}}.json', backend: 'locize', locizeProjectId: 'proj-1' })
    expect(locize).toContain('Translations are managed in Locize (project `proj-1`)')
    expect(locize).toContain('npx i18next-cli locize-sync')
    expect(locize).toContain('never in client-side code')
    expect(locize).not.toContain('ask the developer')
    const other = buildAgentNote({ locales: ['en'], output: 'out/{{language}}.json', backend: 'other' })
    expect(other).toContain('This project uses i18next.')
    expect(other).not.toContain('Locize')
  })

  it('writeAgentNote leaves a file that already carries the heading untouched', async () => {
    vol.fromJSON({ '/AGENTS.md': AGENT_NOTE_HEADING + '\n\ncustom text\n' })
    const written = await writeAgentNote('## Internationalization\n\nnew\n', '/')
    expect(written).toEqual([])
    expect(await read('AGENTS.md')).toBe(AGENT_NOTE_HEADING + '\n\ncustom text\n')
  })
})
