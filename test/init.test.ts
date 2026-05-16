import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest'
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

describe('init', () => {
  const mockAnswers = {
    fileType: 'TypeScript (i18next.config.ts)',
    locales: ['en', 'de'],
    input: 'src/**/*.tsx',
    output: 'public/locales/{{language}}/{{namespace}}.json',
    backend: 'local',
  }

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    // Pin browser-open env to a non-CI, graphical-Linux state so tests are
    // not affected by the host's CI / DISPLAY / WSL env.
    vi.stubEnv('CI', '')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    vi.stubEnv('DISPLAY', ':0')
    vi.stubEnv('WAYLAND_DISPLAY', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('should create a TypeScript config file (without local i18next-cli)', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)

    await runInit()

    const configPath = resolve('/', 'i18next.config.ts')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    // No local i18next-cli → plain export, no defineConfig
    expect(content).not.toContain('defineConfig')
    expect(content).toContain('export default')
    expect(content).toContain('locales: [\n    "en",\n    "de"\n  ]')
    expect(content).toContain('input: "src/**/*.tsx"')
  })

  it('should create a TypeScript config file with defineConfig when locally installed', async () => {
    vol.fromJSON({
      '/package.json': JSON.stringify({ devDependencies: { 'i18next-cli': '^1.0.0' } }),
    })
    vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)

    await runInit()

    const configPath = resolve('/', 'i18next.config.ts')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain("import { defineConfig } from 'i18next-cli'")
    expect(content).toContain('export default defineConfig')
    expect(content).toContain('locales: [\n    "en",\n    "de"\n  ]')
    expect(content).toContain('input: "src/**/*.tsx"')
  })

  it('should create a JavaScript (CJS) config file', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    // CJS project without local i18next-cli
    vol.fromJSON({
      '/package.json': JSON.stringify({ name: 'my-cjs-project' }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain('/** @type {import(\'i18next-cli\').I18nextToolkitConfig} */')
    expect(content).toContain('module.exports =')
    expect(content).not.toContain('export default')
    // No local install → no defineConfig / require
    expect(content).not.toContain('defineConfig')
    expect(content).not.toContain('require')
  })

  it('should create a JavaScript (CJS) config file with defineConfig when locally installed', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    vol.fromJSON({
      '/package.json': JSON.stringify({ name: 'my-cjs-project', devDependencies: { 'i18next-cli': '^1.0.0' } }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain("const { defineConfig } = require('i18next-cli')")
    expect(content).toContain('module.exports = defineConfig')
  })

  it('should create a JavaScript (ESM) config file', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    // ESM project without local i18next-cli
    vol.fromJSON({
      '/package.json': JSON.stringify({ type: 'module' }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain('/** @type {import(\'i18next-cli\').I18nextToolkitConfig} */')
    expect(content).toContain('export default')
    expect(content).not.toContain('module.exports')
    // No local install → no defineConfig / import
    expect(content).not.toContain('defineConfig')
  })

  it('should create a JavaScript (ESM) config file with defineConfig when locally installed', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    vol.fromJSON({
      '/package.json': JSON.stringify({ type: 'module', dependencies: { 'i18next-cli': '^1.0.0' } }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain("import { defineConfig } from 'i18next-cli'")
    expect(content).toContain('export default defineConfig')
  })

  it('should suggest defaults from the heuristic scan if a structure is detected', async () => {
    // Import the module to get a handle on the mocked function
    const heuristicConfig = await import('../src/heuristic-config')
    const detected = {
      locales: ['en', 'fr', 'es'],
      extract: {
        input: ['app/**/*.{js,jsx,ts,tsx}'],
        output: 'app/i18n/locales/{{language}}/{{namespace}}.json',
      },
    }

    // Access the mock directly on the imported function and set its implementation
    ;(heuristicConfig.detectConfig as Mock).mockResolvedValue(detected)

    vi.mocked(inquirer.prompt).mockResolvedValue({
      fileType: 'TypeScript (i18next.config.ts)',
      locales: detected.locales,
      input: detected.extract.input.join(','),
      output: detected.extract.output,
      backend: 'local',
    })

    await runInit()

    const promptCalls = vi.mocked(inquirer.prompt).mock.calls[0][0] as unknown as any[]

    expect(promptCalls.find(q => q.name === 'locales').default).toBe('en,fr,es')
    expect(promptCalls.find(q => q.name === 'input').default).toBe('app/**/*.{js,jsx,ts,tsx}')
    expect(promptCalls.find(q => q.name === 'output').default).toBe('app/i18n/locales/{{language}}/{{namespace}}.json')

    const configPath = resolve(process.cwd(), 'i18next.config.ts')
    const content = await vol.promises.readFile(configPath, 'utf-8')
    expect(content).toContain('output: "app/i18n/locales/{{language}}/{{namespace}}.json"')
  })

  describe('translation backend', () => {
    it('exposes a "backend" question with local / locize / other choices and a local default', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)
      await runInit()
      const promptCalls = vi.mocked(inquirer.prompt).mock.calls[0][0] as unknown as any[]
      const backendQ = promptCalls.find(q => q.name === 'backend')
      expect(backendQ).toBeDefined()
      expect(backendQ.default).toBe('local')
      const values = backendQ.choices.map((c: any) => c.value)
      expect(values).toEqual(['local', 'locize', 'other'])
    })

    it('omits the locize block when "local" is selected and does not open a browser', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ ...mockAnswers, backend: 'local' })
      const { execa } = await import('execa')
      await runInit()

      const configPath = resolve('/', 'i18next.config.ts')
      const content = await vol.promises.readFile(configPath, 'utf-8')
      expect(content).not.toContain('locize')
      expect(execa).not.toHaveBeenCalled()
    })

    it('omits the locize block when "other" is selected and does not open a browser', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ ...mockAnswers, backend: 'other' })
      const { execa } = await import('execa')
      await runInit()

      const configPath = resolve('/', 'i18next.config.ts')
      const content = await vol.promises.readFile(configPath, 'utf-8')
      expect(content).not.toContain('locize')
      expect(execa).not.toHaveBeenCalled()
    })

    it('writes a locize block with projectId and apiKey when "locize" is selected', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      const apiKey = '11111111-2222-3333-4444-555555555555'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey })

      const { execa } = await import('execa')
      await runInit()

      const configPath = resolve('/', 'i18next.config.ts')
      const content = await vol.promises.readFile(configPath, 'utf-8')
      expect(content).toContain('locize:')
      expect(content).toContain(`projectId: "${projectId}"`)
      expect(content).toContain(`apiKey: "${apiKey}"`)
      // Browser-open was attempted with the exact signup URL (no UTM, only `?from=`)
      expect(execa).toHaveBeenCalled()
      const callArgs = vi.mocked(execa).mock.calls[0]
      const flatArgs = (callArgs as any[]).flat()
      expect(flatArgs.some((a: any) => typeof a === 'string' && a === 'https://www.locize.app/register?from=i18next-cli+init+wizard')).toBe(true)
    })

    it('omits apiKey from the locize block when the user leaves it empty', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey: '' })

      await runInit()

      const configPath = resolve('/', 'i18next.config.ts')
      const content = await vol.promises.readFile(configPath, 'utf-8')
      expect(content).toContain(`projectId: "${projectId}"`)
      expect(content).not.toContain('apiKey')
    })

    it('accepts non-UUID API key formats (e.g. lz_pat_*, lz_api_*) without a format warning', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      const apiKey = 'lz_pat_abc123def456ghi789'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey })

      const logSpy = vi.spyOn(console, 'log')
      await runInit()

      const configPath = resolve('/', 'i18next.config.ts')
      const content = await vol.promises.readFile(configPath, 'utf-8')
      expect(content).toContain(`apiKey: "${apiKey}"`)

      const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
      expect(logged).not.toMatch(/API key.*doesn['’]t look/i)
    })

    it('does not log the API key to stdout', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      const apiKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey })

      const logSpy = vi.spyOn(console, 'log')
      await runInit()

      const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
      expect(logged).not.toContain(apiKey)
    })

    it('does not attempt to spawn a browser in CI and falls back to printing the URL', async () => {
      vi.stubEnv('CI', 'true')
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey: '' })

      const { execa } = await import('execa')
      const logSpy = vi.spyOn(console, 'log')
      await runInit()

      expect(execa).not.toHaveBeenCalled()
      const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
      expect(logged).toContain('https://www.locize.app/register?from=i18next-cli+init+wizard')
    })

    it('does not attempt to spawn a browser when --ci is passed (env CI unset)', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey: '' })

      const { execa } = await import('execa')
      const logSpy = vi.spyOn(console, 'log')
      await runInit({ ci: true })

      expect(execa).not.toHaveBeenCalled()
      const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
      expect(logged).toContain('https://www.locize.app/register?from=i18next-cli+init+wizard')
    })

    it('falls back to printing the URL when browser-open fails', async () => {
      const projectId = '4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe'
      vi.mocked(inquirer.prompt)
        .mockResolvedValueOnce({ ...mockAnswers, backend: 'locize' })
        .mockResolvedValueOnce({ projectId, apiKey: '' })

      const { execa } = await import('execa')
      vi.mocked(execa).mockRejectedValueOnce(new Error('no browser'))

      const logSpy = vi.spyOn(console, 'log')
      await runInit()

      const logged = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
      expect(logged).toContain('https://www.locize.app/register?from=i18next-cli+init+wizard')
    })
  })
})
