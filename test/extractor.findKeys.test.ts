import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest'
import type { Expression } from '@swc/core'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin, PluginContext } from '../src/index'
import type { ScopeInfo } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

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

describe('extractor.findKeys', () => {
  let mockGlob!: Mock

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    mockGlob = vi.mocked(glob)
  })

  it('extracts keys from t() and Trans with default values preserved', async () => {
    const sampleCode = `
      import { Trans, useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation();
        return (
          <div>
            <h1>{t('app.title', { defaultValue: 'Welcome!' })}</h1>
            <Trans i18nKey="app.description">
              This is a <strong>description</strong>.
            </Trans>
          </div>
        );
      }
    `

    mockGlob.mockResolvedValue(['/src/App.tsx'])

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const { allKeys: keys } = await findKeys(mockConfig)
    const extractedValues = Array.from(keys.values())

    const title = extractedValues.find(k => k.key === 'app.title')
    const desc = extractedValues.find(k => k.key === 'app.description')

    expect(title).toBeDefined()
    expect(desc).toBeDefined()

    expect(title?.defaultValue).toBe('Welcome!')
    expect(desc?.defaultValue).toBe('This is a <strong>description</strong>.')

    // Both keys should belong to the default namespace
    expect(title?.ns).toBe('translation')
    expect(desc?.ns).toBe('translation')
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

    mockGlob.mockResolvedValue(['/src/test.ts'])

    const sampleCode = `
        function test() {
          const x = 'hello';
          return x;
        }
      `

    vol.fromJSON({
      '/src/test.ts': sampleCode,
    })

    await findKeys(configWithPlugin)

    expect(onVisitNodeSpy).toHaveBeenCalled()
    // Should be called multiple times for different AST nodes
    expect(onVisitNodeSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('should provide plugin context with scope access to plugins', async () => {
    let capturedContext!: PluginContext
    let capturedScopeInfo!: ScopeInfo | undefined
    const scopeAccessPlugin: Plugin = {
      name: 'scope-access-plugin',
      onVisitNode: (node, context) => {
        const expression = node as Expression

        if (expression.type === 'CallExpression' && expression.callee.type === 'Identifier' && expression.callee.value === 't') {
          capturedContext = context
          capturedScopeInfo = context.getVarFromScope('t')
        }
      }
    }

    const configWithPlugin = {
      ...mockConfig,
      plugins: [scopeAccessPlugin]
    }

    mockGlob.mockResolvedValue(['/src/App.tsx'])

    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      function App() {
        const { t } = useTranslation('common');
        return (
          <div>
            <h1>{t('app.title', { defaultValue: 'Welcome!' })}</h1>
            <Trans i18nKey="app.description">
              This is a <strong>description</strong>.
            </Trans>
          </div>
        );
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    await findKeys(configWithPlugin)

    expect(capturedContext).toBeDefined()
    expect(capturedContext.getVarFromScope).toBeDefined()
    expect(typeof capturedContext.getVarFromScope).toBe('function')

    expect(capturedScopeInfo).toEqual({ defaultNs: 'common', keyPrefix: undefined })
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

    mockGlob.mockResolvedValue(['/src/options-test.ts'])

    vol.fromJSON({
      '/src/options-test.ts': sampleCode,
    })

    const { allKeys } = await findKeys(configWithPlugin)

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

    mockGlob.mockResolvedValue(['/src/test.ts'])

    const sampleCode = 'const x = 1;'

    vol.fromJSON({
      '/src/test.ts': sampleCode,
    })

    // Should not throw, but handle errors gracefully
    await expect(findKeys(configWithFaultyPlugin))
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

    mockGlob.mockResolvedValue(['/src/multi-test.ts'])

    const sampleCode = 't(\'multi.plugin.test\');'

    vol.fromJSON({
      '/src/multi-test.ts': sampleCode,
    })

    await findKeys(configWithPlugins)

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

  it('should extract string value from TypeScript enum member used in t()', async () => {
    const enumFile = `
      export enum ERROR_CODE {
        UNKNOWN_ERROR = 'UNKNOWN_ERROR',
        NETWORK_ERROR = 'NETWORK_ERROR'
      }
    `

    const usageFile = `
      import { ERROR_CODE } from './types';
      function App() {
        const { t } = { t: (k: string) => k as any };
        return <div>{t(ERROR_CODE.UNKNOWN_ERROR)}</div>;
      }
    `

    vol.fromJSON({
      '/src/types.ts': enumFile,
      '/src/MyComponent.tsx': usageFile,
    })

    mockGlob.mockResolvedValue(['/src/types.ts', '/src/MyComponent.tsx'])

    const { allKeys } = await findKeys(mockConfig)

    const uniqueKey = 'translation:UNKNOWN_ERROR'
    expect(allKeys.has(uniqueKey)).toBe(true)
    const extracted = allKeys.get(uniqueKey)
    expect(extracted).toBeDefined()
    expect(extracted?.key).toBe('UNKNOWN_ERROR')
    expect(extracted?.defaultValue).toBe('UNKNOWN_ERROR')
  })

  it('should handle nullish coalescing (??) when resolving keys', async () => {
    const sampleCode = `
      import { useTranslation } from "react-i18next";

      export default function App() {
        const { t } = useTranslation();

        const a =
          process.env.NODE_ENV === "production"
            ? "test1"
            : process.env.NODE_ENV === "test"
            ? "test2"
            : null;

        const b = a ?? "test3";

        const c = t(b);

        return <>{c}</>;
      }
    `

    mockGlob.mockResolvedValue(['/src/App.tsx'])

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const { allKeys } = await findKeys(mockConfig)

    expect(allKeys.has('translation:test1')).toBe(true)
    expect(allKeys.has('translation:test2')).toBe(true)
    expect(allKeys.has('translation:test3')).toBe(true)
  })
})
