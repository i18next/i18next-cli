// Create new file: test/validation.test.ts

import { describe, it, expect } from 'vitest'
import { validateExtractorConfig, ExtractorError } from '../src/utils/validation'
import type { I18nextToolkitConfig } from '../src/types'

// A minimal valid config to use as a base
const baseConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.ts'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
}

describe('validation: validateExtractorConfig', () => {
  it('should not throw for a valid configuration', () => {
    // Assert that the function does NOT throw when the config is valid
    expect(() => validateExtractorConfig(baseConfig)).not.toThrow()
  })

  it('should throw an ExtractorError if extract.input is missing', () => {
    const invalidConfig = { ...baseConfig, extract: { ...baseConfig.extract, input: [] } }
    // Assert that the function throws the specific error we expect
    expect(() => validateExtractorConfig(invalidConfig)).toThrow(ExtractorError)
    expect(() => validateExtractorConfig(invalidConfig)).toThrow('extract.input must be specified')
  })

  it('should throw an ExtractorError if extract.output is missing', () => {
    const invalidConfig = { ...baseConfig, extract: { ...baseConfig.extract, output: '' } }
    expect(() => validateExtractorConfig(invalidConfig)).toThrow(ExtractorError)
    expect(() => validateExtractorConfig(invalidConfig)).toThrow('extract.output must be specified')
  })

  it('should throw an ExtractorError if locales array is empty', () => {
    const invalidConfig = { ...baseConfig, locales: [] }
    expect(() => validateExtractorConfig(invalidConfig)).toThrow(ExtractorError)
    expect(() => validateExtractorConfig(invalidConfig)).toThrow('locales must be specified')
  })

  it('should throw an ExtractorError if output path is missing {{language}} placeholder', () => {
    const invalidConfig = { ...baseConfig, extract: { ...baseConfig.extract, output: 'locales/namespace.json' } }
    expect(() => validateExtractorConfig(invalidConfig)).toThrow(ExtractorError)
    expect(() => validateExtractorConfig(invalidConfig)).toThrow('must contain {{language}} placeholder')
  })
})
