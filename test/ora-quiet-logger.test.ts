import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/extractor'
import { runTypesGenerator } from '../src/types-generator'
import { runLinterCli } from '../src/linter'
import { runSyncer } from '../src/syncer'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'i18next-test-'))
  // Create dummy.js and locales/en/test.json for syncer
  mkdirSync(join(tempDir, 'locales/en'), { recursive: true })
  writeFileSync(join(tempDir, 'dummy.js'), 'export default {}')
  writeFileSync(join(tempDir, 'locales/en/test.json'), '{"key":"value"}')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function withTempConfig (config: any) {
  // Patch config paths to use tempDir
  const patched = JSON.parse(JSON.stringify(config))
  if (patched.extract) {
    patched.extract.input = [join(tempDir, 'dummy.js')]
    patched.extract.output = join(tempDir, 'locales/{{language}}/{{namespace}}.json')
  }
  if (patched.types) {
    patched.types.input = [join(tempDir, 'dummy.js')]
    patched.types.output = join(tempDir, 'types.d.ts')
  }
  return patched
}

const dummyConfig = {
  locales: ['en'],
  extract: {
    input: ['dummy.js'],
    output: 'locales/{{language}}/{{namespace}}.json',
    primaryLanguage: 'en',
    functions: ['t'],
    transComponents: ['Trans']
  },
  types: {
    input: ['dummy.js'],
    output: 'types.d.ts'
  }
}

describe('ora spinner quiet and logger options', () => {
  it('should silence ora spinner with quiet:true (extractor)', async () => {
    const spy = vi.spyOn(process.stderr, 'write')
    await runExtractor(withTempConfig(dummyConfig), { quiet: true })
    const calledWithSpinner = spy.mock.calls.some(args =>
      args.some(a => String(a).includes('Running i18next key extractor'))
    )
    expect(calledWithSpinner).toBe(false)
    spy.mockRestore()
  })

  it('should route ora spinner output through custom logger (extractor)', async () => {
    const logs: string[] = []
    const logger = {
      info: (msg: string) => { logs.push(msg); return 0 },
      warn: () => {},
      error: () => {}
    }
    await runExtractor(withTempConfig(dummyConfig), {}, logger)
    expect(logs.some(l => l.includes('Extraction complete!'))).toBeTruthy()
  })

  it('should silence ora spinner with quiet:true (types-generator)', async () => {
    const spy = vi.spyOn(process.stderr, 'write')
    await runTypesGenerator(withTempConfig(dummyConfig), { quiet: true })
    const calledWithSpinner = spy.mock.calls.some(args =>
      args.some(a => String(a).includes('Generating TypeScript types'))
    )
    expect(calledWithSpinner).toBe(false)
    spy.mockRestore()
  })

  it('should route ora spinner output through custom logger (types-generator)', async () => {
    const logs: string[] = []
    const logger = {
      info: (msg: string) => { logs.push(msg); return 0 },
      warn: () => {},
      error: () => {}
    }
    await runTypesGenerator(withTempConfig(dummyConfig), {}, logger)
    expect(logs.some(l => l.includes('TypeScript definitions generated successfully.'))).toBeTruthy()
  })

  it('should silence ora spinner with quiet:true (linter)', async () => {
    const spy = vi.spyOn(process.stderr, 'write')
    await runLinterCli(withTempConfig(dummyConfig), { quiet: true })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('should route ora spinner output through custom logger (linter)', async () => {
    const logs: string[] = []
    const logger = {
      info: (msg: string) => { logs.push(msg); return 0 },
      warn: () => {},
      error: () => {}
    }
    await runLinterCli(withTempConfig(dummyConfig), {}, logger)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('should silence ora spinner with quiet:true (syncer)', async () => {
    const spy = vi.spyOn(process.stderr, 'write')
    await runSyncer(withTempConfig(dummyConfig), { quiet: true })
    const calledWithSpinner = spy.mock.calls.some(args =>
      args.some(a => String(a).includes('Running i18next locale synchronizer'))
    )
    expect(calledWithSpinner).toBe(false)
    spy.mockRestore()
  })

  it('should route ora spinner output through custom logger (syncer)', async () => {
    const logs: string[] = []
    const logger = {
      info: (msg: string) => { logs.push(msg); return 0 },
      warn: () => {},
      error: () => {}
    }
    await runSyncer(withTempConfig(dummyConfig), {}, logger)
    // Accept either 'Synchronization complete!' or 'Synchronization failed.'
    expect(logs.some(l => l.includes('Synchronization complete!') || l.includes('Synchronization failed.'))).toBeTruthy()
  })
})
