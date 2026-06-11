import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInit } from '../src/init'
import inquirer from 'inquirer'
import { resolve } from 'path'

// Mocks
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

const SHERLOCK = 'inlang.vs-code-extension'

const baseAnswers = {
  fileType: 'TypeScript (i18next.config.ts)',
  locales: ['en', 'de'],
  input: 'src/**/*.tsx',
  output: 'public/locales/{{language}}/{{namespace}}.json',
  backend: 'local',
}

async function readJson (path: string): Promise<any> {
  return JSON.parse(await vol.promises.readFile(resolve('/', path), 'utf-8') as string)
}

describe('init --inlang (inlang project scaffold)', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    vi.stubEnv('CI', '')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    vi.stubEnv('DISPLAY', ':0')
    vi.stubEnv('WAYLAND_DISPLAY', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('scaffolds project.inlang with a namespaced pathPattern derived from existing files', async () => {
    vol.fromJSON({
      '/public/locales/en/common.json': '{}',
      '/public/locales/en/app.json': '{}',
      '/public/locales/de/common.json': '{}',
    })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const settings = await readJson('project.inlang/settings.json')
    expect(settings).toStrictEqual({
      $schema: 'https://inlang.com/schema/project-settings',
      baseLocale: 'en',
      locales: ['en', 'de'],
      modules: ['https://cdn.jsdelivr.net/npm/@inlang/plugin-i18next@6.2.0/dist/index.js'],
      'plugin.inlang.i18next': {
        pathPattern: {
          app: './public/locales/{locale}/app.json',
          common: './public/locales/{locale}/common.json',
        },
      },
    })
  })

  it('does not scaffold when the wizard question is declined (default)', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: false })

    await runInit()

    expect(vol.existsSync(resolve('/', 'project.inlang/settings.json'))).toBe(false)
    expect(vol.existsSync(resolve('/', '.vscode/extensions.json'))).toBe(false)
  })

  it('asks the wizard question by default and skips it when --inlang is passed', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers })

    await runInit()
    const withoutFlag: any = vi.mocked(inquirer.prompt).mock.calls[0][0]
    const question = (withoutFlag as any[]).find(q => q.name === 'inlang')
    expect(question).toBeDefined()
    expect(question.default).toBe(false)
    expect(question.when()).toBe(true)

    vi.mocked(inquirer.prompt).mockClear()
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers })

    await runInit({ inlang: true })
    const withFlag: any = vi.mocked(inquirer.prompt).mock.calls[0][0]
    const skippedQuestion = (withFlag as any[]).find(q => q.name === 'inlang')
    expect(skippedQuestion.when()).toBe(false)
    // The flag scaffolds even though the wizard answer is absent.
    expect(vol.existsSync(resolve('/', 'project.inlang/settings.json'))).toBe(true)
  })

  it('derives a string pathPattern for single-file outputs (no {{namespace}})', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...baseAnswers,
      output: 'locales/{{language}}.json',
      inlang: true,
    })

    await runInit()

    const settings = await readJson('project.inlang/settings.json')
    expect(settings['plugin.inlang.i18next'].pathPattern).toBe('./locales/{locale}.json')
  })

  it('supports the {{lng}} placeholder alias', async () => {
    vol.fromJSON({ '/locales/en/main.json': '{}' })
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...baseAnswers,
      output: 'locales/{{lng}}/{{namespace}}.json',
      inlang: true,
    })

    await runInit()

    const settings = await readJson('project.inlang/settings.json')
    expect(settings['plugin.inlang.i18next'].pathPattern).toStrictEqual({
      main: './locales/{locale}/main.json',
    })
  })

  it('falls back to the "translation" namespace when no resource files exist yet', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const settings = await readJson('project.inlang/settings.json')
    expect(settings['plugin.inlang.i18next'].pathPattern).toStrictEqual({
      translation: './public/locales/{locale}/translation.json',
    })
  })

  it('never overwrites an existing project.inlang/settings.json', async () => {
    const existing = '{\n  "custom": true\n}\n'
    vol.fromJSON({ '/project.inlang/settings.json': existing })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const content = await vol.promises.readFile(resolve('/', 'project.inlang/settings.json'), 'utf-8')
    expect(content).toBe(existing)
    // The extension recommendation is still applied (idempotent re-runs stay clean).
    const extensions = await readJson('.vscode/extensions.json')
    expect(extensions.recommendations).toContain(SHERLOCK)
  })

  it('creates .vscode/extensions.json with the Sherlock recommendation', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const extensions = await readJson('.vscode/extensions.json')
    expect(extensions).toStrictEqual({ recommendations: [SHERLOCK] })
  })

  it('merges into an existing extensions.json, preserving comments and entries', async () => {
    vol.fromJSON({
      '/.vscode/extensions.json': '{\n  // team picks\n  "recommendations": [\n    "dbaeumer.vscode-eslint"\n  ]\n}\n',
    })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const content = await vol.promises.readFile(resolve('/', '.vscode/extensions.json'), 'utf-8') as string
    expect(content).toContain('// team picks')
    expect(content).toContain('dbaeumer.vscode-eslint')
    expect(content).toContain(SHERLOCK)
  })

  it('adds a recommendations array to an extensions.json that lacks one', async () => {
    vol.fromJSON({
      '/.vscode/extensions.json': '{\n  "unwantedRecommendations": []\n}\n',
    })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const content = await vol.promises.readFile(resolve('/', '.vscode/extensions.json'), 'utf-8') as string
    expect(content).toContain('unwantedRecommendations')
    expect(content).toContain(SHERLOCK)
  })

  it('does not duplicate an already-present Sherlock recommendation', async () => {
    const existing = `{\n  "recommendations": [\n    "${SHERLOCK}"\n  ]\n}\n`
    vol.fromJSON({ '/.vscode/extensions.json': existing })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const content = await vol.promises.readFile(resolve('/', '.vscode/extensions.json'), 'utf-8')
    expect(content).toBe(existing)
  })

  it('leaves an unparseable extensions.json untouched and still completes', async () => {
    const broken = '{ this is not json'
    vol.fromJSON({ '/.vscode/extensions.json': broken })
    vi.mocked(inquirer.prompt).mockResolvedValue({ ...baseAnswers, inlang: true })

    await runInit()

    const content = await vol.promises.readFile(resolve('/', '.vscode/extensions.json'), 'utf-8')
    expect(content).toBe(broken)
    expect(vol.existsSync(resolve('/', 'project.inlang/settings.json'))).toBe(true)
  })

  it('skips the scaffold with a notice for non-JSON outputs', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...baseAnswers,
      output: 'locales/{{language}}/{{namespace}}.yaml',
      inlang: true,
    })

    await runInit()

    expect(vol.existsSync(resolve('/', 'project.inlang/settings.json'))).toBe(false)
  })
})
