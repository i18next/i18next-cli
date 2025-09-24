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

describe('init', () => {
  const mockAnswers = {
    fileType: 'TypeScript (i18next.config.ts)',
    locales: ['en', 'de'],
    input: 'src/**/*.tsx',
    output: 'public/locales/{{language}}/{{namespace}}.json',
  }

  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // FIX: Mock process.cwd() to point to the root of the virtual file system
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should create a TypeScript config file', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue(mockAnswers)

    await runInit()

    const configPath = resolve('/', 'i18next.config.ts')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain('import { defineConfig } from')
    expect(content).toContain('export default defineConfig')
    expect(content).toContain('locales: [\n    "en",\n    "de"\n  ]')
    expect(content).toContain('input: "src/**/*.tsx"')
  })

  it('should create a JavaScript (CJS) config file', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    // FIX: To test CJS, create a package.json *without* type: "module"
    vol.fromJSON({
      '/package.json': JSON.stringify({ name: 'my-cjs-project' }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain('/** @type {import(\'i18next-cli\').I18nextToolkitConfig} */')
    expect(content).toContain('module.exports =')
    expect(content).not.toContain('export default')
  })

  it('should create a JavaScript (ESM) config file', async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      ...mockAnswers,
      fileType: 'JavaScript (i18next.config.js)',
    })

    // To test ESM, create a package.json with type: "module"
    vol.fromJSON({
      '/package.json': JSON.stringify({ type: 'module' }),
    })

    await runInit()

    const configPath = resolve('/', 'i18next.config.js')
    const content = await vol.promises.readFile(configPath, 'utf-8')

    expect(content).toContain('/** @type {import(\'i18next-cli\').I18nextToolkitConfig} */')
    expect(content).toContain('export default')
    expect(content).not.toContain('module.exports')
  })
})
