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

describe('plugin system: extractKeysFromExpression', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
  })

  it('should extract keys from template literals variable names using extractKeysFromExpression', async () => {
    const sampleCode = `
      const namespace = 'user';
      const action = 'login';
      t(\`\${namespace}.\${action}\`);
      t(\`\${namespace}.state.\${action}\`);
      t('key.literal');
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Create a plugin that extracts keys from template literals based on variable names
    const templateLiteralPlugin = (): Plugin => ({
      name: 'template-literal-extractor',
      extractKeysFromExpression: (expression: Expression, config, logger: Logger) => {
        const keys: string[] = []

        // Handle template literals with simple variable substitutions
        if (expression.type === 'TemplateLiteral') {
          // For this example, we'll extract a pattern if we can determine the values
          const joins = expression.quasis.map(quasi => quasi.cooked)
          const parts = expression.expressions.map(expression => expression.type === 'Identifier' ? expression.value : 'unknown')

          if (parts.length > 0) {
            keys.push(joins.reduce<string>((acc, join, i) => (acc) + (join || '') + (parts[i] || ''), ''))
          }
        }

        return keys
      },
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [templateLiteralPlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    expect(extractedKeys).toContain('key.literal')
    expect(extractedKeys).toContain('namespace.action')
    expect(extractedKeys).toContain('namespace.state.action')
  })

  it('should handle multiple plugins with extractKeysFromExpression', async () => {
    const sampleCode = `
      t(18n);
      t(\`prefix.\${suffix}\`);
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const bigIntPlugin = (): Plugin => ({
      name: 'big-int-plugin',
      extractKeysFromExpression: (expression: Expression) => {
        if (expression.type === 'BigIntLiteral') {
          return [expression.raw || '']
        }

        return []
      },
    })

    const templatePlugin = (): Plugin => ({
      name: 'template-plugin',
      extractKeysFromExpression: (expression: Expression) => {
        if (expression.type === 'TemplateLiteral') {
          return ['prefix.dynamic1', 'prefix.dynamic2']
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
      plugins: [bigIntPlugin(), templatePlugin()],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Both plugins should return keys
    expect(extractedKeys).toContain('18n')
    expect(extractedKeys).toContain('prefix.dynamic1')
    expect(extractedKeys).toContain('prefix.dynamic2')
  })

  it('should handle errors gracefully in extractKeysFromExpression', async () => {
    const sampleCode = `
      t('key.normal');
      t(someExpression);
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const faultyPlugin = (): Plugin => ({
      name: 'faulty-plugin',
      extractKeysFromExpression: (expression: Expression) => {
        throw new Error('Plugin error!')
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
    expect(extractedKeys).toContain('key.normal')
  })

  it('should provide config and logger to extractKeysFromExpression', async () => {
    const sampleCode = `
      t(someVar ? 'key.test' : 'key.fallback');
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const configSpy = vi.fn()
    const loggerSpy = vi.fn()

    const inspectorPlugin = (): Plugin => ({
      name: 'inspector-plugin',
      extractKeysFromExpression: (expression: Expression, config, logger: Logger) => {
        // Pass to spies to access references after the plugin is called
        configSpy(config)
        loggerSpy(logger)

        if (expression.type === 'ConditionalExpression') {
          const keys: string[] = []
          if (expression.consequent.type === 'StringLiteral') {
            keys.push(expression.consequent.value)
          }
          return keys
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
})
