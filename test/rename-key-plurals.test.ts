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
    it('should detect conflicts when renaming to an existing plural key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('key', { count: 1 })\nt('key2', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({
          key_one: 'keyItem',
          key_other: 'keyItems',
          key2_one: 'key2Item',
          key2_other: 'keys2Items'
        })
      )

      const result = await runRenameKey(config, 'key', 'key2')

      expect(result.success).toBe(false)
      expect(result.conflicts?.length).toBeGreaterThan(0)
      expect(result.conflicts).toContain('en:key2_one')
      expect(result.conflicts).toContain('en:key2_other')

      // Should not overwrite key2_one and key2_other with key_one and key_other values
      const updatedTranslation = JSON.parse(
        await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8')
      )
      expect(updatedTranslation.key_one).toBe('keyItem')
      expect(updatedTranslation.key_other).toBe('keyItems')
      expect(updatedTranslation.key2_one).toBe('key2Item')
      expect(updatedTranslation.key2_other).toBe('keys2Items')
    })

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
    it('should move a { ns } call with custom pluralSeparator forms to the default namespace', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          nsSeparator: ':',
          defaultNS: 'ns1',
          pluralSeparator: '-'
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('key', { ns: 'ns2', count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/ns2.json'),
        JSON.stringify({ 'key-one': 'item', 'key-other': 'items' })
      )
      await writeFile(join(testDir, 'locales/en/ns1.json'), JSON.stringify({}))

      const result = await runRenameKey(config, 'ns2:key', 'key')

      expect(result.success).toBe(true)
      expect(await readFile(join(testDir, 'test.ts'), 'utf-8')).toBe("t('key', {count: 1})")
      const ns1 = JSON.parse(await readFile(join(testDir, 'locales/en/ns1.json'), 'utf-8'))
      expect(ns1).toEqual({ 'key-one': 'item', 'key-other': 'items' })
    })

    it('should rename ordinal plural forms', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }
      await writeFile(join(testDir, 'test.ts'), "t('place', { count: 1, ordinal: true })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ place_ordinal_one: '{{count}}st', place_ordinal_two: '{{count}}nd', place_ordinal_few: '{{count}}rd', place_ordinal_other: '{{count}}th' })
      )

      const result = await runRenameKey(config, 'place', 'rank')

      expect(result.success).toBe(true)
      expect(JSON.parse(await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8'))).toEqual({
        rank_ordinal_one: '{{count}}st',
        rank_ordinal_two: '{{count}}nd',
        rank_ordinal_few: '{{count}}rd',
        rank_ordinal_other: '{{count}}th'
      })
    })

    describe('context forms', () => {
      const config = () => ({
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      })

      const writeTranslations = async (translations: Record<string, string>) => {
        await mkdir(join(testDir, 'locales/en'), { recursive: true })
        await writeFile(join(testDir, 'locales/en/translation.json'), JSON.stringify(translations))
      }

      const readTranslations = async () =>
        JSON.parse(await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8'))

      it('should rename plural forms with context', async () => {
        await writeFile(join(testDir, 'test.ts'), "t('friend', { context: 'male', count: 1 })")
        await writeTranslations({ friend_male_one: 'a boyfriend', friend_male_other: 'boyfriends' })

        const result = await runRenameKey(config(), 'friend', 'buddy')

        expect(result.success).toBe(true)
        expect(await readFile(join(testDir, 'test.ts'), 'utf-8')).toBe("t('buddy', { context: 'male', count: 1 })")
        expect(await readTranslations()).toEqual({ buddy_male_one: 'a boyfriend', buddy_male_other: 'boyfriends' })
      })

      it('should rename context forms of a key used with a dynamic context', async () => {
        await writeFile(join(testDir, 'test.ts'), 't(\'friend\', { context: gender })')
        await writeTranslations({ friend_male: 'a boyfriend', friend_female: 'a girlfriend' })

        const result = await runRenameKey(config(), 'friend', 'buddy')

        expect(result.success).toBe(true)
        expect(await readTranslations()).toEqual({ buddy_male: 'a boyfriend', buddy_female: 'a girlfriend' })
      })

      it('should leave keys that start with the key alone when the source uses no context', async () => {
        await writeFile(join(testDir, 'test.ts'), "t('friend')\nt('friend_list')")
        await writeTranslations({ friend: 'a friend', friend_list: 'friends' })

        const result = await runRenameKey(config(), 'friend', 'buddy')

        expect(result.success).toBe(true)
        expect(await readTranslations()).toEqual({ buddy: 'a friend', friend_list: 'friends' })
      })

      it('should detect conflicts with context forms of the target key', async () => {
        await writeFile(join(testDir, 'test.ts'), 't(\'friend\', { context: gender })')
        await writeTranslations({ friend_male: 'a boyfriend', buddy_male: 'a buddy' })

        const result = await runRenameKey(config(), 'friend', 'buddy')

        expect(result.success).toBe(false)
        expect(result.conflicts).toContain('en:buddy_male')
      })
    })

    it('should rename plural forms nested under the key path', async () => {
      const config = {
        locales: ['en', 'de'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('cart.item', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await mkdir(join(testDir, 'locales/de'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ cart: { item_one: 'item', item_other: 'items', total: 'Total' } })
      )
      await writeFile(
        join(testDir, 'locales/de/translation.json'),
        JSON.stringify({ cart: { item_one: 'Artikel', item_other: 'Artikel' } })
      )

      const result = await runRenameKey(config, 'cart.item', 'basket.product')

      expect(result.success).toBe(true)
      expect(await readFile(join(testDir, 'test.ts'), 'utf-8')).toBe("t('basket.product', { count: 1 })")
      expect(JSON.parse(await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8'))).toEqual({
        cart: { total: 'Total' },
        basket: { product_one: 'item', product_other: 'items' }
      })
      expect(JSON.parse(await readFile(join(testDir, 'locales/de/translation.json'), 'utf-8'))).toEqual({
        basket: { product_one: 'Artikel', product_other: 'Artikel' }
      })
    })

    it('should detect conflicts with nested plural forms of the target key', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json')
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('cart.item', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ cart: { item_one: 'item', item_other: 'items', product_one: 'product', product_other: 'products' } })
      )

      const result = await runRenameKey(config, 'cart.item', 'cart.product')

      expect(result.success).toBe(false)
      expect(result.conflicts).toEqual(['en:cart.product_one', 'en:cart.product_other'])
    })

    it('should rename plural forms that use a custom pluralSeparator', async () => {
      const config = {
        locales: ['en'],
        extract: {
          input: [join(testDir, '*.ts')],
          output: join(testDir, 'locales/{{language}}/{{namespace}}.json'),
          pluralSeparator: '-'
        }
      }

      await writeFile(join(testDir, 'test.ts'), "t('item', { count: 1 })")
      await mkdir(join(testDir, 'locales/en'), { recursive: true })
      await writeFile(
        join(testDir, 'locales/en/translation.json'),
        JSON.stringify({ 'item-one': 'item', 'item-other': 'items' })
      )

      const result = await runRenameKey(config, 'item', 'product')

      expect(result.success).toBe(true)
      expect(JSON.parse(await readFile(join(testDir, 'locales/en/translation.json'), 'utf-8'))).toEqual({
        'product-one': 'item',
        'product-other': 'items'
      })
    })
  })
})
