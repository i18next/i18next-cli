import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runRenameKey } from '../src/index'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

describe('runRenameKey', () => {
  const testDir = join(process.cwd(), 'test-rename-temp')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('basic functionality', () => {
    it('should rename simple keys', async () => {
      const config = {
        locales: ['en', 'de'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      // Create test files
      await writeFile(join(testDir, 'test.ts'), "t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.sourceFiles.length).toBeGreaterThan(0)
      expect(result.translationFiles.length).toBeGreaterThan(0)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('new.key')")

      const updatedTranslation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(updatedTranslation.new.key).toBe('Old Value')
      expect(updatedTranslation.old?.key).toBeUndefined()
    })

    it('should detect conflicts', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old' }, new: { key: 'Exists' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(false)
      expect(result.conflicts?.length).toBeGreaterThan(0)
      expect(result.conflicts).toContain('en:new.key')
    })

    it('should handle namespace prefixes', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':'
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('common:button.submit')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/common.json'),
        JSON.stringify({ button: { submit: 'Submit' } })
      )

      const result = await runRenameKey(config, 'common:button.submit', 'common:button.save')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('common:button.save')")
    })

    it('should handle dry-run mode', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key', { dryRun: true })

      expect(result.success).toBe(true)
      expect(result.sourceFiles.length).toBeGreaterThan(0)

      // Files should NOT be modified
      const code = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(code).toContain("t('old.key')")
      expect(code).not.toContain("t('new.key')")

      const translation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(translation.old.key).toBe('Old Value')
      expect(translation.new?.key).toBeUndefined()
    })
  })

  describe('custom function names', () => {
    it('should respect custom function names', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          functions: ['translate', 'i18n.t']
        }
      }

      await writeFile(join(testDir, 'test.ts'), "translate('old.key')\ni18n.t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("translate('new.key')")
      expect(updatedCode).toContain("i18n.t('new.key')")
    })

    it('should handle wildcard function patterns', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          functions: ['*.translate', '*.t']
        }
      }

      await writeFile(
        join(testDir, 'test.ts'),
        "i18n.translate('old.key')\nctx.t('old.key')\napp.translate('old.key')"
      )
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("i18n.translate('new.key')")
      expect(updatedCode).toContain("ctx.t('new.key')")
      expect(updatedCode).toContain("app.translate('new.key')")
    })
  })

  describe('JSX components', () => {
    it('should rename keys in Trans components', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.tsx')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          transComponents: ['Trans']
        }
      }

      await writeFile(
        join(testDir, 'test.tsx'),
        '<Trans i18nKey="old.key">Default text</Trans>'
      )
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.tsx'), 'utf-8')
      expect(updatedCode).toContain('i18nKey="new.key"')
    })

    it('should handle different quote styles', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.tsx')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(
        join(testDir, 'test.tsx'),
        `<Trans i18nKey='old.key'>Text</Trans>
<Trans i18nKey="old.key">Text</Trans>
<Trans i18nKey=\`old.key\`>Text</Trans>`
      )
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.tsx'), 'utf-8')
      expect(updatedCode).toContain("i18nKey='new.key'")
      expect(updatedCode).toContain('i18nKey="new.key"')
      expect(updatedCode).toContain('i18nKey=`new.key`')
    })
  })

  describe('multiple occurrences', () => {
    it('should rename all occurrences in a file', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(
        join(testDir, 'test.ts'),
        `const a = t('old.key')
const b = t('old.key')
const c = t("old.key")
const d = t(\`old.key\`)`
      )
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.sourceFiles[0].changes).toBe(4)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).not.toContain("'old.key'")
      expect(updatedCode).not.toContain('"old.key"')
      expect(updatedCode).not.toContain('`old.key`')
      expect((updatedCode.match(/new\.key/g) || []).length).toBe(4)
    })

    it('should rename across multiple files', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'file1.ts'), "t('old.key')")
      await writeFile(join(testDir, 'file2.ts'), "t('old.key')")
      await writeFile(join(testDir, 'file3.ts'), "t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Old Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.sourceFiles.length).toBe(3)

      for (let i = 1; i <= 3; i++) {
        const code = await readFile(join(testDir, `file${i}.ts`), 'utf-8')
        expect(code).toContain("t('new.key')")
      }
    })
  })

  describe('multiple locales', () => {
    it('should update all locale files', async () => {
      const config = {
        locales: ['en', 'de', 'fr'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('old.key')")

      for (const locale of ['en', 'de', 'fr']) {
        await mkdir(join(testDir, `locales/${locale}`), { recursive: true })
        await writeFile(
          join(testDir, `locales/${locale}/translation.json`),
          JSON.stringify({ old: { key: `Value in ${locale}` } })
        )
      }

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.translationFiles.length).toBe(3)

      for (const locale of ['en', 'de', 'fr']) {
        const translation = JSON.parse(
          await readFile(join(testDir, `locales/${locale}/translation.json`), 'utf-8')
        )
        expect(translation.new.key).toBe(`Value in ${locale}`)
        expect(translation.old?.key).toBeUndefined()
      }
    })
  })

  describe('edge cases', () => {
    it('should return error for empty old key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      const result = await runRenameKey(config, '', 'new.key')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Old key cannot be empty')
    })

    it('should return error for empty new key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      const result = await runRenameKey(config, 'old.key', '')

      expect(result.success).toBe(false)
      expect(result.error).toContain('New key cannot be empty')
    })

    it('should return error for identical keys', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      const result = await runRenameKey(config, 'same.key', 'same.key')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Old and new keys are identical')
    })

    it('should handle missing translation files gracefully', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('old.key')")
      // Don't create translation file

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.translationFiles.length).toBe(0)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('new.key')")
    })

    it('should handle keys not found in translation files', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ different: { key: 'Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.translationFiles.length).toBe(0) // No translation file updated

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('new.key')")
    })

    it('should not rename partial key matches', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(
        join(testDir, 'test.ts'),
        "t('old.key')\nt('old.key.nested')\nt('prefix.old.key')"
      )
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)
      expect(result.sourceFiles[0].changes).toBe(1) // Only exact match

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('new.key')")
      expect(updatedCode).toContain("t('old.key.nested')") // Not changed
      expect(updatedCode).toContain("t('prefix.old.key')") // Not changed
    })
  })

  describe('flat vs nested keys', () => {
    it('should handle flat keys (keySeparator: false)', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          keySeparator: false as const
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('old.key')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ 'old.key': 'Old Value' })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const translation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(translation['new.key']).toBe('Old Value')
      expect(translation['old.key']).toBeUndefined()
    })

    it('should rename from flat to nested structure', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          keySeparator: '.'
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('flatkey')")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ flatkey: 'Flat Value' })
      )

      const result = await runRenameKey(config, 'flatkey', 'nested.new.key')

      expect(result.success).toBe(true)

      const translation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(translation.nested.new.key).toBe('Flat Value')
      expect(translation.flatkey).toBeUndefined()
    })
  })
})
