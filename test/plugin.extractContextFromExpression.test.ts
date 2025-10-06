import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Expression } from '@swc/core'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin, Logger } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

describe('plugin system: extractContextFromExpression', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
  })

  it('should extract context values from conditional expressions', async () => {
    const sampleCode = `
      const userType = 'admin';
      t('greeting', { context: userType === 'admin' ? 'admin' : 'user' });
      t('message', { context: 'default' });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const conditionalContextPlugin = (): Plugin => ({
      name: 'conditional-context-extractor',
      extractContextFromExpression: (expression: Expression, config, logger: Logger) => {
        const contexts: string[] = []

        // Handle conditional expressions (ternary operators)
        if (expression.type === 'ConditionalExpression') {
          if (expression.consequent.type === 'StringLiteral') {
            contexts.push(expression.consequent.value)
          }
          if (expression.alternate.type === 'StringLiteral') {
            contexts.push(expression.alternate.value)
          }
        }

        return contexts
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [conditionalContextPlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Should extract base keys (for dynamic context) and context variants
    expect(extractedKeys).toContain('greeting')
    expect(extractedKeys).toContain('greeting_admin')
    expect(extractedKeys).toContain('greeting_user')
    // Static context only generates the context variant, not the base key
    expect(extractedKeys).toContain('message_default')
  })

  it('should extract context from template literals with variable names', async () => {
    const sampleCode = `
      const role = 'manager';
      const level = 'senior';
      t('title', { context: \`\${role}.\${level}\` });
      t('label', { context: 'static' });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const templateContextPlugin = (): Plugin => ({
      name: 'template-context-extractor',
      extractContextFromExpression: (expression: Expression, config, logger: Logger) => {
        const contexts: string[] = []

        if (expression.type === 'TemplateLiteral') {
          const joins = expression.quasis.map(quasi => quasi.cooked)
          const parts = expression.expressions.map(expr =>
            expr.type === 'Identifier' ? expr.value : 'unknown'
          )

          if (parts.length > 0) {
            const reconstructed = joins.reduce<string>(
              (acc, join, i) => acc + (join || '') + (parts[i] || ''),
              ''
            )
            contexts.push(reconstructed)
          }
        }

        return contexts
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [templateContextPlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Dynamic context adds both base key and context variants
    expect(extractedKeys).toContain('title')
    expect(extractedKeys).toContain('title_role.level')
    // Static context only generates the context variant
    expect(extractedKeys).toContain('label_static')
  })

  it('should handle multiple plugins with extractContextFromExpression', async () => {
    const sampleCode = `
      t('status', { context: condition ? 'active' : 'inactive' });
      t('mode', { context: \`\${theme}\` });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const conditionalPlugin = (): Plugin => ({
      name: 'conditional-context-plugin',
      extractContextFromExpression: (expression: Expression) => {
        if (expression.type === 'ConditionalExpression') {
          const contexts: string[] = []
          if (expression.consequent.type === 'StringLiteral') {
            contexts.push(expression.consequent.value)
          }
          if (expression.alternate.type === 'StringLiteral') {
            contexts.push(expression.alternate.value)
          }
          return contexts
        }
        return []
      },
    })

    const templatePlugin = (): Plugin => ({
      name: 'template-context-plugin',
      extractContextFromExpression: (expression: Expression) => {
        if (expression.type === 'TemplateLiteral') {
          return ['light', 'dark']
        }
        return []
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [conditionalPlugin(), templatePlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Both plugins should contribute context variants
    expect(extractedKeys).toContain('status_active')
    expect(extractedKeys).toContain('status_inactive')
    expect(extractedKeys).toContain('mode_light')
    expect(extractedKeys).toContain('mode_dark')
  })

  it('should handle errors gracefully in extractContextFromExpression', async () => {
    const sampleCode = `
      t('key.normal', { context: 'valid' });
      t('key.other', { context: someExpression });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const faultyPlugin = (): Plugin => ({
      name: 'faulty-context-plugin',
      extractContextFromExpression: (expression: Expression) => {
        throw new Error('Context extraction error!')
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [faultyPlugin()],
    }

    // Should not throw
    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Keys should still be extracted despite plugin error
    // Static context only generates context variant
    expect(extractedKeys).toContain('key.normal_valid')
    expect(extractedKeys).toContain('key.other')
  })

  it('should provide config and logger to extractContextFromExpression', async () => {
    const sampleCode = `
      t('button', { context: isActive ? 'enabled' : 'disabled' });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const configSpy = vi.fn()
    const loggerSpy = vi.fn()

    const inspectorPlugin = (): Plugin => ({
      name: 'inspector-context-plugin',
      extractContextFromExpression: (expression: Expression, config, logger: Logger) => {
        configSpy(config)
        loggerSpy(logger)

        if (expression.type === 'ConditionalExpression') {
          const contexts: string[] = []
          if (expression.consequent.type === 'StringLiteral') {
            contexts.push(expression.consequent.value)
          }
          if (expression.alternate.type === 'StringLiteral') {
            contexts.push(expression.alternate.value)
          }
          return contexts
        }
        return []
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [inspectorPlugin()],
    }

    await findKeys(config)

    // Verify that the plugin received config and logger
    expect(configSpy).toHaveBeenCalled()
    expect(loggerSpy).toHaveBeenCalled()

    const receivedConfig = configSpy.mock.calls[0][0]
    expect(receivedConfig).toHaveProperty('locales')
    expect(receivedConfig).toHaveProperty('extract')

    const receivedLogger = loggerSpy.mock.calls[0][0]
    expect(receivedLogger).toHaveProperty('warn')
  })

  it('should extract context from object property access', async () => {
    const sampleCode = `
      const CONTEXTS = { ADMIN: 'admin', USER: 'user', GUEST: 'guest' };
      t('welcome', { context: CONTEXTS.ADMIN });
      t('dashboard', { context: someVar ? CONTEXTS.USER : CONTEXTS.GUEST });
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const objectContextPlugin = (): Plugin => ({
      name: 'object-context-extractor',
      extractContextFromExpression: (expression: Expression) => {
        const contexts: string[] = []

        const extractFromMemberExpression = (expr: Expression) => {
          if (expr.type === 'MemberExpression' &&
              expr.object.type === 'Identifier' &&
              expr.object.value === 'CONTEXTS' &&
              expr.property.type === 'Identifier') {
            const contextMap: Record<string, string> = {
              ADMIN: 'admin',
              USER: 'user',
              GUEST: 'guest'
            }
            const propName = expr.property.value
            if (propName in contextMap) {
              contexts.push(contextMap[propName])
            }
          }
        }

        // Handle member expressions like CONTEXTS.ADMIN
        extractFromMemberExpression(expression)

        // Handle conditional expressions with member expressions in branches
        if (expression.type === 'ConditionalExpression') {
          extractFromMemberExpression(expression.consequent)
          extractFromMemberExpression(expression.alternate)
        }

        return contexts
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [objectContextPlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Static context from object property
    expect(extractedKeys).toContain('welcome_admin')
    // Dynamic context from conditional adds base key and context variants
    expect(extractedKeys).toContain('dashboard')
    expect(extractedKeys).toContain('dashboard_user')
    expect(extractedKeys).toContain('dashboard_guest')
  })
})
