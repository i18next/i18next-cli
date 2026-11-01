import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runLinter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

async function lint (lines: string[], resources: Record<string, any> = {}, messageFormat: 'i18next' | 'icu' | 'mf2' = 'i18next') {
  const config: I18nextToolkitConfig = {
    locales: ['en'],
    extract: {
      input: ['src/**/*.tsx'],
      output: 'locales/{{language}}.json',
      messageFormat,
    },
    lint: { defaultVariables: ['appName', 'user'] },
  }
  vol.fromJSON({
    '/src/App.tsx': lines.join('\n'),
    '/locales/en.json': JSON.stringify(resources),
  })
  const result = await runLinter(config)
  return (result.files['/src/App.tsx'] ?? []).map(({ text, line }) => ({ text, line }))
}

describe('lint: checkInterpolationParams with lint.defaultVariables', () => {
  beforeEach(async () => {
    vol.reset()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('does not report a listed variable, still reports the others', async () => {
    const issues = await lint([
      't("Welcome to {{appName}}")',
      't("Welcome to {{appName}}, {{name}}", { name })',
      't("Welcome to {{appName}}, {{name}}")',
      't("{{appName}} by {{author.name}}")',
    ])

    expect(issues).toEqual([
      { text: 'Interpolation parameter "name" was not provided', line: 3 },
      { text: 'Interpolation parameter "author.name" was not provided', line: 4 },
    ])
  })

  it('counts a dotted placeholder as provided when its root is listed', async () => {
    const issues = await lint([
      't("Hi {{user.name}}, {{user.address.city}}")',
      't("Hi {{username}}")',
    ])

    expect(issues).toEqual([
      { text: 'Interpolation parameter "username" was not provided', line: 2 },
    ])
  })

  it('keeps the unused-parameter check as it is', async () => {
    const issues = await lint([
      't("Welcome to {{appName}}", { appName: "Override" })',
      't("Hello {{name}}", { name, appName })',
    ])

    expect(issues).toEqual([
      { text: 'Parameter "appName" is not used in translation string', line: 2 },
    ])
  })

  it('applies to selector calls and keys resolved from the translation files', async () => {
    const issues = await lint([
      'const { t } = useTranslation()',
      't($ => $.title)',
      't($ => $.title, { page })',
      't("title")',
    ], { title: '{{appName}}: {{page}}' })

    expect(issues).toEqual([
      { text: 'Interpolation parameter "page" was not provided', line: 2 },
      { text: 'Interpolation parameter "page" was not provided', line: 4 },
    ])
  })

  it('applies to ICU and MF2 arguments', async () => {
    expect(await lint([
      't("rows", "{appName}: {count, plural, one {# row} other {# rows}} of {total}", { count })',
    ], {}, 'icu')).toEqual([
      { text: 'Interpolation parameter "total" was not provided', line: 1 },
    ])

    vol.reset()
    expect(await lint([
      't("greeting")',
    ], { greeting: '{$appName} greets {$name}' }, 'mf2')).toEqual([
      { text: 'Interpolation parameter "name" was not provided', line: 1 },
    ])
  })
})
