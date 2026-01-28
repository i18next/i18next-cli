import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runRenameKey } from '../src/index'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

describe('runRenameKey (plurals', () => {
  const testDir = join(process.cwd(), 'test-rename-plur-temp')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('basic functionality', () => {
    it('should rename all plural forms in translation files when renaming a pluralized key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('key', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )

      const result = await runRenameKey(config, 'key', 'key2')
      expect(result.success).toBe(true)

      const updatedTranslation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(updatedTranslation.key2_one).toBe('item')
      expect(updatedTranslation.key2_other).toBe('items')
      expect(updatedTranslation.key_one).toBeUndefined()
      expect(updatedTranslation.key_other).toBeUndefined()
    })

    it('should rename plural forms with namespace change: key -> ns2:key2', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({})
      )
      const result = await runRenameKey(config, 'key', 'ns2:key2')
      expect(result.success).toBe(true)
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.key2_one).toBe('item')
      expect(ns2.key2_other).toBe('items')
      const ns1 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns1.json'), 'utf-8')
      )
      expect(ns1.key_one).toBeUndefined()
      expect(ns1.key_other).toBeUndefined()
    })

    it('should rename plural forms with namespace removal: ns2:key -> key2', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key2', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({})
      )
      const result = await runRenameKey(config, 'ns2:key', 'key2')
      expect(result.success).toBe(true)
      const ns1 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns1.json'), 'utf-8')
      )
      expect(ns1.key2_one).toBe('item')
      expect(ns1.key2_other).toBe('items')
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.key_one).toBeUndefined()
      expect(ns2.key_other).toBeUndefined()
    })

    it('should rename plural forms with namespace change: ns2:key -> ns1:key2', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key2', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({})
      )
      const result = await runRenameKey(config, 'ns2:key', 'ns1:key2')
      expect(result.success).toBe(true)
      const ns1 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns1.json'), 'utf-8')
      )
      expect(ns1.key2_one).toBe('item')
      expect(ns1.key2_other).toBe('items')
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.key_one).toBeUndefined()
      expect(ns2.key_other).toBeUndefined()
    })

    it('should rename plural forms with namespace and key change: ns1:key -> ns2:key2', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({})
      )
      const result = await runRenameKey(config, 'ns1:key', 'ns2:key2')
      expect(result.success).toBe(true)
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.key2_one).toBe('item')
      expect(ns2.key2_other).toBe('items')
      const ns1 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns1.json'), 'utf-8')
      )
      expect(ns1.key_one).toBeUndefined()
      expect(ns1.key_other).toBeUndefined()
    })

    it('should rename plural forms with interpolation and ns option', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key', { count: 1, ns: 'ns2', user: 'foo' })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({ key_one: 'item', key_other: 'items' })
      )
      await writeFile(
        join(testDir, 'locales/en/ns1.json'),
        JSON.stringify({})
      )
      const result = await runRenameKey(config, 'key', 'key2')
      expect(result.success).toBe(true)
      const ns2 = JSON.parse(
        await readFile(join(testDir, 'locales/en/ns2.json'), 'utf-8')
      )
      expect(ns2.key2_one).toBe('item')
      expect(ns2.key2_other).toBe('items')
      expect(ns2.key_one).toBeUndefined()
      expect(ns2.key_other).toBeUndefined()
    })
  })
})
