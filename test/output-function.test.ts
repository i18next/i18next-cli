import { describe, it, expect } from 'vitest'
import { validateExtractorConfig } from '../src/utils/validation'
import { getOutputPath } from '../src/utils/file-utils'
import type { I18nextToolkitConfig } from '../src/types'
import { normalize } from 'node:path'

describe('extract.output as function / getOutputPath', () => {
  const baseConfig: I18nextToolkitConfig = {
    locales: ['en', 'de'],
    extract: {
      input: ['src/**/*.ts'],
      // placeholder string used for other tests; will be overridden below
      output: 'locales/{{language}}/{{namespace}}.json',
    },
  }

  it('validateExtractorConfig should accept a function for extract.output', () => {
    const cfg: I18nextToolkitConfig = {
      ...baseConfig,
      extract: {
        ...baseConfig.extract,
        // function does not contain template placeholders — should still be accepted
        output: (lng: string, ns?: string) => `packages/${ns ?? 'pkg'}/locales/${lng}/${ns ?? 'pkg'}.json`,
      },
    }

    expect(() => validateExtractorConfig(cfg)).not.toThrow()
  })

  it('getOutputPath should resolve string templates with namespace', () => {
    const out = getOutputPath('locales/{{language}}/{{namespace}}.json', 'en', 'common')
    expect(normalize(out)).toBe(normalize('locales/en/common.json'))
  })

  it('getOutputPath should remove namespace segment when namespace is undefined', () => {
    const out = getOutputPath('locales/{{language}}/{{namespace}}.json', 'en')
    expect(normalize(out)).toBe(normalize('locales/en.json'))
  })

  it('getOutputPath should call function outputs and return their result', () => {
    const fn = (lng: string, ns?: string) => `packages/${ns ?? 'shared'}/locales/${lng}/${ns ?? 'shared'}.json`
    const out = getOutputPath(fn, 'de', 'ui')
    expect(normalize(out)).toBe(normalize('packages/ui/locales/de/ui.json'))
  })

  it('getOutputPath should fallback to a sensible path if the function throws', () => {
    const badFn = () => { throw new Error('boom') }
    const out = getOutputPath(badFn as any, 'en')
    expect(normalize(out)).toBe(normalize('locales/en/translation.json'))
  })
})
