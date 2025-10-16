import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { getTranslations } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'
import { pathEndsWith } from './utils/path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

describe('extractor.getTranslations', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('returns updated=true when files are missing, then updated=false when identical files exist', async () => {
    const keysMap = new Map<string, { key: string; defaultValue?: string }>()
    keysMap.set('hello', { key: 'hello', defaultValue: 'Hello!' })
    keysMap.set('ns.sub', { key: 'ns.sub', defaultValue: 'Sub value' })

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        defaultNS: 'translation',
      },
    }

    // 1) No files exist -> should report updated=true and produce expected values
    const res1 = await getTranslations(keysMap as any, new Set(), config)
    // two locales
    expect(res1.length).toBe(2)

    const enItem = res1.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    const deItem = res1.find(r => pathEndsWith(r.path, '/locales/de/translation.json'))
    expect(enItem).toBeDefined()
    expect(deItem).toBeDefined()
    expect(enItem!.updated).toBe(true)
    expect(deItem!.updated).toBe(true)

    // en should use defaults, de should be empty strings
    expect(enItem!.newTranslations).toEqual({
      hello: 'Hello!',
      ns: { sub: 'Sub value' },
    })
    expect(deItem!.newTranslations).toEqual({
      hello: '',
      ns: { sub: '' },
    })

    // 2) Persist those newContents as files
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/de'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(enItem!.newTranslations, null, 2))
    await vol.promises.writeFile(dePath, JSON.stringify(deItem!.newTranslations, null, 2))

    // 3) Call again -> updated should be false as files match generated content
    const res2 = await getTranslations(keysMap as any, new Set(), config)
    const enItem2 = res2.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))!
    const deItem2 = res2.find(r => pathEndsWith(r.path, '/locales/de/translation.json'))!
    expect(enItem2.updated).toBe(false)
    expect(deItem2.updated).toBe(false)

    // existingTranslations should reflect the file contents
    expect(enItem2.existingTranslations).toEqual(enItem!.newTranslations)
    expect(deItem2.existingTranslations).toEqual(deItem!.newTranslations)
  })

  it('should not sort keys when sort is false', async () => {
    const keysMap = new Map<string, { key: string; defaultValue?: string }>()
    // Add keys in a specific, non-alphabetical order
    keysMap.set('zebra', { key: 'zebra', defaultValue: 'Zebra' })
    keysMap.set('apple', { key: 'apple', defaultValue: 'Apple' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: false, // <-- Disable sorting
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // Assert that the object keys are in the original insertion order
    const resultKeys = Object.keys(result.newTranslations)
    expect(resultKeys[0]).toBe('zebra')
    expect(resultKeys[1]).toBe('apple')
  })

  it('should use custom sort comparator', async () => {
    const keysMap = new Map<string, { key: string; defaultValue?: string }>()
    // Add keys in a specific, non-alphabetical order
    keysMap.set('zebra', { key: 'zebra', defaultValue: 'Zebra' })
    keysMap.set('apple', { key: 'apple', defaultValue: 'Apple' })
    keysMap.set('snail', { key: 'snail', defaultValue: 'Snail' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: (a, b) => a.key > b.key ? -1 : a.key < b.key ? 1 : 0, // sort in reverse order
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // Assert that the object keys are ordered by the custom comparator
    const resultKeys = Object.keys(result.newTranslations)
    expect(resultKeys[0]).toBe('zebra')
    expect(resultKeys[1]).toBe('snail')
    expect(resultKeys[2]).toBe('apple')
  })

  it('should correctly sort top-level keys alphabetically when nested and flat keys are mixed', async () => {
    const keysMap = new Map<string, { key: string; defaultValue?: string }>()
    // Add keys in a jumbled, non-alphabetical order
    keysMap.set('person-foo', { key: 'person-foo', defaultValue: 'person-foo' })
    keysMap.set('animal.cat', { key: 'animal.cat', defaultValue: 'Cat' })
    keysMap.set('person.bla', { key: 'person.bla', defaultValue: 'person.bla' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: true, // <-- Enable default alphabetical sorting
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // Assert that the top-level keys of the final object are sorted alphabetically.
    const resultKeys = Object.keys(result.newTranslations)
    expect(resultKeys[0]).toBe('animal')
    expect(resultKeys[1]).toBe('person')
    expect(resultKeys[2]).toBe('person-foo')
  })

  it('should use custom sort for top-level keys when nested and flat keys are mixed', async () => {
    const keyPersonFoo = { key: 'person-foo', defaultValue: 'person-foo' }
    const keyAnimalCat = { key: 'animal.cat', defaultValue: 'Cat' }
    const keyPersonBla = { key: 'person.bla', defaultValue: 'person.bla' }

    const keysMap = new Map<string, any>()
    keysMap.set('person-foo', keyPersonFoo)
    keysMap.set('animal.cat', keyAnimalCat)
    keysMap.set('person.bla', keyPersonBla)

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        // The sort function now correctly derives the top-level key before comparing lengths.
        sort: (a, b) => {
          const keyAroot = a.key.split('.')[0]
          const keyBroot = b.key.split('.')[0]
          return keyAroot.length - keyBroot.length
        },
      }
    }

    const [result] = await getTranslations(keysMap, new Set(), config)

    // Assert that the top-level keys are sorted by the custom comparator.
    // 'person' (len 6) < 'animal' (len 6) < 'person-foo' (len 10)
    // The relative order of 'person' and 'animal' might be unstable, but this is a more robust check.
    const resultKeys = Object.keys(result.newTranslations)

    // The key with the longest top-level part should be last.
    expect(resultKeys[2]).toBe('person-foo')
    // The other two have the same length, so we just check for their presence.
    expect(resultKeys).toContain('person')
    expect(resultKeys).toContain('animal')
  })

  it('should correctly sort keys within nested objects', async () => {
    const keysMap = new Map<string, { key: string; defaultValue?: string }>()
    // Add keys for a nested object in a non-alphabetical order
    keysMap.set('buttons.scroll-to-top', { key: 'buttons.scroll-to-top' })
    keysMap.set('buttons.cancel', { key: 'buttons.cancel' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: true, // Enable default alphabetical sorting
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // Assert that the keys *inside* the 'buttons' object are sorted alphabetically.
    const nestedKeys = Object.keys(result.newTranslations.buttons)
    expect(nestedKeys[0]).toBe('cancel')
    expect(nestedKeys[1]).toBe('scroll-to-top')
  })

  it('should sort keys case-insensitively when sort is true', async () => {
    const keysMap = new Map<string, { key: string }>()
    // Add keys in a jumbled, mixed-case order
    keysMap.set('Zebra', { key: 'Zebra' })
    keysMap.set('apple', { key: 'apple' })
    keysMap.set('Appl', { key: 'Appl' })
    keysMap.set('Banana', { key: 'Banana' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: true,
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // Assert that the keys are in case-insensitive alphabetical order.
    const resultKeys = Object.keys(result.newTranslations)
    expect(resultKeys).toEqual(['Appl', 'apple', 'Banana', 'Zebra'])
  })

  it('should handle the FOO vs foo case correctly with case-insensitive sorting', async () => {
    const keysMap = new Map<string, { key: string }>()
    // Add the specific case mentioned: FOO and foo
    keysMap.set('FOO', { key: 'FOO' })
    keysMap.set('foo', { key: 'foo' })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: 'src/**/*.{ts,tsx}',
        output: 'locales/{{language}}/{{namespace}}.json',
        sort: true,
      }
    }

    const [result] = await getTranslations(keysMap as any, new Set(), config)

    // In case-insensitive sorting, lowercase should come before uppercase when they're the same word
    const resultKeys = Object.keys(result.newTranslations)
    expect(resultKeys).toEqual(['foo', 'FOO'])
  })

  describe('plural forms sorting', () => {
    it('should sort plural forms in canonical order (zero, one, two, few, many, other)', async () => {
      const keysMap = new Map<string, any>()
      // Add plural keys in mixed order to test sorting - only forms that English supports
      keysMap.set('item_other', { key: 'item_other', hasCount: true })
      keysMap.set('item_one', { key: 'item_one', hasCount: true })
      // Add a regular key to ensure it sorts separately
      keysMap.set('label', { key: 'label', defaultValue: 'Label' })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Convert to array to check order
      const resultKeys = Object.keys(result.newTranslations)

      // Should have regular key first, then plural forms in canonical order
      expect(resultKeys).toEqual([
        'item_one',
        'item_other',
        'label'
      ])
    })

    it('should group plural forms by base key and sort each group canonically', async () => {
      const keysMap = new Map<string, any>()
      // Multiple plural groups in mixed order - only English-supported forms
      keysMap.set('calculator.option_days_other', { key: 'calculator.option_days_other', hasCount: true })
      keysMap.set('calculator.option_one', { key: 'calculator.option_one', hasCount: true })
      keysMap.set('calculator.option_days_one', { key: 'calculator.option_days_one', hasCount: true })
      keysMap.set('calculator.option_other', { key: 'calculator.option_other', hasCount: true })
      keysMap.set('calculator.label', { key: 'calculator.label', defaultValue: 'Label' })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Check the nested structure
      const calculatorKeys = Object.keys(result.newTranslations.calculator)

      expect(calculatorKeys).toEqual([
        'label',                    // Regular key first
        'option_one',              // Base option group in canonical order
        'option_other',
        'option_days_one',         // Days group in canonical order
        'option_days_other'
      ])
    })

    it('should sort ordinal plurals after cardinal plurals', async () => {
      const keysMap = new Map<string, any>()
      // Mix of cardinal and ordinal plurals - English forms only
      keysMap.set('place_ordinal_other', { key: 'place_ordinal_other', hasCount: true, isOrdinal: true })
      keysMap.set('place_one', { key: 'place_one', hasCount: true })
      keysMap.set('place_ordinal_one', { key: 'place_ordinal_one', hasCount: true, isOrdinal: true })
      keysMap.set('place_other', { key: 'place_other', hasCount: true })
      keysMap.set('place_ordinal_few', { key: 'place_ordinal_few', hasCount: true, isOrdinal: true })
      keysMap.set('place_ordinal_two', { key: 'place_ordinal_two', hasCount: true, isOrdinal: true })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      const resultKeys = Object.keys(result.newTranslations)

      // Cardinal plurals should come first, then ordinal plurals
      expect(resultKeys).toEqual([
        'place_one',
        'place_other',
        'place_ordinal_one',
        'place_ordinal_two',
        'place_ordinal_few',
        'place_ordinal_other'
      ])
    })

    it('should work with custom plural separators', async () => {
      const keysMap = new Map<string, any>()
      // Using custom separator - English forms only
      keysMap.set('item-other', { key: 'item-other', hasCount: true })
      keysMap.set('item-one', { key: 'item-one', hasCount: true })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
          pluralSeparator: '-', // Custom separator
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      const resultKeys = Object.keys(result.newTranslations)

      // Should sort in canonical order with custom separator
      expect(resultKeys).toEqual([
        'item-one',
        'item-other'
      ])
    })

    it('should preserve alphabetical sorting for non-plural keys while sorting plural groups canonically', async () => {
      const keysMap = new Map<string, any>()
      // Mix of regular and plural keys
      keysMap.set('zebra', { key: 'zebra', defaultValue: 'Zebra' })
      keysMap.set('item_other', { key: 'item_other', hasCount: true })
      keysMap.set('apple', { key: 'apple', defaultValue: 'Apple' })
      keysMap.set('item_one', { key: 'item_one', hasCount: true })
      keysMap.set('banana', { key: 'banana', defaultValue: 'Banana' })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      const resultKeys = Object.keys(result.newTranslations)

      // Regular keys alphabetically, plural keys grouped and sorted canonically
      expect(resultKeys).toEqual([
        'apple',
        'banana',
        'item_one',
        'item_other',
        'zebra'
      ])
    })

    it('should not apply plural sorting when sort is false', async () => {
      const keysMap = new Map<string, any>()
      // Add plural keys in non-canonical order
      keysMap.set('item_other', { key: 'item_other', hasCount: true })
      keysMap.set('item_one', { key: 'item_one', hasCount: true })

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: false, // Sorting disabled
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      const resultKeys = Object.keys(result.newTranslations)

      // Should preserve insertion order when sorting is disabled
      expect(resultKeys).toEqual([
        'item_other',
        'item_one'
      ])
    })
  })

  describe('optional _zero suffix handling', () => {
    it('should preserve existing _zero forms when related plural keys are present', async () => {
      const keysMap = new Map<string, any>()
      // Only include non-zero plural forms in extracted keys
      keysMap.set('item_one', { key: 'item_one', hasCount: true })
      keysMap.set('item_other', { key: 'item_other', hasCount: true })

      // Create existing file with _zero form
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          item_zero: 'No items',
          item_one: 'One item',
          item_other: '{{count}} items'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve the existing _zero form
      expect(result.newTranslations.item_zero).toBe('No items')
      expect(result.newTranslations.item_one).toBe('One item')
      expect(result.newTranslations.item_other).toBe('{{count}} items')

      // Check sorting order
      const resultKeys = Object.keys(result.newTranslations)
      expect(resultKeys).toEqual(['item_zero', 'item_one', 'item_other'])
    })

    it('should remove _zero forms when no related plural keys exist', async () => {
      const keysMap = new Map<string, any>()
      // Only include unrelated keys
      keysMap.set('message_one', { key: 'message_one', hasCount: true })
      keysMap.set('message_other', { key: 'message_other', hasCount: true })

      // Create existing file with _zero form for different base key
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          item_zero: 'No items',
          item_one: 'One item',
          item_other: '{{count}} items',
          message_one: 'One message',
          message_other: '{{count}} messages'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
          removeUnusedKeys: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should NOT preserve item_zero since item_* keys are not extracted
      expect(result.newTranslations.item_zero).toBeUndefined()
      expect(result.newTranslations.item_one).toBeUndefined()
      expect(result.newTranslations.item_other).toBeUndefined()

      // Should keep message keys
      expect(result.newTranslations.message_one).toBe('One message')
      expect(result.newTranslations.message_other).toBe('{{count}} messages')
    })

    it('should handle _zero with context keys correctly', async () => {
      const keysMap = new Map<string, any>()
      keysMap.set('item_days_one', { key: 'item_days_one', hasCount: true, context: 'days' })
      keysMap.set('item_days_other', { key: 'item_days_other', hasCount: true, context: 'days' })
      keysMap.set('item_one', { key: 'item_one', hasCount: true })
      keysMap.set('item_other', { key: 'item_other', hasCount: true })

      // Create existing file with _zero forms
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          item_zero: 'No items',
          item_one: 'One item',
          item_other: '{{count}} items',
          item_days_zero: 'No days',
          item_days_one: 'One day',
          item_days_other: '{{count}} days'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve both _zero forms
      expect(result.newTranslations.item_zero).toBe('No items')
      expect(result.newTranslations.item_days_zero).toBe('No days')

      // Check sorting order
      const resultKeys = Object.keys(result.newTranslations)
      expect(resultKeys).toEqual([
        'item_zero',
        'item_one',
        'item_other',
        'item_days_zero',
        'item_days_one',
        'item_days_other'
      ])
    })

    it('should handle _zero with custom plural separators', async () => {
      const keysMap = new Map<string, any>()
      keysMap.set('count-one', { key: 'count-one', hasCount: true })
      keysMap.set('count-other', { key: 'count-other', hasCount: true })

      // Create existing file with _zero form using custom separator
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          'count-zero': 'No count',
          'count-one': 'One count',
          'count-other': '{{count}} counts'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          pluralSeparator: '-',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve _zero form with custom separator
      expect(result.newTranslations['count-zero']).toBe('No count')
      expect(result.newTranslations['count-one']).toBe('One count')
      expect(result.newTranslations['count-other']).toBe('{{count}} counts')
    })

    it('should handle ordinal _zero forms correctly', async () => {
      const keysMap = new Map<string, any>()
      keysMap.set('rank_ordinal_one', { key: 'rank_ordinal_one', hasCount: true, isOrdinal: true })
      keysMap.set('rank_ordinal_other', { key: 'rank_ordinal_other', hasCount: true, isOrdinal: true })
      keysMap.set('rank_one', { key: 'rank_one', hasCount: true })
      keysMap.set('rank_other', { key: 'rank_other', hasCount: true })

      // Create existing file with ordinal _zero forms
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          rank_zero: 'No rank',
          rank_one: '1st rank',
          rank_other: '{{count}}th rank',
          rank_ordinal_zero: 'No ordinal rank',
          rank_ordinal_one: '1st',
          rank_ordinal_other: '{{count}}th'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve both cardinal and ordinal _zero forms
      expect(result.newTranslations.rank_zero).toBe('No rank')
      expect(result.newTranslations.rank_ordinal_zero).toBe('No ordinal rank')

      // Check sorting order: cardinal forms first, then ordinal forms
      const resultKeys = Object.keys(result.newTranslations)
      expect(resultKeys).toEqual([
        'rank_zero',
        'rank_one',
        'rank_other',
        'rank_ordinal_zero',
        'rank_ordinal_one',
        'rank_ordinal_other'
      ])
    })

    it('should not preserve _zero when removeUnusedKeys is false', async () => {
      const keysMap = new Map<string, any>()
      keysMap.set('item_one', { key: 'item_one', hasCount: true })
      keysMap.set('item_other', { key: 'item_other', hasCount: true })

      // Create existing file with additional keys including _zero
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          item_zero: 'No items',
          item_one: 'One item',
          item_other: '{{count}} items',
          legacy_key: 'Legacy value'
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          removeUnusedKeys: false, // Keep all existing keys
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve all existing keys when removeUnusedKeys is false
      expect(result.newTranslations.item_zero).toBe('No items')
      expect(result.newTranslations.item_one).toBe('One item')
      expect(result.newTranslations.item_other).toBe('{{count}} items')
      expect(result.newTranslations.legacy_key).toBe('Legacy value')
    })

    it('should handle nested _zero keys correctly', async () => {
      const keysMap = new Map<string, any>()
      keysMap.set('dashboard.alerts.count_one', { key: 'dashboard.alerts.count_one', hasCount: true })
      keysMap.set('dashboard.alerts.count_other', { key: 'dashboard.alerts.count_other', hasCount: true })

      // Create existing file with nested _zero form
      await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
      await vol.promises.writeFile(
        resolve(process.cwd(), 'locales/en/translation.json'),
        JSON.stringify({
          dashboard: {
            alerts: {
              count_zero: 'No alerts',
              count_one: 'One alert',
              count_other: '{{count}} alerts'
            }
          }
        }, null, 2)
      )

      const config: I18nextToolkitConfig = {
        locales: ['en'],
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
          sort: true,
        }
      }

      const [result] = await getTranslations(keysMap, new Set(), config)

      // Should preserve nested _zero form
      expect(result.newTranslations.dashboard.alerts.count_zero).toBe('No alerts')
      expect(result.newTranslations.dashboard.alerts.count_one).toBe('One alert')
      expect(result.newTranslations.dashboard.alerts.count_other).toBe('{{count}} alerts')

      // Check nested sorting
      const alertKeys = Object.keys(result.newTranslations.dashboard.alerts)
      expect(alertKeys).toEqual(['count_zero', 'count_one', 'count_other'])
    })
  })
})
