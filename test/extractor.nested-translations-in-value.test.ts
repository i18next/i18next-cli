import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

// Covers i18next-cli issue #241:
// When a translation value uses `$t(...)` nesting to reference other keys,
// those referenced keys (and their plural / context variants) must be
// preserved during extraction even though they are never mentioned in source
// code. They must also be expanded into the correct per-locale plural forms
// so secondary languages get the right skeleton on first extract.
describe('extractor: nested $t() references inside translation values', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) return ['/src/App.tsx']
      if (typeof pattern === 'string' && pattern.startsWith('src/')) return ['/src/App.tsx']
      return []
    })
  })

  it('preserves plural variants that are only referenced via $t() in translation values', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        return <div>{t('girlsAndBoys', { girls: 3, boys: 2 })}</div>;
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const existingTranslations = {
      girlsAndBoys: 'They have $t(girls, {"count": {{girls}} }) and $t(boys, {"count": {{boys}} })',
      boys_one: '{{count}} boy',
      boys_other: '{{count}} boys',
      girls_one: '{{count}} girl',
      girls_other: '{{count}} girls'
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
      }
    }

    const [result] = await extract(config)

    expect(result.newTranslations.girlsAndBoys).toBe(existingTranslations.girlsAndBoys)
    expect(result.newTranslations.boys_one).toBe('{{count}} boy')
    expect(result.newTranslations.boys_other).toBe('{{count}} boys')
    expect(result.newTranslations.girls_one).toBe('{{count}} girl')
    expect(result.newTranslations.girls_other).toBe('{{count}} girls')
  })

  it('generates missing plural forms for secondary locales when a nested reference uses count', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        return <div>{t('girlsAndBoys')}</div>;
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    // Primary language already has the nested keys. Secondary (pl) has none
    // yet — extract should create the correct CLDR skeleton for pl.
    const existingEn = {
      girlsAndBoys: 'They have $t(girls, {"count": {{girls}} }) and $t(boys, {"count": {{boys}} })',
      boys_one: '{{count}} boy',
      boys_other: '{{count}} boys',
      girls_one: '{{count}} girl',
      girls_other: '{{count}} girls'
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/pl'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(existingEn, null, 2)
    )
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/pl/translation.json'),
      JSON.stringify({}, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
      }
    }

    const results = await extract(config)
    const pl = results.find(r => r.locale === 'pl')!.newTranslations

    // Polish cardinal plural categories: one, few, many, other
    expect(pl.boys_one).toBeDefined()
    expect(pl.boys_few).toBeDefined()
    expect(pl.boys_many).toBeDefined()
    expect(pl.boys_other).toBeDefined()
    expect(pl.girls_one).toBeDefined()
    expect(pl.girls_few).toBeDefined()
    expect(pl.girls_many).toBeDefined()
    expect(pl.girls_other).toBeDefined()
  })

  it('preserves context + plural variants referenced via $t() with context and count', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        return <div>{t('graph.statistics.maxReached', { times: 3, days: 5 })}</div>;
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const existingTranslations = {
      graph: {
        statistics: {
          maxReached: '$t(graph.statistics.maxReached, { "context": "times", "count": {{times}} }) $t(graph.statistics.maxReached, { "context": "days", "count": {{days}} })',
          maxReached_times_one: 'Max reached {{count}} time',
          maxReached_times_other: 'Max reached {{count}} times',
          maxReached_days_one: 'over the last day',
          maxReached_days_other: 'over the past {{count}} days'
        }
      }
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(existingTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
      }
    }

    const [result] = await extract(config)
    const stats = result.newTranslations.graph.statistics

    expect(stats.maxReached_times_one).toBe('Max reached {{count}} time')
    expect(stats.maxReached_times_other).toBe('Max reached {{count}} times')
    expect(stats.maxReached_days_one).toBe('over the last day')
    expect(stats.maxReached_days_other).toBe('over the past {{count}} days')
  })

  it('preserves context-only nested references', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        return <div>{t('greeting_wrapper')}</div>;
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const existingTranslations = {
      greeting_wrapper: 'Hello: $t(greeting, { "context": "formal" })',
      greeting: 'Hi there',
      greeting_formal: 'Good day'
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(existingTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
      }
    }

    const [result] = await extract(config)

    // The plain referenced key and the referenced context variant are kept.
    expect(result.newTranslations.greeting).toBe('Hi there')
    expect(result.newTranslations.greeting_formal).toBe('Good day')
  })

  it('follows transitive $t() references through chained values', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        return <div>{t('outer')}</div>;
      }
    `

    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const existingTranslations = {
      outer: 'Start $t(middle)',
      middle: 'Chain $t(inner, {"count": 2})',
      inner_one: '{{count}} thing',
      inner_other: '{{count}} things'
    }

    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(
      resolve(process.cwd(), 'locales/en/translation.json'),
      JSON.stringify(existingTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true
      }
    }

    const [result] = await extract(config)

    expect(result.newTranslations.middle).toBe('Chain $t(inner, {"count": 2})')
    expect(result.newTranslations.inner_one).toBe('{{count}} thing')
    expect(result.newTranslations.inner_other).toBe('{{count}} things')
  })
})
