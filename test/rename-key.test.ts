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

  describe('selector api', () => {
    it('should rename keys used with the selector API', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), 't(($) => $.old.key)')
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ old: { key: 'Selector Value' } })
      )

      const result = await runRenameKey(config, 'old.key', 'new.key')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain('t(($) => $.new.key)')

      const updatedTranslation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(updatedTranslation.new.key).toBe('Selector Value')
      expect(updatedTranslation.old?.key).toBeUndefined()
    })

    it('should rename keys used with the selector API using bracket notation', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), 't(($) => $["Old Key"])')
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ 'Old Key': 'Selector Value' })
      )

      const result = await runRenameKey(config, 'Old Key', 'newKey')

      expect(result.success).toBe(true)

      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain('t(($) => $.newKey)')

      const updatedTranslation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(updatedTranslation.newKey).toBe('Selector Value')
      expect(updatedTranslation['Old Key']).toBeUndefined()
    })
  })

  describe('namespace migration', () => {
    it('should move a key from one namespace to another', async () => {
      const config = {
        locales: ['en', 'de'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':'
        }
      }

      // Create a source file using the old namespace
      await writeFile(join(testDir, 'test.ts'), "t('ns1:move.key')")
      // Create translation files for both namespaces and locales
      for (const locale of ['en', 'de']) {
        await mkdir(join(testDir, `locales/${locale}`), { recursive: true })
        await writeFile(
          join(testDir, `locales/${locale}/ns1.json`),
          JSON.stringify({ move: { key: `Value in ${locale}` } })
        )
        await writeFile(
          join(testDir, `locales/${locale}/ns2.json`),
          JSON.stringify({})
        )
      }

      const result = await runRenameKey(config, 'ns1:move.key', 'ns2:move.key')

      expect(result.success).toBe(true)
      // Source file should be updated
      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('ns2:move.key')")
      // Old key should be removed from ns1.json, new key should be in ns2.json
      for (const locale of ['en', 'de']) {
        const ns1 = JSON.parse(
          await readFile(join(testDir, `locales/${locale}/ns1.json`), 'utf-8')
        )
        const ns2 = JSON.parse(
          await readFile(join(testDir, `locales/${locale}/ns2.json`), 'utf-8')
        )
        expect(ns1.move?.key).toBeUndefined()
        expect(ns2.move.key).toBe(`Value in ${locale}`)
      }
    })
  })

  describe('namespace migration', () => {
    it('should move a key from one namespace to another', async () => {
      const config = {
        locales: ['en', 'de'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':'
        }
      }

      // Create a source file using the old namespace
      await writeFile(join(testDir, 'test.ts'), "t('ns1:move.key')")
      // Create translation files for both namespaces and locales
      for (const locale of ['en', 'de']) {
        await mkdir(join(testDir, `locales/${locale}`), { recursive: true })
        await writeFile(
          join(testDir, `locales/${locale}/ns1.json`),
          JSON.stringify({ move: { key: `Value in ${locale}` }, another: { keyHere: 'here' } })
        )
        await writeFile(
          join(testDir, `locales/${locale}/ns2.json`),
          JSON.stringify({ existing: { stuff: 'there' } })
        )
      }

      const result = await runRenameKey(config, 'ns1:move.key', 'ns2:move.key')

      expect(result.success).toBe(true)
      // Source file should be updated
      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('ns2:move.key')")
      // Old key should be removed from ns1.json, new key should be in ns2.json
      for (const locale of ['en', 'de']) {
        const ns1 = JSON.parse(
          await readFile(join(testDir, `locales/${locale}/ns1.json`), 'utf-8')
        )
        const ns2 = JSON.parse(
          await readFile(join(testDir, `locales/${locale}/ns2.json`), 'utf-8')
        )
        expect(ns1.another.keyHere).toBe('here')
        expect(ns1.move?.key).toBeUndefined()
        expect(ns1.move).toBeUndefined() // because empty
        expect(ns2.move.key).toBe(`Value in ${locale}`)
        expect(ns2.existing.stuff).toBe('there')
      }
    })
  })

  describe('namespace migration (ns option)', () => {
    it('should update t("key", { ns: "ns2" }) to t("key") when renaming ns2:key to key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('key', { ns: 'ns2' })\n")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({ key: 'Value' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({})
      )

      const result = await runRenameKey(config, 'ns2:key', 'key')
      expect(result.success).toBe(true)
      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      // Should be exactly t('key'), no leading \b or other artifacts
      expect(updatedCode).toContain("t('key')")
      expect(updatedCode).not.toMatch(/\\bt\('key'\)/)
      expect(updatedCode).not.toContain("t('key', { ns: 'ns2' })")
    })

    it('should update t("key", { ns: "ns1" }) to t("key", { ns: "ns2" })', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':'
        }
      }

      await writeFile(join(testDir, 'test.ts'), [
        "t('move.key', { ns: 'ns1' })",
        "t('move.key', { ns: \"ns1\" })",
        "t('move.key', { ns: `ns1` })"
      ].join('\n'))
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({ move: { key: 'Value' } })
      )
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({})
      )

      const result = await runRenameKey(config, 'ns1:move.key', 'ns2:move.key')

      expect(result.success).toBe(true)
      const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      expect(updatedCode).toContain("t('move.key', { ns: 'ns2' })")
      expect(updatedCode).toContain("t('move.key', { ns: \"ns2\" })")
      expect(updatedCode).toContain("t('move.key', { ns: `ns2` })")
      // Confirm translation file update
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.move.key).toBe('Value')
    })

    it('should not update t("ns1:key") when renaming "key" to "ns2:key" and back', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }

      // Create a source file with t('ns1:key') and t('key')
      await writeFile(join(testDir, 'test.ts'), "t('ns1:key')\nt('key')\n")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({ key: 'Value' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({})
      )

      // Rename 'key' to 'ns2:key'
      const result1 = await runRenameKey(config, 'key', 'ns2:key')
      expect(result1.success).toBe(true)
      let updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      // t('ns1:key') should NOT be changed
      expect(updatedCode).toContain("t('ns1:key')")
      // t('key') should be updated to t('key', { ns: 'ns2' })
      expect(updatedCode).toContain("t('key', { ns: 'ns2' })")

      // Now rename 'ns2:key' back to 'key'
      const result2 = await runRenameKey(config, 'ns2:key', 'key')
      expect(result2.success).toBe(true)
      updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
      // t('ns1:key') should still NOT be changed
      expect(updatedCode).toContain("t('ns1:key')")
      // t('key', { ns: 'ns2' }) should be updated back to t('key')
      expect(updatedCode).toContain("t('key')")
    })
  })

  it('should update t("key") to t("key", { ns: "ns2" }) when moving from defaultNS', async () => {
    const config = {
      locales: ['en'],
      extract: {
        input: [join(testDir, '*.ts')],
        output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
        nsSeparator: ':',
        defaultNS: 'ns1'
      }
    }

    await writeFile(join(testDir, 'test.ts'), "t('move.key')\n")
    await mkdir(join(testDir, 'locales/en'), { recursive: true })
    await writeFile(
      join(testDir, 'locales/en/ns1.json'),
      JSON.stringify({ move: { key: 'Value' } })
    )
    await writeFile(
      join(testDir, 'locales/en/ns2.json'),
      JSON.stringify({})
    )

    const result = await runRenameKey(config, 'ns1:move.key', 'ns2:move.key')

    expect(result.success).toBe(true)
    const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    expect(updatedCode).toContain("t('move.key', { ns: 'ns2' })")
    // Confirm translation file update
    const ns2 = JSON.parse(
      await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
    )
    expect(ns2.move.key).toBe('Value')
  })

  it('should not update t("ns1:key") when renaming "key" to "ns2:key" and back', async () => {
    const config = {
      locales: ['en'],
      extract: {
        input: [join(testDir, '*.ts')],
        output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
        nsSeparator: ':',
        defaultNS: 'ns1'
      }
    }

    // Create a source file with t('ns1:key') and t('key')
    await writeFile(join(testDir, 'test.ts'), "t('ns1:key')\nt('key')\n")
    await mkdir(join(testDir, 'locales/en'), { recursive: true })
    await writeFile(
      join(testDir, 'locales/en/ns1.json'),
      JSON.stringify({ key: 'Value' })
    )
    await writeFile(
      join(testDir, 'locales/en/ns2.json'),
      JSON.stringify({})
    )

    // Rename 'key' to 'ns2:key'
    const result1 = await runRenameKey(config, 'key', 'ns2:key')
    expect(result1.success).toBe(true)
    let updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    // t('ns1:key') should NOT be changed
    expect(updatedCode).toContain("t('ns1:key')")
    // t('key') should be updated to t('key', { ns: 'ns2' })
    expect(updatedCode).toContain("t('key', { ns: 'ns2' })")

    // Now rename 'ns2:key' back to 'key'
    const result2 = await runRenameKey(config, 'ns2:key', 'key')
    expect(result2.success).toBe(true)
    updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    // t('ns1:key') should still NOT be changed
    expect(updatedCode).toContain("t('ns1:key')")
    // t('key', { ns: 'ns2' }) should be updated back to t('key')
    expect(updatedCode).toContain("t('key')")
  })

  it('should update t("key", { ns: "ns1" }) to t("key", { ns: "ns2" })', async () => {
    const config = {
      locales: ['en'],
      extract: {
        input: [join(testDir, '*.ts')],
        output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
        nsSeparator: ':'
      }
    }

    await writeFile(join(testDir, 'test.ts'), [
      "t('move.key', { ns: 'ns1' })",
      "t('move.key', { ns: \"ns1\" })",
      "t('move.key', { ns: `ns1` })"
    ].join('\n'))
    await mkdir(join(testDir, 'locales/en'), { recursive: true })
    await writeFile(
      join(testDir, 'locales/en/ns1.json'),
      JSON.stringify({ move: { key: 'Value' } })
    )
    await writeFile(
      join(testDir, 'locales/en/ns2.json'),
      JSON.stringify({})
    )

    const result = await runRenameKey(config, 'ns1:move.key', 'ns2:move.key')

    expect(result.success).toBe(true)
    const updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    expect(updatedCode).toContain("t('move.key', { ns: 'ns2' })")
    expect(updatedCode).toContain("t('move.key', { ns: \"ns2\" })")
    expect(updatedCode).toContain("t('move.key', { ns: `ns2` })")
    // Confirm translation file update
    const ns2 = JSON.parse(
      await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
    )
    expect(ns2.move.key).toBe('Value')
  })

  it('should not update t("ns1:key") when renaming "key" to "ns2:key" and back', async () => {
    const config = {
      locales: ['en'],
      extract: {
        input: [join(testDir, '*.ts')],
        output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
        nsSeparator: ':',
        defaultNS: 'ns1'
      }
    }

    // Create a source file with t('ns1:key') and t('key')
    await writeFile(join(testDir, 'test.ts'), "t('ns1:key')\nt('key')\n")
    await mkdir(join(testDir, 'locales/en'), { recursive: true })
    await writeFile(
      join(testDir, 'locales/en/ns1.json'),
      JSON.stringify({ key: 'Value' })
    )
    await writeFile(
      join(testDir, 'locales/en/ns2.json'),
      JSON.stringify({})
    )

    // Rename 'key' to 'ns2:key'
    const result1 = await runRenameKey(config, 'key', 'ns2:key')
    expect(result1.success).toBe(true)
    let updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    // t('ns1:key') should NOT be changed
    expect(updatedCode).toContain("t('ns1:key')")
    // t('key') should be updated to t('key', { ns: 'ns2' })
    expect(updatedCode).toContain("t('key', { ns: 'ns2' })")

    // Now rename 'ns2:key' back to 'key'
    const result2 = await runRenameKey(config, 'ns2:key', 'key')
    expect(result2.success).toBe(true)
    updatedCode = await readFile(join(testDir, 'test.ts'), 'utf-8')
    // t('ns1:key') should still NOT be changed
    expect(updatedCode).toContain("t('ns1:key')")
    // t('key', { ns: 'ns2' }) should be updated back to t('key')
    expect(updatedCode).toContain("t('key')")
  })
})
