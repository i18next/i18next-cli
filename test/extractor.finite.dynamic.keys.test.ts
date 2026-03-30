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

  // ─── Pattern 5: enum as type annotation ──────────────────────────────────────

  describe('TypeScript enum used as type annotation for a variable', () => {
    it('should expand all string-valued enum members for declare const typed as an enum', async () => {
      // enum Direction { Up = 'up', Down = 'down' }
      // declare const dir: Direction;
      // t(`move.${dir}`)  →  move.up, move.down
      const sampleCode = `
        enum Direction {
          Up = 'up',
          Down = 'down',
          Left = 'left',
          Right = 'right',
        }
        declare const dir: Direction;
        t(\`move.\${dir}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('move.up')
      expect(translationFile!.newTranslations).toHaveProperty('move.down')
      expect(translationFile!.newTranslations).toHaveProperty('move.left')
      expect(translationFile!.newTranslations).toHaveProperty('move.right')
    })

    it('should expand enum values when used as a direct t() argument', async () => {
      const sampleCode = `
        enum Status {
          Active = 'status.active',
          Inactive = 'status.inactive',
        }
        declare const s: Status;
        t(s);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('status.active')
      expect(translationFile!.newTranslations).toHaveProperty('status.inactive')
    })

    it('should expand all enum values when variable has both type annotation and initializer', async () => {
      // Regression: `const status: Status = Status.New` should extract all enum values,
      // not just the single initializer value.
      const sampleCode = `
        enum Status {
          New = 'new',
          Active = 'active',
          Done = 'done',
        }
        const status: Status = Status.New;
        t(\`ms.status.\${status}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('ms.status.new')
      expect(translationFile!.newTranslations).toHaveProperty('ms.status.active')
      expect(translationFile!.newTranslations).toHaveProperty('ms.status.done')
    })

    it('should NOT produce keys for numeric enums (only string-valued enums are finite keys)', async () => {
      const sampleCode = `
        enum Count { One = 1, Two = 2 }
        declare const c: Count;
        t(\`num.\${c}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      // Numeric enums produce no extractable string keys
      const keys = Object.keys(results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))?.newTranslations ?? {})
      expect(keys).toHaveLength(0)
    })
  })

  // ─── Pattern 6: keyof typeof MAP ─────────────────────────────────────────────

  describe('keyof typeof MAP as type annotation for a key variable', () => {
    it('should expand all map keys when a variable is typed as keyof typeof MAP', async () => {
      // const LABELS = { save: 'actions.save', cancel: 'actions.cancel' } as const;
      // declare const k: keyof typeof LABELS;
      // t(LABELS[k])  →  actions.save, actions.cancel
      const sampleCode = `
        const LABELS = {
          save: 'actions.save',
          cancel: 'actions.cancel',
          delete: 'actions.delete',
        } as const;
        declare const k: keyof typeof LABELS;
        t(LABELS[k]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('actions.save')
      expect(translationFile!.newTranslations).toHaveProperty('actions.cancel')
      expect(translationFile!.newTranslations).toHaveProperty('actions.delete')
    })

    it('should use keyof typeof to restrict which map values are extracted', async () => {
      // Only the keys present in the keyof union should produce values
      const sampleCode = `
        const ICONS = { info: 'icon.info', warn: 'icon.warn', error: 'icon.error' } as const;
        type VisibleIcon = keyof typeof ICONS;
        declare const icon: VisibleIcon;
        t(ICONS[icon]);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('icon.info')
      expect(translationFile!.newTranslations).toHaveProperty('icon.warn')
      expect(translationFile!.newTranslations).toHaveProperty('icon.error')
    })
  })

  // ─── Pattern 7: Object.keys / Object.values iteration ─────────────────────

  describe('Object.keys(MAP) and Object.values(MAP) iteration callbacks', () => {
    it('should expand all map values when Object.keys is used to iterate and key is used to index', async () => {
      // Object.keys(MAP).forEach(k => t(MAP[k]))  →  all MAP values
      const sampleCode = `
        const SECTION_KEYS = {
          intro: 'page.intro',
          body: 'page.body',
          footer: 'page.footer',
        } as const;
        Object.keys(SECTION_KEYS).forEach((k) => {
          t(SECTION_KEYS[k]);
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('page.intro')
      expect(translationFile!.newTranslations).toHaveProperty('page.body')
      expect(translationFile!.newTranslations).toHaveProperty('page.footer')
    })

    it('should expand all map values when Object.values is iterated directly in t()', async () => {
      // Object.values(MAP).map(v => t(v))  →  all MAP values
      const sampleCode = `
        const MESSAGES = {
          welcome: 'msg.welcome',
          bye: 'msg.bye',
        } as const;
        Object.values(MESSAGES).map((msg) => t(msg));
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('msg.welcome')
      expect(translationFile!.newTranslations).toHaveProperty('msg.bye')
    })

    it('should work with Object.keys in a .map() returning a JSX-like element', async () => {
      const sampleCode = `
        const TABS = { overview: 'tabs.overview', billing: 'tabs.billing' } as const;
        Object.keys(TABS).map((key) => ({ label: t(TABS[key]) }));
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('tabs.overview')
      expect(translationFile!.newTranslations).toHaveProperty('tabs.billing')
    })
  })
})
