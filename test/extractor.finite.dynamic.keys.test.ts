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
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
    nsSeparator: false,
  },
}

// "extract: support TS type-aware resolution for finite dynamic keys
//  (template unions, const maps, helper returns)"
describe('extractor: finite dynamic key resolution (issue #210)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // ─── Pattern 1: template literal whose slot is a declare const with an inline union ──────────

  describe('template literal with declare const typed to an inline string-literal union', () => {
    it('should expand all union members into concrete keys', async () => {
      // Mirrors: t(`prefix_${type}`) where type is declared as a union type
      const sampleCode = `
        declare const variant: 'one' | 'two' | 'three';
        t(\`prefix_\${variant}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('prefix_one')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_two')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_three')
    })

    it('should produce no spurious keys beyond the declared union members', async () => {
      const sampleCode = `
        declare const variant: 'alpha' | 'beta';
        t(\`section_\${variant}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      const keys = Object.keys(translationFile!.newTranslations)
      expect(keys).toEqual(expect.arrayContaining(['section_alpha', 'section_beta']))
      expect(keys).toHaveLength(2)
    })
  })

  // ─── Pattern 2: template literal whose slot is typed via a type alias ────────────────────────

  describe('template literal with declare const typed via a named type alias', () => {
    it('should resolve through the type alias and expand all union members', async () => {
      // The exact example from the issue:
      // type ChangeType = 'all' | 'next' | 'this';
      // declare const type: ChangeType;
      // t(`prefix_${type}`);
      const sampleCode = `
        type ChangeType = 'all' | 'next' | 'this';
        declare const type: ChangeType;
        t(\`prefix_\${type}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('prefix_all')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_next')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_this')
    })

    it('should handle a multi-segment template with a type-alias slot', async () => {
      const sampleCode = `
        type Status = 'active' | 'inactive';
        declare const status: Status;
        t(\`users.\${status}.label\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('users.active.label')
      expect(translationFile!.newTranslations).toHaveProperty('users.inactive.label')
    })
  })

  // ─── Pattern 3: t(helper()) where helper returns a finite literal union ──────────────────────

  describe('function call whose return type is a finite string-literal union', () => {
    it('should expand all return-type union members as keys', async () => {
      // The exact example from the issue:
      // function key(): 'goodMorning' | 'goodEvening' { ... }
      // t(key());
      const sampleCode = `
        function getGreetingKey(): 'goodMorning' | 'goodEvening' {
          return Math.random() > 0.5 ? 'goodMorning' : 'goodEvening';
        }
        t(getGreetingKey());
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('goodMorning')
      expect(translationFile!.newTranslations).toHaveProperty('goodEvening')
    })

    it('should work for an arrow function with an explicit union return type', async () => {
      const sampleCode = `
        const getStatusKey = (): 'open' | 'closed' | 'pending' => 'open';
        t(getStatusKey());
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('open')
      expect(translationFile!.newTranslations).toHaveProperty('closed')
      expect(translationFile!.newTranslations).toHaveProperty('pending')
    })

    it('should NOT produce keys when the return type is a plain string (unbounded)', async () => {
      // string (not a union of literals) cannot be enumerated — should produce no keys
      const sampleCode = `
        function getDynamic(): string {
          return 'anything';
        }
        t(getDynamic());
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // Either no file or an empty translations object — never a key from an unbounded type
      const keys = Object.keys(translationFile?.newTranslations ?? {})
      expect(keys).toHaveLength(0)
    })
  })

  // ─── Pattern 4: t(map[dynamicKey]) where map is as const and key is a known union ─────────────

  describe('as-const object map accessed with a dynamically-typed key', () => {
    it('should enumerate all reachable map values when the key is a known union', async () => {
      // The exact example from the issue:
      // const map = { all: 'allAccess', next: 'nextAccess' } as const;
      // declare const type: ChangeType;
      // t(map[type]);
      const sampleCode = `
        const map = { all: 'allAccess', next: 'nextAccess' } as const;
        declare const type: 'all' | 'next';
        t(map[type]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('allAccess')
      expect(translationFile!.newTranslations).toHaveProperty('nextAccess')
    })

    it('should enumerate all map values when the key cannot be statically narrowed', async () => {
      // When we cannot know which key will be used, fall back to all map values
      const sampleCode = `
        const statusMap = { active: 'status.active', inactive: 'status.inactive', pending: 'status.pending' } as const;
        t(statusMap[someExternalVar]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('status.active')
      expect(translationFile!.newTranslations).toHaveProperty('status.inactive')
      expect(translationFile!.newTranslations).toHaveProperty('status.pending')
    })

    it('should work with a type-alias key that covers a subset of the map', async () => {
      // Only the keys in the union should be looked up (not all map keys)
      const sampleCode = `
        type AllowedKey = 'foo' | 'bar';
        const labels = { foo: 'label.foo', bar: 'label.bar', baz: 'label.baz' } as const;
        declare const key: AllowedKey;
        t(labels[key]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('label.foo')
      expect(translationFile!.newTranslations).toHaveProperty('label.bar')
      // 'label.baz' is NOT in the AllowedKey union, so it should not be extracted
      expect(translationFile!.newTranslations).not.toHaveProperty('label.baz')
    })
  })

  // ─── Combined: the complete issue #210 example ───────────────────────────────────────────────

  describe('combined: full example from issue #210', () => {
    it('should extract all keys from all three patterns simultaneously', async () => {
      // Verbatim reproduction of the issue code block
      const sampleCode = `
        type ChangeType = 'all' | 'next' | 'this';
        const t = i18next.t;

        function key(): 'goodMorning' | 'goodEvening' {
          return Math.random() > 0.5 ? 'goodMorning' : 'goodEvening';
        }

        const map = { all: 'allAccess', next: 'nextAccess' } as const;
        declare const type: ChangeType;

        t(\`prefix_\${type}\`);
        t(key());
        t(map[type]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()

      // Pattern 1: template literal with type-alias slot
      expect(translationFile!.newTranslations).toHaveProperty('prefix_all')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_next')
      expect(translationFile!.newTranslations).toHaveProperty('prefix_this')

      // Pattern 2: function call with known return-type union
      expect(translationFile!.newTranslations).toHaveProperty('goodMorning')
      expect(translationFile!.newTranslations).toHaveProperty('goodEvening')

      // Pattern 3: as-const map access with typed key
      expect(translationFile!.newTranslations).toHaveProperty('allAccess')
      expect(translationFile!.newTranslations).toHaveProperty('nextAccess')
    })
  })
})
