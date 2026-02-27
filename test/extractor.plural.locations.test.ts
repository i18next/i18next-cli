import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

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
    defaultNS: 'translation',
  },
}

describe('extractor: plural key location tracking (#201)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Assert that every key in the map whose name matches the predicate has a
   *  non-empty `locations` array pointing to the expected file. */
  function expectLocationsOnKeys (
    allKeys: Map<string, any>,
    keyPredicate: (k: string) => boolean,
    expectedFile: string
  ) {
    const matchedKeys = [...allKeys.entries()].filter(([k]) => keyPredicate(k))
    expect(matchedKeys.length).toBeGreaterThan(0) // sanity – we actually found some keys

    for (const [uniqueKey, ek] of matchedKeys) {
      expect(
        ek.locations,
        `Expected locations to be defined on plural key "${uniqueKey}"`
      ).toBeDefined()

      expect(
        Array.isArray(ek.locations),
        `Expected locations to be an array on plural key "${uniqueKey}"`
      ).toBe(true)

      expect(
        ek.locations.length,
        `Expected at least one location entry on plural key "${uniqueKey}"`
      ).toBeGreaterThan(0)

      expect(
        ek.locations[0].file,
        `Expected location file to be "${expectedFile}" on plural key "${uniqueKey}"`
      ).toBe(expectedFile)

      expect(
        typeof ek.locations[0].line,
        `Expected location line to be a number on plural key "${uniqueKey}"`
      ).toBe('number')

      expect(
        typeof ek.locations[0].column,
        `Expected location column to be a number on plural key "${uniqueKey}"`
      ).toBe('number')
    }
  }

  // ─── Cardinal plural keys ────────────────────────────────────────────────────

  it('should attach locations to expanded cardinal plural keys (count in options)', async () => {
    // This is the exact reproduction case from the bug report.
    // "I have {{count}} bananas" contains a count placeholder so the key is split
    // into _one / _other variants. Both must carry locations.
    const sampleCode = 't("I have {{count}} bananas", { count: 4 })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    // The key contains dots – extractor may store it flat or nested, so match loosely.
    expectLocationsOnKeys(
      allKeys,
      k => k.includes('I have') || k.includes('bananas'),
      '/src/App.tsx'
    )
  })

  it('should attach locations to _one and _other variants of a simple plural key', async () => {
    const sampleCode = 't(\'item.count\', { count: n })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('item.count') || k.includes('item_count') || k.includes('count_one') || k.includes('count_other'),
      '/src/App.tsx'
    )
  })

  it('should carry the correct line and column for a plural call', async () => {
    // Put the call on line 3, indented with 6 spaces so column is predictable.
    const sampleCode = [
      'const x = 1;',
      'const y = 2;',
      '      t(\'things\', { count: x })',
    ].join('\n')
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    const pluralKeys = [...allKeys.values()].filter(ek => ek.hasCount)
    expect(pluralKeys.length).toBeGreaterThan(0)

    for (const ek of pluralKeys) {
      expect(ek.locations).toBeDefined()
      expect(ek.locations![0].line).toBe(3)
      // Column should point to the opening quote of 'things' (after the 6-space indent + "t(")
      // i.e. column 8 (0-based)
      expect(ek.locations![0].column).toBe(8)
      expect(ek.locations![0].file).toBe('/src/App.tsx')
    }
  })

  it('should attach locations when plural key has an explicit defaultValue string', async () => {
    // Providing a plain string default (no {{count}}) means plural variants get the string as default.
    const sampleCode = 't(\'file\', \'One file\', { count: n })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('file'),
      '/src/App.tsx'
    )
  })

  it('should attach locations when defaultValue_one / defaultValue_other are supplied', async () => {
    const sampleCode = `
      t('message', {
        count: n,
        defaultValue_one: 'One message',
        defaultValue_other: '{{count}} messages',
      })
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('message'),
      '/src/App.tsx'
    )
  })

  // ─── Ordinal plural keys ─────────────────────────────────────────────────────

  it('should attach locations to expanded ordinal plural keys', async () => {
    const sampleCode = 't(\'position\', { count: n, ordinal: true })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('position'),
      '/src/App.tsx'
    )
  })

  // ─── Plural + context ────────────────────────────────────────────────────────

  it('should attach locations to context+plural combined keys', async () => {
    const sampleCode = 't(\'friend\', { count: n, context: \'male\' })'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('friend'),
      '/src/App.tsx'
    )
  })

  // ─── Multiple plural calls in one file ───────────────────────────────────────

  it('should attach correct individual locations when multiple plural calls appear in one file', async () => {
    const sampleCode = [
      't(\'apples\', { count: a })',
      't(\'oranges\', { count: b })',
    ].join('\n')
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const { allKeys } = await findKeys(mockConfig)

    const appleKeys = [...allKeys.entries()].filter(([k]) => k.includes('apple'))
    const orangeKeys = [...allKeys.entries()].filter(([k]) => k.includes('orange'))

    expect(appleKeys.length).toBeGreaterThan(0)
    expect(orangeKeys.length).toBeGreaterThan(0)

    // Apple keys should point to line 1
    for (const [, ek] of appleKeys) {
      expect(ek.locations).toBeDefined()
      expect(ek.locations![0].line).toBe(1)
    }

    // Orange keys should point to line 2
    for (const [, ek] of orangeKeys) {
      expect(ek.locations).toBeDefined()
      expect(ek.locations![0].line).toBe(2)
    }
  })

  // ─── Trans component ─────────────────────────────────────────────────────────

  it('should attach locations to Trans component plural keys (count prop)', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';
      <Trans i18nKey="msgCount" count={n}>
        You have {{n}} messages.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const configWithTrans: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        transComponents: ['Trans'],
      },
    }

    const { allKeys } = await findKeys(configWithTrans)

    expectLocationsOnKeys(
      allKeys,
      k => k.includes('msgCount'),
      '/src/App.tsx'
    )
  })
})
