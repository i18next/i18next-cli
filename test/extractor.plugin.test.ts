import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin, PluginContext } from '../src/index'
import type { CallExpression } from '@swc/core'

export const logI18nPlugin = (): Plugin => ({
  name: 'log-i18n-plugin',

  onVisitNode (node, context: PluginContext) {
    if (node.type !== 'CallExpression') return

    const callee = (node as CallExpression).callee
    if (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.value === 'log' &&
      callee.property.type === 'Identifier' &&
      callee.property.value === 'i18n'
    ) {
      // Ensure the first argument is a string literal
      const firstArg = (node as any).arguments?.[0]?.expression
      if (firstArg?.type === 'StringLiteral') {
        context.addKey({
          key: firstArg.value,
          defaultValue: firstArg.value, // use the key as default
        })
      }
    }
  },
})

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({
  glob: vi.fn(),
}))

const mockConfigBase: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor plugin system', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('allows plugins to add keys via onVisitNode (log.i18n)', async () => {
    const sampleCode = `
      function App() {
        log.i18n('plugin.key');
        return null;
      }
    `
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const config = {
      ...mockConfigBase,
      plugins: [logI18nPlugin()],
    }

    const keys = await findKeys(config as I18nextToolkitConfig)
    // Instead of checking the map's internal key, check the values.
    const extractedValues = Array.from(keys.values())
    const pluginKeyObject = extractedValues.find(k => k.key === 'plugin.key')

    // Assert that an object with the key 'plugin.key' was extracted.
    expect(pluginKeyObject).toBeDefined()
    expect(pluginKeyObject?.defaultValue).toBe('plugin.key')
  })
})
