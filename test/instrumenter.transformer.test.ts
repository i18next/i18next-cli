import { describe, it, expect } from 'vitest'
import { transformFile, generateDiff } from '../src/instrumenter/core/transformer'
import type { CandidateString, I18nextToolkitConfig, ComponentBoundary } from '../src/types'

const mockConfig: Omit<I18nextToolkitConfig, 'plugins'> = {
  locales: ['en', 'de'],
  extract: {
    input: 'src/**/*.{ts,tsx,js,jsx}',
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans']
  }
}

describe('transformer', () => {
  describe('transformFile', () => {
    it('transforms string literal with t() call', () => {
      const content = 'const msg = "Welcome back"'
      const candidate: CandidateString = {
        content: 'Welcome back',
        confidence: 0.8,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'test.ts',
        line: 1,
        column: 13,
        key: 'welcomeBack'
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.modified).toBe(true)
      expect(result.transformCount).toBe(1)
      expect(result.newContent).toContain('t(')
    })

    it('handles multiple candidates', () => {
      const content = 'const msg1 = "Welcome"; const msg2 = "Goodbye"'
      const candidates: CandidateString[] = [
        {
          content: 'Welcome',
          confidence: 0.8,
          offset: 13,
          endOffset: 20,
          type: 'string-literal',
          file: 'test.ts',
          line: 1,
          column: 13,
          key: 'welcome'
        },
        {
          content: 'Goodbye',
          confidence: 0.8,
          offset: 36,
          endOffset: 43,
          type: 'string-literal',
          file: 'test.ts',
          line: 1,
          column: 36,
          key: 'goodbye'
        }
      ]

      const result = transformFile(content, 'test.ts', candidates, {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.transformCount).toBe(2)
    })

    it('respects dry-run mode', () => {
      const content = 'const msg = "Welcome back"'
      const candidate: CandidateString = {
        content: 'Welcome back',
        confidence: 0.8,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'test.ts',
        line: 1,
        column: 13,
        key: 'welcomeBack'
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: true,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.modified).toBe(true)
      expect(result.newContent).toBeUndefined()
      expect(result.diff).toBeTruthy()
    })

    it('generates diff correctly', () => {
      const original = 'const msg = "Welcome"'
      const modified = 'const msg = t(\'welcome\', \'Welcome\')'

      const diff = generateDiff(original, modified, 'test.ts')

      expect(diff).toContain('--- a/test.ts')
      expect(diff).toContain('+++ b/test.ts')
      expect(diff).toContain('-const msg = "Welcome"')
      expect(diff).toContain("+const msg = t('welcome', 'Welcome')")
    })

    it('adds import statement when using React', () => {
      const content = 'const msg = "Welcome"'
      const candidate: CandidateString = {
        content: 'Welcome',
        confidence: 0.8,
        offset: 13,
        endOffset: 20,
        type: 'string-literal',
        file: 'test.tsx',
        line: 1,
        column: 13,
        key: 'welcome'
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.injections.importAdded).toBe(true)
      // Without insideComponent set, should use i18next.t() and add i18next import
      expect(result.newContent).toContain('i18next')
    })

    it('injects useTranslation hook into React components', () => {
      const content = 'import React from \'react\'\n\nexport function Greeting () {\n  const msg = "Welcome"\n  return <div>{msg}</div>\n}\n'
      const components: ComponentBoundary[] = [{
        name: 'Greeting',
        bodyStart: 43,
        bodyEnd: content.length - 2,
        hasUseTranslation: false
      }]
      const candidate: CandidateString = {
        content: 'Welcome',
        confidence: 0.8,
        offset: 60,
        endOffset: 67,
        type: 'string-literal',
        file: 'test.tsx',
        line: 4,
        column: 16,
        key: 'welcome',
        insideComponent: 'Greeting'
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components
      })

      expect(result.injections.hookInjected).toBe(true)
      expect(result.newContent).toContain('const { t } = useTranslation()')
      expect(result.newContent).toContain("import { useTranslation } from 'react-i18next'")
      expect(result.newContent).not.toContain('TODO')
    })

    it('skips low-confidence candidates', () => {
      const content = 'const msg = "type"'
      const candidate: CandidateString = {
        content: 'type',
        confidence: 0.3, // Low confidence
        offset: 13,
        endOffset: 17,
        type: 'string-literal',
        file: 'test.ts',
        line: 1,
        column: 13
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.transformCount).toBe(0)
      expect(result.modified).toBe(false)
    })

    it('transforms template literal candidates the same as string literals', () => {
      const content = 'const msg = `Welcome back`'
      const candidate: CandidateString = {
        content: 'Welcome back',
        confidence: 0.8,
        offset: 12,
        endOffset: 26,
        type: 'template-literal',
        file: 'test.ts',
        line: 1,
        column: 12,
        key: 'welcomeBack'
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.modified).toBe(true)
      expect(result.transformCount).toBe(1)
      expect(result.newContent).toContain("i18next.t('welcomeBack', 'Welcome back')")
      expect(result.newContent).not.toContain('`')
    })

    it('adds namespace to useTranslation when non-default namespace is specified', () => {
      const content = 'import React from \'react\'\n\nexport function Greeting () {\n  const msg = "Welcome"\n  return <div>{msg}</div>\n}\n'
      const components: ComponentBoundary[] = [{
        name: 'Greeting',
        bodyStart: 43,
        bodyEnd: content.length - 2,
        hasUseTranslation: false
      }]
      const candidate: CandidateString = {
        content: 'Welcome',
        confidence: 0.8,
        offset: 60,
        endOffset: 67,
        type: 'string-literal',
        file: 'test.tsx',
        line: 4,
        column: 16,
        key: 'welcome',
        insideComponent: 'Greeting'
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        namespace: 'common'
      })

      expect(result.injections.hookInjected).toBe(true)
      expect(result.newContent).toContain("const { t } = useTranslation('common')")
      expect(result.newContent).toContain("import { useTranslation } from 'react-i18next'")
    })

    it('does not add namespace to useTranslation when namespace matches defaultNS', () => {
      const content = 'import React from \'react\'\n\nexport function Greeting () {\n  const msg = "Welcome"\n  return <div>{msg}</div>\n}\n'
      const components: ComponentBoundary[] = [{
        name: 'Greeting',
        bodyStart: 43,
        bodyEnd: content.length - 2,
        hasUseTranslation: false
      }]
      const candidate: CandidateString = {
        content: 'Welcome',
        confidence: 0.8,
        offset: 60,
        endOffset: 67,
        type: 'string-literal',
        file: 'test.tsx',
        line: 4,
        column: 16,
        key: 'welcome',
        insideComponent: 'Greeting'
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        namespace: 'translation' // same as default
      })

      expect(result.newContent).toContain('const { t } = useTranslation()')
      expect(result.newContent).not.toContain("useTranslation('translation')")
    })

    it('adds ns option to i18next.t() calls for non-default namespace without React', () => {
      const content = 'const msg = "Welcome back"'
      const candidate: CandidateString = {
        content: 'Welcome back',
        confidence: 0.8,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'test.ts',
        line: 1,
        column: 13,
        key: 'welcomeBack'
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        namespace: 'common'
      })

      expect(result.newContent).toContain("i18next.t('welcomeBack', 'Welcome back', { ns: 'common' })")
    })

    it('includes interpolation variables in the options argument', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = 'const msg = `${days}-day streak`'
      const candidate: CandidateString = {
        content: '{{days}}-day streak',
        confidence: 0.8,
        offset: 12,
        endOffset: 31,
        type: 'template-literal',
        file: 'test.ts',
        line: 1,
        column: 12,
        key: 'daysDayStreak',
        interpolations: [
          { name: 'days', expression: 'days' }
        ]
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.modified).toBe(true)
      expect(result.newContent).toContain("i18next.t('daysDayStreak', '{{days}}-day streak', { days })")
    })

    it('merges interpolation variables with namespace option', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = 'const msg = `${days}-day streak`'
      const candidate: CandidateString = {
        content: '{{days}}-day streak',
        confidence: 0.8,
        offset: 12,
        endOffset: 31,
        type: 'template-literal',
        file: 'test.ts',
        line: 1,
        column: 12,
        key: 'daysDayStreak',
        interpolations: [
          { name: 'days', expression: 'days' }
        ]
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        namespace: 'common'
      })

      expect(result.newContent).toContain("i18next.t('daysDayStreak', '{{days}}-day streak', { days, ns: 'common' })")
    })

    it('uses member-expression property in interpolation name', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = 'const msg = `Hello ${user.name}`'
      const candidate: CandidateString = {
        content: 'Hello {{name}}',
        confidence: 0.8,
        offset: 12,
        endOffset: 31,
        type: 'template-literal',
        file: 'test.ts',
        line: 1,
        column: 12,
        key: 'helloName',
        interpolations: [
          { name: 'name', expression: 'user.name' }
        ]
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.newContent).toContain("i18next.t('helloName', 'Hello {{name}}', { name: user.name })")
    })
  })

  describe('plural form replacement', () => {
    it('emits t(key, { count: expr }) for a 3-way plural candidate', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = "const msg = activeTasks === 0 ? 'No tasks' : activeTasks === 1 ? 'One task' : `${activeTasks} tasks`"
      const candidate: CandidateString = {
        content: '{{count}} tasks',
        confidence: 0.9,
        offset: 12,
        endOffset: content.length,
        type: 'string-literal',
        file: 'test.ts',
        line: 1,
        column: 12,
        key: 'countTasks',
        pluralForms: {
          countExpression: 'activeTasks',
          zero: 'No tasks',
          one: 'One task',
          other: '{{count}} tasks'
        }
      }

      const result = transformFile(content, 'test.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.newContent).toContain("i18next.t('countTasks', { defaultValue_zero: 'No tasks', defaultValue_one: 'One task', defaultValue_other: '{{count}} tasks', count: activeTasks })")
    })

    it('emits t(key, { count: expr }) inside a component with useTranslation', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = "const msg = n === 1 ? 'One item' : `${n} items`"
      const candidate: CandidateString = {
        content: '{{count}} items',
        confidence: 0.9,
        offset: 12,
        endOffset: content.length,
        type: 'string-literal',
        file: 'test.tsx',
        line: 1,
        column: 12,
        key: 'countItems',
        insideComponent: 'MyComponent',
        pluralForms: {
          countExpression: 'n',
          one: 'One item',
          other: '{{count}} items'
        }
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.newContent).toContain("t('countItems', { defaultValue_one: 'One item', defaultValue_other: '{{count}} items', count: n })")
      expect(result.newContent).not.toContain('i18next.t')
    })

    it('wraps plural t() call in braces for jsx-text type', () => {
      // eslint-disable-next-line no-template-curly-in-string
      const content = "const msg = n === 1 ? 'One' : `${n} things`"
      const candidate: CandidateString = {
        content: '{{count}} things',
        confidence: 0.9,
        offset: 12,
        endOffset: content.length,
        type: 'jsx-text',
        file: 'test.tsx',
        line: 1,
        column: 12,
        key: 'countThings',
        pluralForms: {
          countExpression: 'n',
          one: 'One',
          other: '{{count}} things'
        }
      }

      const result = transformFile(content, 'test.tsx', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.newContent).toContain("{i18next.t('countThings', { defaultValue_one: 'One', defaultValue_other: '{{count}} things', count: n })}")
    })
  })

  describe('warnings', () => {
    it('warns when i18next.t() is used outside a component in a .tsx file', () => {
      const content = 'const msg = "Hello world"'
      const candidate: CandidateString = {
        content: 'Hello world',
        confidence: 0.9,
        offset: 13,
        endOffset: 24,
        type: 'string-literal',
        file: 'src/utils/helpers.tsx',
        line: 1,
        column: 13,
        key: 'helloWorld'
        // no insideComponent → will use i18next.t()
      }

      const result = transformFile(content, 'src/utils/helpers.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('i18next.t() was added outside of a React component')
      expect(result.warnings[0]).toContain('helpers.tsx')
      expect(result.warnings[0]).toContain('https://www.locize.com/blog/how-to-use-i18next-t-outside-react-components/')
    })

    it('warns when i18next.t() is used outside a component in a .jsx file', () => {
      const content = 'const msg = "Goodbye"'
      const candidate: CandidateString = {
        content: 'Goodbye',
        confidence: 0.9,
        offset: 13,
        endOffset: 20,
        type: 'string-literal',
        file: 'src/lib/util.jsx',
        line: 1,
        column: 13,
        key: 'goodbye'
      }

      const result = transformFile(content, 'src/lib/util.jsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('i18next.t() was added outside of a React component')
    })

    it('does NOT warn when all candidates are inside components in .tsx files', () => {
      const content = 'const msg = "Hello inside"'
      const candidate: CandidateString = {
        content: 'Hello inside',
        confidence: 0.9,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'src/components/Greeting.tsx',
        line: 1,
        column: 13,
        key: 'helloInside',
        insideComponent: 'Greeting'
      }

      const result = transformFile(content, 'src/components/Greeting.tsx', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(0)
    })

    it('does NOT warn for i18next.t() in .ts files (non-React project)', () => {
      const content = 'const msg = "Server error"'
      const candidate: CandidateString = {
        content: 'Server error',
        confidence: 0.9,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'src/utils/errors.ts',
        line: 1,
        column: 13,
        key: 'serverError'
      }

      const result = transformFile(content, 'src/utils/errors.ts', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(0)
    })

    it('does NOT warn for i18next.t() in .js files (non-React project)', () => {
      const content = 'const msg = "Not found"'
      const candidate: CandidateString = {
        content: 'Not found',
        confidence: 0.9,
        offset: 13,
        endOffset: 22,
        type: 'string-literal',
        file: 'src/utils/messages.js',
        line: 1,
        column: 13,
        key: 'notFound'
      }

      const result = transformFile(content, 'src/utils/messages.js', [candidate], {
        isDryRun: false,
        hasReact: false,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(0)
    })

    it('warns when i18next.t() is used outside a component in a .ts file (React project)', () => {
      const content = 'const msg = "Loading data"'
      const candidate: CandidateString = {
        content: 'Loading data',
        confidence: 0.9,
        offset: 13,
        endOffset: 25,
        type: 'string-literal',
        file: 'src/utils/constants.ts',
        line: 1,
        column: 13,
        key: 'loadingData'
      }

      const result = transformFile(content, 'src/utils/constants.ts', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('i18next.t() was added outside of a React component')
      expect(result.warnings[0]).toContain('constants.ts')
    })

    it('warns when i18next.t() is used outside a component in a .js file (React project)', () => {
      const content = 'const msg = "Something went wrong"'
      const candidate: CandidateString = {
        content: 'Something went wrong',
        confidence: 0.9,
        offset: 13,
        endOffset: 33,
        type: 'string-literal',
        file: 'src/lib/errors.js',
        line: 1,
        column: 13,
        key: 'somethingWentWrong'
      }

      const result = transformFile(content, 'src/lib/errors.js', [candidate], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig
      })

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('i18next.t() was added outside of a React component')
    })
  })
})
