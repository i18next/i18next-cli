/**
 * Regression test for https://github.com/i18next/i18next-cli/issues/179
 *
 * When a user project has React 18 and i18next-cli depends on React 19,
 * npm hoisting can cause `react-i18next` to resolve `react` to the user's
 * React 18, while jsx-parser.ts resolves to its own React 19 (or vice versa).
 *
 * React 18 elements use `Symbol.for('react.element')` as $$typeof,
 * while React 19 uses `Symbol.for('react.transitional.element')`.
 * When the symbols don't match, `isValidElement` returns false and
 * `nodesToString` treats real elements as plain objects — silently
 * dropping them from the serialised string.
 *
 * This test mocks `react` so that `createElement` produces elements
 * with the React 18 $$typeof symbol, simulating a version mismatch
 * while `react-i18next` (which depends on the real React 19 in this
 * environment) uses its own `isValidElement`.
 */
import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { nodesToString, getDefaults } from 'react-i18next'

// ---------------------------------------------------------------------------
// 1) Direct nodesToString test — proves the root cause without any mocking
// ---------------------------------------------------------------------------
describe('React 18/19 $$typeof mismatch (issue #179)', () => {
  it('nodesToString should recognise elements regardless of $$typeof symbol', () => {
    // In this dev environment react-i18next resolves to React 19, which
    // recognises only Symbol.for('react.transitional.element').
    // Elements stamped with React 18's Symbol.for('react.element') are
    // NOT recognised — this is the root cause of the bug.
    const react18Symbol = Symbol.for('react.element')
    const react19Symbol = Symbol.for('react.transitional.element')

    const makeEl = (sym: symbol) => ({
      $$typeof: sym,
      type: 'strong',
      props: { children: 'bold' },
      key: null,
      ref: null,
    })

    const opts = { ...getDefaults() }

    const saved = console.warn
    console.warn = () => {} // suppress react-i18next warnings during probe
    try {
      const result19 = nodesToString(['Hello ', makeEl(react19Symbol), ' world'] as any, opts)
      const result18 = nodesToString(['Hello ', makeEl(react18Symbol), ' world'] as any, opts)

      // React 19 symbol works (same version in this environment):
      expect(result19).toBe('Hello <strong>bold</strong> world')

      // React 18 symbol does NOT work — this documents the bug.
      // The element is treated as a plain object and silently dropped.
      // Once the fix is applied the extraction pipeline avoids this code
      // path entirely by detecting the correct symbol at load time.
      expect(result18).not.toBe('Hello <strong>bold</strong> world')
      // It produces broken output with the content dropped:
      expect(result18).toBe('Hello  world')
    } finally {
      console.warn = saved
    }
  })
})

// ---------------------------------------------------------------------------
// 2) Integration test — mocks React.createElement to simulate version mismatch
//    This makes jsx-parser.ts produce elements with the "wrong" $$typeof.
// ---------------------------------------------------------------------------

// We need to mock `react` BEFORE jsx-parser.ts is imported so its
// module-level `import * as React from 'react'` picks up the mock.
const REACT_18_SYMBOL = Symbol.for('react.element')

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    default: actual,
    // Patch createElement to stamp elements with the React 18 $$typeof —
    // simulating what happens when the user's React 18 is hoisted.
    createElement: (...args: Parameters<typeof actual.createElement>) => {
      const el = actual.createElement(...args)
      // React 19 elements are frozen, so we have to create a new object
      return Object.assign(Object.create(null), {
        ...el,
        $$typeof: REACT_18_SYMBOL,
      })
    },
    Fragment: actual.Fragment,
  }
})

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// Dynamic import so mocks are in place first
const { extract } = await import('../src/index')
const { pathEndsWith } = await import('./utils/path')

describe('extraction with React version mismatch (issue #179)', () => {
  const mockConfig: any = {
    locales: ['en', 'de'],
    extract: {
      input: ['src/**/*.{ts,tsx}'],
      output: 'locales/{{language}}/{{namespace}}.json',
      transComponents: ['Trans'],
      defaultNS: 'translation',
    },
  }

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should correctly serialize Trans children even when createElement produces elements with a mismatched $$typeof', async () => {
    // This is the exact code from the issue report
    const sampleCode = `
      import { Trans } from "react-i18next";

      function MyComponent({ name }) {
        const count = 5;

        return (
          <Trans i18nKey="userMessagesUnread">
            Hello{" "}
            <strong>
              <>{{ name }}</>
            </strong>
            , you have {{ count }} unread message.{" "}
            <Link href="/msgs">Go to messages</Link>.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find((r: any) => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const value = translationFile!.newTranslations.userMessagesUnread

    // With the fix: elements are built with the correct $$typeof so
    // nodesToString serialises them as indexed tags.
    expect(value).toContain('{{name}}')
    expect(value).toContain('{{count}}')
    expect(value).toMatch(/<\d+>Go to messages<\/\d+>/)

    // The broken output from the bug report — name is dropped entirely:
    expect(value).not.toBe('Hello , you have {{count}} unread message. .')
  })
})
