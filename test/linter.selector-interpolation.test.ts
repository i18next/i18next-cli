import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: 'locales/{{language}}.json',
  },
  lint: {},
}

async function lint (lines: string[], resources: Record<string, any>) {
  vol.fromJSON({
    '/src/App.tsx': lines.join('\n'),
    '/locales/en.json': JSON.stringify(resources),
  })
  const result = await runLinter(config)
  return (result.files['/src/App.tsx'] ?? []).map(({ text, line }) => ({ text, line }))
}

describe('lint: checkInterpolationParams with the selector API', () => {
  beforeEach(async () => {
    vol.reset()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('reports a missing variable on the line of the call, not when it is passed', async () => {
    const issues = await lint([
      'import { useTranslation } from "react-i18next"',
      'function App() {',
      '  const { t } = useTranslation()',
      '  t($ => $.greeting)',
      '  t(($) => $.greeting, { name: "Ann" })',
      '  t($ => $.greeting, { nam: "Ann" })',
      '  t($ => $.greeting, opts)',
      '}',
    ], { greeting: 'Hello {{name}}' })

    expect(issues).toEqual([
      { text: 'Interpolation parameter "name" was not provided', line: 4 },
      { text: 'Interpolation parameter "name" was not provided', line: 6 },
      { text: 'Parameter "nam" is not used in translation string', line: 6 },
    ])
  })

  it('resolves a nested path against nested resources', async () => {
    const issues = await lint([
      'const { t } = useTranslation()',
      't($ => $.user.greeting, { author })',
      't($ => $.user.greeting, { name })',
    ], { user: { greeting: 'Hi {{author.name}}' } })

    expect(issues).toEqual([
      { text: 'Interpolation parameter "author.name" was not provided', line: 3 },
      { text: 'Parameter "name" is not used in translation string', line: 3 },
    ])
  })

  it('applies the keyPrefix of useTranslation and of the call options', async () => {
    const issues = await lint([
      'const { t } = useTranslation("translation", { keyPrefix: "profile" })',
      't($ => $.title)',
      't($ => $.title, { name })',
      'i18next.t($ => $.title, { keyPrefix: "profile" })',
      'i18next.t($ => $.title, { keyPrefix: "profile", name })',
    ], { title: 'No variables', profile: { title: 'Profile of {{name}}' } })

    expect(issues).toEqual([
      { text: 'Interpolation parameter "name" was not provided', line: 2 },
      { text: 'Interpolation parameter "name" was not provided', line: 4 },
    ])
  })
})
