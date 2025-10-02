import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { getTranslations } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

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

    const enItem = res1.find(r => r.path.endsWith('/locales/en/translation.json'))
    const deItem = res1.find(r => r.path.endsWith('/locales/de/translation.json'))
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
    const enItem2 = res2.find(r => r.path.endsWith('/locales/en/translation.json'))!
    const deItem2 = res2.find(r => r.path.endsWith('/locales/de/translation.json'))!
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
})
