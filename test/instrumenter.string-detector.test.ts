import { describe, it, expect } from 'vitest'
import { detectCandidate } from '../src/instrumenter/core/string-detector'
import type { I18nextToolkitConfig } from '../src/types'

const mockConfig: Omit<I18nextToolkitConfig, 'plugins'> = {
  locales: ['en', 'de'],
  extract: {
    input: 'src/**/*.{ts,tsx,js,jsx}',
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans']
  }
}

describe('string-detector', () => {
  describe('detectCandidate', () => {
    it('detects user-facing strings with high confidence', () => {
      const code = 'const msg = "Welcome back to our app"'
      const result = detectCandidate('Welcome back to our app', 16, 40, 'test.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThan(0.7)
    })

    it('skips test files', () => {
      const code = 'const msg = "Welcome"'
      const result = detectCandidate('Welcome', 12, 21, 'test.test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips empty strings', () => {
      const code = 'const msg = ""'
      const result = detectCandidate('', 12, 12, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips single characters', () => {
      const code = 'const char = "x"'
      const result = detectCandidate('x', 14, 15, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips pure numbers', () => {
      const code = 'const num = "123"'
      const result = detectCandidate('123', 13, 16, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips URL-like strings', () => {
      const code = 'const url = "https://example.com"'
      const result = detectCandidate('https://example.com', 12, 32, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips error codes (all-caps with underscores)', () => {
      const code = 'const code = "ERROR_NOT_FOUND"'
      const result = detectCandidate('ERROR_NOT_FOUND', 14, 29, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('skips console.log arguments', () => {
      const code = 'console.log("Debug message")'
      const result = detectCandidate('Debug message', 13, 26, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })

    it('returns candidate for plain English sentence', () => {
      const code = 'const greeting = "Hello, welcome back!"'
      const result = detectCandidate('Hello, welcome back!', 17, 40, 'test.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThan(0.7)
    })

    it('returns candidate for action buttons', () => {
      const code = 'const label = "Click to continue"'
      const result = detectCandidate('Click to continue', 14, 31, 'test.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThan(0.7)
    })

    it('does not skip sentences containing periods', () => {
      const code = 'const msg = "Something went wrong. Please try again."'
      const result = detectCandidate('Something went wrong. Please try again.', 12, 52, 'test.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThan(0.7)
    })

    it('still skips real import paths with dots', () => {
      const code = 'import x from "lodash.get"'
      const result = detectCandidate('lodash.get', 15, 25, 'test.ts', code, mockConfig)
      expect(result).toBeNull()
    })
  })

  describe('custom scorer (instrumentScorer)', () => {
    it('overrides confidence score when scorer returns a number', () => {
      const configWithScorer = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          instrumentScorer: () => 0.95
        }
      }
      // "hi there" passes shouldSkip but would normally get moderate confidence
      const code = 'const msg = "hi there"'
      const result = detectCandidate('hi there', 13, 21, 'test.ts', code, configWithScorer)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBe(0.95)
    })

    it('skips candidate when scorer returns null', () => {
      const configWithScorer = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          instrumentScorer: () => null
        }
      }
      const code = 'const msg = "Welcome back to our app"'
      const result = detectCandidate('Welcome back to our app', 16, 40, 'test.ts', code, configWithScorer)
      expect(result).toBeNull()
    })

    it('falls back to built-in heuristic when scorer returns undefined', () => {
      const configWithScorer = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          instrumentScorer: () => undefined
        }
      }
      const code = 'const msg = "Welcome back to our app"'
      const result = detectCandidate('Welcome back to our app', 16, 40, 'test.ts', code, configWithScorer)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThan(0.7) // built-in heuristic
    })

    it('provides correct context to the scorer function', () => {
      let receivedContent: string | undefined
      let receivedContext: any
      const configWithScorer = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          instrumentScorer: (content: string, context: any) => {
            receivedContent = content
            receivedContext = context
            return undefined // fall back
          }
        }
      }
      const code = 'const msg = "Hello world"'
      detectCandidate('Hello world', 13, 24, 'src/app.ts', code, configWithScorer)
      expect(receivedContent).toBe('Hello world')
      expect(receivedContext.file).toBe('src/app.ts')
      expect(receivedContext.offset).toBe(13)
      expect(receivedContext.code).toBe(code)
      expect(typeof receivedContext.beforeContext).toBe('string')
      expect(typeof receivedContext.afterContext).toBe('string')
    })

    it('clamps custom score to [0, 1]', () => {
      const configWithScorer = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          instrumentScorer: () => 5.0 // way above 1
        }
      }
      const code = 'const msg = "Hello world"'
      const result = detectCandidate('Hello world', 13, 24, 'test.ts', code, configWithScorer)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBe(1)
    })

    it('allows description JSX attribute through as translatable', () => {
      const code = '<Toggle description="Get reminded when tasks are due within 24 hours" />'
      const offset = code.indexOf('Get')
      const endOffset = code.indexOf('24 hours') + '24 hours'.length
      const result = detectCandidate('Get reminded when tasks are due within 24 hours', offset, endOffset, 'src/app.tsx', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThanOrEqual(0.7)
    })

    it('boosts confidence for strings assigned to translatable object properties', () => {
      const code = "const opts = [{ key: 'all', label: 'All' }]"
      const offset = code.indexOf("'All'")
      const endOffset = offset + 5
      const result = detectCandidate('All', offset, endOffset, 'src/app.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThanOrEqual(0.7)
    })

    it('boosts confidence for description property in objects', () => {
      const code = "const item = { description: 'A weekly overview of productivity' }"
      const offset = code.indexOf("'A weekly")
      const endOffset = offset + 'A weekly overview of productivity'.length + 2
      const result = detectCandidate('A weekly overview of productivity', offset, endOffset, 'src/app.ts', code, mockConfig)
      expect(result).toBeTruthy()
      expect(result?.confidence).toBeGreaterThanOrEqual(0.7)
    })
  })
})
