import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
    // keySeparator defaults to "."
  },
}

describe('extractor: keySeparator issue #200', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // --- t() tests ---

  describe('t() - empty string segments from keys containing keySeparator', () => {
    it('should extract "Loading..." as a flat key, not create empty nested segments', async () => {
      // Bug: t("Loading...") produces { "Loading": { "": { "": { "": "Loading..." } } } }
      // Expected: { "Loading...": "Loading..." }
      const sampleCode = 't("Loading...")'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'Loading...': 'Loading...',
      })

      // Explicitly assert no empty-string keys exist anywhere in the output
      const json = JSON.stringify(translationFile!.newTranslations)
      expect(json).not.toContain('""')
    })

    it('should extract keys with trailing dots as flat keys (e.g. "Hello.")', async () => {
      // A trailing dot should not create an empty segment at the end
      const sampleCode = 't("Hello.", "Hello.")'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'Hello.': 'Hello.',
      })
    })

    it('should extract keys with leading dots as flat keys (e.g. ".start")', async () => {
      // A leading dot should not create an empty segment at the beginning
      const sampleCode = 't(".start", ".start")'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        '.start': '.start',
      })
    })

    it('should extract keys with consecutive dots as flat keys (e.g. "a..b")', async () => {
      // Consecutive dots should not produce an empty middle segment
      const sampleCode = 't("a..b", "a..b")'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'a..b': 'a..b',
      })
    })
  })

  describe('t() - nesting conflict detection', () => {
    it('should not overwrite an existing nested key when a flat conflicting key is later extracted', async () => {
      // Bug: t("a.b") then t("a.b.c") results in:
      //   { "a": { "b": "a.b" }, "a.b.c": "a.b.c" }
      // and subsequent runs will always re-overwrite "a.b.c" back to its key string.
      // Expected: the conflict is detected, and "a.b" (already nested) is preserved;
      // "a.b.c" should either raise a warning or be stored as-is without destroying "a.b".
      const sampleCode = `
        t("a.b", "Value AB");
        t("a.b.c", "Value ABC");
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()

      // "a.b" should remain a leaf with its default value
      expect((translationFile!.newTranslations as any)?.a?.b).toBe('Value AB')

      // "a.b.c" cannot coexist with "a.b" as a leaf — the extractor should
      // detect the conflict rather than silently falling back to the key string.
      // It must NOT produce { "a.b.c": "a.b.c" } (key-as-value fallback).
      expect((translationFile!.newTranslations as any)?.['a.b.c']).toBeUndefined()
    })

    it('should detect conflict when deeper key is extracted first', async () => {
      // Reverse order: deeper key first, then shallower
      const sampleCode = `
        t("a.b.c", "Value ABC");
        t("a.b", "Value AB");
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()

      // "a.b.c" should be nested
      expect((translationFile!.newTranslations as any)?.a?.b?.c).toBe('Value ABC')

      // "a.b" cannot be both a leaf and a parent — conflict must be detected,
      // not silently fall back to storing the key as its own value.
      expect((translationFile!.newTranslations as any)?.['a.b']).toBeUndefined()
    })

    it('should not silently convert a previously-flat key into a nested object', async () => {
      // If "a.b" was already extracted as a leaf, adding "a.b.c" must not
      // silently turn "a.b" into a nested object and lose its value.
      const sampleCode = `
        t("a.b", "Flat Value");
        t("a.b.c", "Deeper Value");
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()

      const translations = translationFile!.newTranslations as any

      // "a.b" must not have been silently turned into an object
      expect(typeof translations?.a?.b).not.toBe('object')
    })
  })

  // --- Trans component tests ---

  describe('Trans component - empty string segments from keys containing keySeparator', () => {
    it('should extract Trans with "Loading..." i18nKey as a flat key', async () => {
      // Same bug as t() but via Trans component
      const sampleCode = '<Trans i18nKey="Loading...">Loading...</Trans>'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'Loading...': 'Loading...',
      })

      const json = JSON.stringify(translationFile!.newTranslations)
      expect(json).not.toContain('""')
    })

    it('should extract Trans with trailing-dot i18nKey as a flat key', async () => {
      const sampleCode = '<Trans i18nKey="Please wait.">Please wait.</Trans>'
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toEqual({
        'Please wait.': 'Please wait.',
      })
    })
  })

  describe('Trans component - nesting conflict detection', () => {
    it('should detect conflict between Trans i18nKey and t() producing overlapping paths', async () => {
      // Trans writes "a.b" as a leaf; t() tries to write "a.b.c" — conflict
      const sampleCode = `
        <Trans i18nKey="a.b">Value AB</Trans>
        t("a.b.c", "Value ABC");
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile).toBeDefined()

      const translations = translationFile!.newTranslations as any

      // Must not silently fall back to key-as-value for the conflicting entry
      expect(translations?.['a.b.c']).toBeUndefined()
    })
  })
})
