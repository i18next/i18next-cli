import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runStatus } from '../src/index'
import type { I18nextToolkitConfig, ExtractedKey } from '../src/index'
import { resolve, dirname } from 'path'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const TEMP_DIR = resolve(process.cwd(), 'test/temp_status_files')

vi.mock('../src/extractor/core/key-finder', () => ({
  findKeys: vi.fn(),
}))

describe('status: file formats and namespace merging', () => {
  let consoleLogSpy: any

  // Create a temporary directory for our real files before tests run
  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(TEMP_DIR, { recursive: true })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  // Clean up the temporary directory after tests run
  afterEach(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('should correctly read JS ESM files for status calculation', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key1', { key: 'key1', ns: 'translation' }],
      ['translation:key2', { key: 'key2', ns: 'translation' }],
    ])
    vi.mocked(findKeys).mockResolvedValue({ allKeys: mockKeys, objectKeys: new Set() })

    const dePath = resolve(TEMP_DIR, 'locales/de/translation.js')
    await mkdir(dirname(dePath), { recursive: true })
    const deContent = 'export default { "key1": "Wert 1" };'
    await writeFile(dePath, deContent)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}/{{namespace}}.js`,
      },
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■□□□□□□□□□□] 50% (1/2 keys)'))
  })

  it('should correctly read merged namespace files for status calculation', async () => {
    const { findKeys } = await import('../src/extractor/core/key-finder')
    const mockKeys = new Map<string, ExtractedKey>([
      ['translation:key1', { key: 'key1', ns: 'translation' }],
      ['translation:key2', { key: 'key2', ns: 'translation' }],
      ['common:keyA', { key: 'keyA', ns: 'common' }],
    ])
    vi.mocked(findKeys).mockResolvedValue({ allKeys: mockKeys, objectKeys: new Set() })

    const dePath = resolve(TEMP_DIR, 'locales/de.json')
    await mkdir(dirname(dePath), { recursive: true })
    const deTranslations = {
      translation: { key1: 'Wert 1' },
      common: { keyA: 'Wert A' },
    }
    await writeFile(dePath, JSON.stringify(deTranslations))

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: ['src/'],
        output: `${TEMP_DIR}/locales/{{language}}.json`,
        mergeNamespaces: true,
      },
    }

    await runStatus(config)

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- de: [■■■■■■■■■■■■■□□□□□□□] 67% (2/3 keys)'))
  })
})
