import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { loadTranslationFile, ParseTranslationFileError } from '../src/utils/file-utils'

describe('loadTranslationFile parse-error handling', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-loadfile-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns null when the file does not exist', async () => {
    expect(await loadTranslationFile(join(tempDir, 'missing.json'))).toBeNull()
  })

  it('throws ParseTranslationFileError on unparseable JSON (e.g. merge conflict marker)', async () => {
    const file = join(tempDir, 'en.json')
    await fs.writeFile(file, '{\n  "myKey": "value"\n  >>>>>>\n}', 'utf-8')
    await expect(loadTranslationFile(file)).rejects.toThrow(ParseTranslationFileError)
    await expect(loadTranslationFile(file)).rejects.toThrow(/Could not parse translation file/)
  })

  it('throws ParseTranslationFileError on unparseable YAML', async () => {
    const file = join(tempDir, 'en.yaml')
    await fs.writeFile(file, 'foo: "bar\n  baz: [unterminated', 'utf-8')
    await expect(loadTranslationFile(file)).rejects.toThrow(ParseTranslationFileError)
  })

  it('stays lenient for .ts resource files that fail to load (does not regress #59)', async () => {
    // A .ts file that throws on import must degrade to null + warn, NOT abort.
    const file = join(tempDir, 'index.ts')
    await fs.writeFile(file, 'throw new Error("boom at import time")\nexport default {}', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await loadTranslationFile(file)).toBeNull()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
