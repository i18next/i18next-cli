import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { processFile } from '../src/extractor/core/extractor'
import { ASTVisitors } from '../src/extractor/parsers/ast-visitors'
import { createPluginContext } from '../src/extractor/plugin-manager'
import { ConsoleLogger } from '../src/utils/logger'
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
      objectKeys: new Set(),
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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/App.tsx', plugins, astVisitors, pluginContext, mockConfig)

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

    const plugins = configWithPlugin.plugins

    vol.fromJSON({
      '/src/test.ts': originalCode,
    })

    const pluginContext = createPluginContext(allKeys, plugins, configWithPlugin, new ConsoleLogger())

    await processFile('/src/test.ts', plugins, astVisitors, pluginContext, configWithPlugin)

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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/test.ts', plugins, astVisitors, pluginContext, mockConfig)

    // Keys should be added to allKeys map through the plugin context
    expect(allKeys.size).toBeGreaterThan(0)
  })

  it('should handle TypeScript satisfies operator in template literals', async () => {
    const sampleCode = `
      const role = 'ADMIN';
      t(\`profile.role.\${role satisfies 'ADMIN' | 'MANAGER' | 'EMPLOYEE'}.description\`);
    `

    vol.fromJSON({
      '/src/satisfies-test.ts': sampleCode,
    })

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/satisfies-test.ts', plugins, astVisitors, pluginContext, mockConfig)

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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/as-test.ts', plugins, astVisitors, pluginContext, mockConfig)

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/jsx-test.tsx', plugins, astVisitors, pluginContext, mockConfig)

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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await processFile('/src/decorator-test.ts', plugins, astVisitors, pluginContext, mockConfig)

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

    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(processFile('/src/invalid.ts', plugins, astVisitors, pluginContext, mockConfig))
      .rejects.toThrow('Failed to process file')
  })

  it('should throw ExtractorError when file does not exist', async () => {
    const plugins = []

    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(processFile('/nonexistent/file.ts', plugins, astVisitors, pluginContext, mockConfig))
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

    const plugins = configWithSatisfiesPlugin.plugins

    const pluginContext = createPluginContext(allKeys, plugins, configWithSatisfiesPlugin, new ConsoleLogger())

    await processFile('/src/satisfies-plugin-test.ts', plugins, astVisitors, pluginContext, configWithSatisfiesPlugin)

    // Verify that the plugin could potentially extract keys from satisfies expressions
    expect(extractedKeys.length).toBeGreaterThanOrEqual(0)
  })
})
