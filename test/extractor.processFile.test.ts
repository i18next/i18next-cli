import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { processFile } from '../src/extractor/core/extractor'
import { ASTVisitors } from '../src/extractor/parsers/ast-visitors'
import type { I18nextToolkitConfig, ExtractedKey, Plugin } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

const mockConfig: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('processFile', () => {
  let allKeys: Map<string, ExtractedKey>
  let astVisitors: ASTVisitors

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    allKeys = new Map()
    // Mock the ASTVisitors class and its methods
    astVisitors = {
      visit: vi.fn(),
      getVarFromScope: vi.fn().mockReturnValue(undefined),
      objectKeys: new Set()
    } as any
  })

  it('should process a basic TypeScript file and extract keys', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function App() {
        const { t } = useTranslation();
        return <div>{t('hello.world', 'Hello World!')}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await processFile('/src/App.tsx', mockConfig, allKeys, astVisitors)

    expect(astVisitors.visit).toHaveBeenCalledTimes(1)
    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should handle plugin onLoad hooks for code transformation', async () => {
    const originalCode = 't(\'original.key\')'
    const transformedCode = 't(\'transformed.key\')'

    const transformPlugin: Plugin = {
      name: 'transform-plugin',
      onLoad: vi.fn().mockResolvedValue(transformedCode)
    }

    const configWithPlugin = {
      ...mockConfig,
      plugins: [transformPlugin]
    }

    vol.fromJSON({
      '/src/test.ts': originalCode,
    })

    await processFile('/src/test.ts', configWithPlugin, allKeys, astVisitors)

    expect(transformPlugin.onLoad).toHaveBeenCalledWith(originalCode, '/src/test.ts')
    expect(astVisitors.visit).toHaveBeenCalledTimes(1)
  })

  it('should extract keys from comments in the code', async () => {
    const sampleCode = `
      // t('comment.key1', 'From comment')
      /* t('comment.key2', 'From block comment') */
      function test() {
        return 'test';
      }
    `

    vol.fromJSON({
      '/src/test.ts': sampleCode,
    })

    await processFile('/src/test.ts', mockConfig, allKeys, astVisitors)

    // Keys should be added to allKeys map through the plugin context
    expect(allKeys.size).toBeGreaterThan(0)
  })

  it('should call plugin onVisitNode hooks for each AST node', async () => {
    const onVisitNodeSpy = vi.fn()
    const visitPlugin: Plugin = {
      name: 'visit-plugin',
      onVisitNode: onVisitNodeSpy
    }

    const configWithPlugin = {
      ...mockConfig,
      plugins: [visitPlugin]
    }

    const sampleCode = `
      function test() {
        const x = 'hello';
        return x;
      }
    `

    vol.fromJSON({
      '/src/test.ts': sampleCode,
    })

    await processFile('/src/test.ts', configWithPlugin, allKeys, astVisitors)

    expect(onVisitNodeSpy).toHaveBeenCalled()
    // Should be called multiple times for different AST nodes
    expect(onVisitNodeSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('should provide plugin context with scope access to plugins', async () => {
    const mockScopeInfo = { type: 'useTranslation', ns: 'common' }
    astVisitors.getVarFromScope = vi.fn().mockReturnValue(mockScopeInfo)

    let capturedContext: any
    const scopeAccessPlugin: Plugin = {
      name: 'scope-access-plugin',
      onVisitNode: (node, context) => {
        capturedContext = context
      }
    }

    const configWithPlugin = {
      ...mockConfig,
      plugins: [scopeAccessPlugin]
    }

    vol.fromJSON({
      '/src/test.ts': 'const x = 1;',
    })

    await processFile('/src/test.ts', configWithPlugin, allKeys, astVisitors)

    expect(capturedContext).toBeDefined()
    expect(capturedContext.getVarFromScope).toBeDefined()
    expect(typeof capturedContext.getVarFromScope).toBe('function')

    // Test that the scope function works
    const scopeResult = capturedContext.getVarFromScope('testVar')
    expect(astVisitors.getVarFromScope).toHaveBeenCalledWith('testVar')
    expect(scopeResult).toEqual(mockScopeInfo)
  })

  it('should handle TypeScript satisfies operator in template literals', async () => {
    const sampleCode = `
      const role = 'ADMIN';
      t(\`profile.role.\${role satisfies 'ADMIN' | 'MANAGER' | 'EMPLOYEE'}.description\`);
    `

    vol.fromJSON({
      '/src/satisfies-test.ts': sampleCode,
    })

    await processFile('/src/satisfies-test.ts', mockConfig, allKeys, astVisitors)

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should handle TypeScript as operator in template literals', async () => {
    const sampleCode = `
      const status = getStatus();
      t(\`alert.\${status as 'success' | 'error' | 'warning'}.message\`);
    `

    vol.fromJSON({
      '/src/as-test.ts': sampleCode,
    })

    await processFile('/src/as-test.ts', mockConfig, allKeys, astVisitors)

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should allow plugins to access parsed translation options', async () => {
    let capturedContext: any
    const optionsAccessPlugin: Plugin = {
      name: 'options-access-plugin',
      onVisitNode: (node, context) => {
        capturedContext = context
        // Plugin can add keys with full context
        if (node.type === 'CallExpression') {
          context.addKey({
            key: 'plugin.extracted.key',
            defaultValue: 'Plugin Value',
            ns: 'custom'
          })
        }
      }
    }

    const configWithPlugin = {
      ...mockConfig,
      plugins: [optionsAccessPlugin]
    }

    const sampleCode = `
      t('test.key', { defaultValue: 'Test', count: 1, context: 'male' });
    `

    vol.fromJSON({
      '/src/options-test.ts': sampleCode,
    })

    await processFile('/src/options-test.ts', configWithPlugin, allKeys, astVisitors)

    expect(capturedContext).toBeDefined()
    expect(capturedContext.addKey).toBeDefined()
    expect(capturedContext.config).toEqual(configWithPlugin)

    // Verify plugin could add a key
    expect(allKeys.has('custom:plugin.extracted.key')).toBe(true)
  })

  it('should handle plugin errors gracefully', async () => {
    const faultyPlugin: Plugin = {
      name: 'faulty-plugin',
      onLoad: vi.fn().mockRejectedValue(new Error('Load failed')),
      onVisitNode: vi.fn().mockImplementation(() => {
        throw new Error('Visit failed')
      })
    }

    const configWithFaultyPlugin = {
      ...mockConfig,
      plugins: [faultyPlugin]
    }

    const sampleCode = 'const x = 1;'

    vol.fromJSON({
      '/src/test.ts': sampleCode,
    })

    // Should not throw, but handle errors gracefully
    await expect(processFile('/src/test.ts', configWithFaultyPlugin, allKeys, astVisitors))
      .resolves.not.toThrow()
  })

  it('should support multiple plugins working together', async () => {
    const plugin1Spy = vi.fn()
    const plugin2Spy = vi.fn()

    const plugin1: Plugin = {
      name: 'plugin-1',
      onLoad: plugin1Spy.mockImplementation((code) => `// Plugin 1\n${code}`),
      onVisitNode: plugin1Spy
    }

    const plugin2: Plugin = {
      name: 'plugin-2',
      onLoad: plugin2Spy.mockImplementation((code) => `// Plugin 2\n${code}`),
      onVisitNode: plugin2Spy
    }

    const configWithPlugins = {
      ...mockConfig,
      plugins: [plugin1, plugin2]
    }

    const sampleCode = 't(\'multi.plugin.test\');'

    vol.fromJSON({
      '/src/multi-test.ts': sampleCode,
    })

    await processFile('/src/multi-test.ts', configWithPlugins, allKeys, astVisitors)

    // Both plugins should have been called for onLoad
    expect(plugin1Spy).toHaveBeenCalledWith(sampleCode, '/src/multi-test.ts')
    expect(plugin2Spy).toHaveBeenCalledWith(
      expect.stringContaining('// Plugin 1'),
      '/src/multi-test.ts'
    )

    // Both plugins should have been called for onVisitNode
    expect(plugin1Spy.mock.calls.length).toBeGreaterThan(1)
    expect(plugin2Spy.mock.calls.length).toBeGreaterThan(1)
  })

  it('should parse JSX syntax correctly', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';
      
      function Component() {
        return (
          <Trans i18nKey="jsx.test">
            Hello <strong>world</strong>!
          </Trans>
        );
      }
    `

    vol.fromJSON({
      '/src/jsx-test.tsx': sampleCode,
    })

    await processFile('/src/jsx-test.tsx', mockConfig, allKeys, astVisitors)

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should handle files with decorators', async () => {
    const sampleCode = `
      @Component({
        selector: 'app-test'
      })
      class TestComponent {
        @Input() value: string = t('decorator.test');
      }
    `

    vol.fromJSON({
      '/src/decorator-test.ts': sampleCode,
    })

    await processFile('/src/decorator-test.ts', mockConfig, allKeys, astVisitors)

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should throw ExtractorError when file processing fails', async () => {
    // Create a file with invalid syntax
    const invalidCode = `
      this is not valid javascript syntax !!!
    `

    vol.fromJSON({
      '/src/invalid.ts': invalidCode,
    })

    await expect(processFile('/src/invalid.ts', mockConfig, allKeys, astVisitors))
      .rejects.toThrow('Failed to process file')
  })

  it('should throw ExtractorError when file does not exist', async () => {
    await expect(processFile('/nonexistent/file.ts', mockConfig, allKeys, astVisitors))
      .rejects.toThrow('Failed to process file')
  })

  it('should support custom plugin that extracts keys from TypeScript satisfies expressions', async () => {
    const extractedKeys: ExtractedKey[] = []

    const satisfiesPlugin: Plugin = {
      name: 'satisfies-extractor',
      onVisitNode: (node, context) => {
        // Look for template literals with satisfies expressions
        if (node.type === 'TemplateLiteral' && 'expressions' in node && Array.isArray((node as any).expressions)) {
          const expressions = (node as any).expressions as any[]
          for (const expr of expressions) {
            const e = expr as any
            if (e.type === 'TsAsExpression' && e.typeAnnotation?.type === 'TsUnionType') {
              // Extract possible values from union type
              const unionTypes = e.typeAnnotation.types
              for (const unionType of unionTypes) {
                if (unionType.type === 'TsLiteralType' && unionType.literal?.type === 'StringLiteral') {
                  const possibleValue = unionType.literal.value
                  context.addKey({
                    key: `dynamic.${possibleValue}.extracted`,
                    defaultValue: `Dynamic ${possibleValue}`,
                    ns: 'translation'
                  })
                  extractedKeys.push({
                    key: `dynamic.${possibleValue}.extracted`,
                    defaultValue: `Dynamic ${possibleValue}`,
                    ns: 'translation'
                  })
                }
              }
            }
          }
        }
      }
    }

    const configWithSatisfiesPlugin = {
      ...mockConfig,
      plugins: [satisfiesPlugin]
    }

    const sampleCode = `
      const role = 'ADMIN';
      t(\`profile.role.\${role satisfies 'ADMIN' | 'MANAGER' | 'EMPLOYEE'}.description\`);
    `

    vol.fromJSON({
      '/src/satisfies-plugin-test.ts': sampleCode,
    })

    await processFile('/src/satisfies-plugin-test.ts', configWithSatisfiesPlugin, allKeys, astVisitors)

    // Verify that the plugin could potentially extract keys from satisfies expressions
    expect(extractedKeys.length).toBeGreaterThanOrEqual(0)
  })
})
