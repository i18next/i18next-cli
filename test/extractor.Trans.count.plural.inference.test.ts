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
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

// react-i18next v16.4.0 introduced runtime inference of `count` from inline
// `{{ count }}` children (without a `count` prop).  The extractor should
// mirror that logic so that extracted keys are plural forms, not a plain
// singular key.
describe('extractor: Trans inline count inference', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // -------------------------------------------------------------------------
  // 1. Most basic case from the issue report
  // -------------------------------------------------------------------------

  it('should generate plural keys when count is inlined without a count prop (natural-language key)', async () => {
    // Exactly the example in the bug report.
    // Runtime renders this correctly since v16.4.0; the extractor must follow.
    const sampleCode = '<div><Trans>I have {{count: 5}} bananas</Trans></div>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // The extractor does not auto-singularize text — it uses the serialized
    // children as the defaultValue for every plural category.  A translator
    // is expected to supply the correct singular form for the _one key.
    expect(translationFile!.newTranslations).toEqual({
      'I have {{count}} bananas_one': 'I have {{count}} bananas',
      'I have {{count}} bananas_other': 'I have {{count}} bananas',
    })
  })

  // -------------------------------------------------------------------------
  // 2. Same scenario but with an explicit i18nKey
  // -------------------------------------------------------------------------

  it('should generate plural keys when count is inlined and i18nKey is provided', async () => {
    const sampleCode = `
      <Trans i18nKey="fruitCount">
        I have {{count: qty}} bananas
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      fruitCount_one: 'I have {{count}} bananas',
      fruitCount_other: 'I have {{count}} bananas',
    })
  })

  // -------------------------------------------------------------------------
  // 3. Inline count alongside other interpolations (the original bug trigger)
  // -------------------------------------------------------------------------

  it('should generate plural keys and preserve other interpolations when count is inlined', async () => {
    // Mirrors the exact failing case from the issue: {{ count }} and {{ stuff }}
    // both inlined, no count prop.
    const sampleCode = `
      <Trans i18nKey="transTest">
        <strong>{{count}} and {{stuff}}</strong>
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      transTest_one: '<strong>{{count}} and {{stuff}}</strong>',
      transTest_other: '<strong>{{count}} and {{stuff}}</strong>',
    })
  })

  // -------------------------------------------------------------------------
  // 4. Deeply nested inline count (mirrors react-i18next's recursive walk)
  // -------------------------------------------------------------------------

  it('should infer count when {{ count }} is deeply nested inside child elements', async () => {
    // getValuesFromChildren() in react-i18next recurses arbitrarily deep.
    // The extractor must do the same so the extraction result matches runtime.
    const sampleCode = `
      <Trans i18nKey="deepCount">
        You have <strong><em>{{count}} item</em></strong>.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      deepCount_one: 'You have <strong><0>{{count}} item</0></strong>.',
      deepCount_other: 'You have <strong><0>{{count}} item</0></strong>.',
    })
  })

  // -------------------------------------------------------------------------
  // 5. Full example from the react-i18next v16.4.0 test suite
  // -------------------------------------------------------------------------

  it('should generate plural keys for the canonical v16.4.0 example (name + count, no count prop)', async () => {
    // This mirrors the test added in react-i18next's own test suite for the fix.
    const sampleCode = `
      <Trans i18nKey="transTest2">
        Hello <strong>{{name}}</strong>, you have {{count}} message. Open <Link to="/msgs">here</Link>.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    const expectedValue = 'Hello <strong>{{name}}</strong>, you have {{count}} message. Open <5>here</5>.'
    expect(translationFile!.newTranslations).toEqual({
      transTest2_one: expectedValue,
      transTest2_other: expectedValue,
    })
  })

  // -------------------------------------------------------------------------
  // 6. Explicit count prop must still take precedence over inferred count
  // -------------------------------------------------------------------------

  it('should still generate plural keys when an explicit count prop is present (regression guard)', async () => {
    // Existing behaviour must not regress: explicit prop continues to work.
    const sampleCode = `
      <Trans i18nKey="explicit" count={messages.length}>
        You have {{count: messages.length}} unread messages.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      explicit_one: 'You have {{count}} unread messages.',
      explicit_other: 'You have {{count}} unread messages.',
    })
  })

  // -------------------------------------------------------------------------
  // 7. count={0} explicit prop must not be overridden (falsy-value edge case)
  // -------------------------------------------------------------------------

  it('should respect an explicit count={0} prop and generate plural keys', async () => {
    // react-i18next checks `count === undefined` before inferring, so a literal
    // 0 passed as prop must still produce plural keys and not be treated as
    // "no count provided".
    const sampleCode = `
      <Trans i18nKey="zeroCount" count={0}>
        You have {{count: 0}} items.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      zeroCount_one: 'You have {{count}} items.',
      zeroCount_other: 'You have {{count}} items.',
    })
  })

  // -------------------------------------------------------------------------
  // 8. No count anywhere → plain singular key, no plural forms
  // -------------------------------------------------------------------------

  it('should NOT generate plural keys when there is no count prop and no {{ count }} in children', async () => {
    const sampleCode = `
      <Trans i18nKey="noCount">
        Hello <strong>{{name}}</strong>, welcome back.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      noCount: 'Hello <strong>{{name}}</strong>, welcome back.',
    })
    // Explicitly assert no spurious plural keys were generated
    expect(Object.keys(translationFile!.newTranslations)).not.toContain('noCount_one')
    expect(Object.keys(translationFile!.newTranslations)).not.toContain('noCount_other')
  })

  // -------------------------------------------------------------------------
  // 9. Trans without children (key-only) still requires explicit count prop
  // -------------------------------------------------------------------------

  it('should NOT generate plural keys for key-only Trans without an explicit count prop', async () => {
    // There are no children to infer from, so no plural keys should be produced.
    // This documents the boundary: inference is children-only.
    const sampleCode = '<Trans i18nKey="keyOnly" />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      keyOnly: 'keyOnly',
    })
    expect(Object.keys(translationFile!.newTranslations)).not.toContain('keyOnly_one')
    expect(Object.keys(translationFile!.newTranslations)).not.toContain('keyOnly_other')
  })

  it('should generate plural keys for key-only Trans when an explicit count prop IS provided', async () => {
    // Counterpart to the test above: explicit prop on childless Trans must work.
    const sampleCode = '<Trans i18nKey="keyOnlyWithCount" count={n} />'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      keyOnlyWithCount_one: 'keyOnlyWithCount',
      keyOnlyWithCount_other: 'keyOnlyWithCount',
    })
  })

  // -------------------------------------------------------------------------
  // 10. Inline count combined with context prop
  // -------------------------------------------------------------------------

  it('should generate context + plural keys when count is inlined and context prop is present', async () => {
    const sampleCode = `
      <Trans i18nKey="ctxCount" context="apple">
        I have {{count}} apples
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // When context and count are both present the extractor generates:
    //   - base plural forms (ctxCount_one / ctxCount_other) via generateBasePluralForms
    //   - context + plural combinations (ctxCount_apple_one / ctxCount_apple_other)
    // This matches the existing explicit-count behaviour in jsx-handler.ts.
    expect(translationFile!.newTranslations).toEqual({
      ctxCount_one: 'I have {{count}} apples',
      ctxCount_other: 'I have {{count}} apples',
      ctxCount_apple_one: 'I have {{count}} apples',
      ctxCount_apple_other: 'I have {{count}} apples',
    })
  })

  // -------------------------------------------------------------------------
  // 11. TypeScript type-assertion form of inline count
  // -------------------------------------------------------------------------

  it('should infer count from inline {{ count } as any} TypeScript type-assertion syntax', async () => {
    // TypeScript users often need `{{ count } as any}` or `{{ count } as TransInterpolation}`
    // to satisfy the compiler. The extractor must still recognise count here.
    const sampleCode = `
      <Trans i18nKey="tsCount">
        You have <strong>{{ count } as any}</strong> unread messages.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      tsCount_one: 'You have <strong>{{count}}</strong> unread messages.',
      tsCount_other: 'You have <strong>{{count}}</strong> unread messages.',
    })
  })

  // -------------------------------------------------------------------------
  // 12. Aliased count key (e.g. {{ count: items.length }}) — name is what matters
  // -------------------------------------------------------------------------

  it('should infer count when it is aliased from a longer expression ({{ count: items.length }})', async () => {
    // The interpolation key is "count" regardless of the RHS expression.
    // This is the most common real-world usage (count is rarely a bare variable).
    const sampleCode = `
      <Trans i18nKey="aliasedCount">
        Cart has {{count: items.length}} items
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      aliasedCount_one: 'Cart has {{count}} items',
      aliasedCount_other: 'Cart has {{count}} items',
    })
  })
})
