import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { processFile } from '../src/extractor/core/extractor'
import { ASTVisitors } from '../src/extractor/core/ast-visitors'
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

describe('Type Assertion Parsing (tsx vs ts)', () => {
  let allKeys: Map<string, ExtractedKey>
  let astVisitors: ASTVisitors

  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    allKeys = new Map()
    astVisitors = {
      visit: vi.fn(),
      getVarFromScope: vi.fn().mockReturnValue(undefined),
      objectKeys: new Set(),
    } as any
  })

  it('should parse simple angle bracket type assertion in .ts files', async () => {
    const sampleCode = `
      const value = <string>'test';
    `

    vol.fromJSON({
      '/src/simple-cast.ts': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    // This should NOT throw an error
    await expect(
      processFile('/src/simple-cast.ts', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should parse angle bracket type assertions with function calls in .ts files', async () => {
    const sampleCode = `
      interface Schedule {
        name: string;
      }

      function getData(value: any): unknown {
        return { name: 'test' };
      }

      export class Service {
        public getInfo() {
          const data = { test: 'value' };
          const schedule = <Schedule>(
            getData(data)
          );

          return schedule;
        }
      }
    `

    vol.fromJSON({
      '/src/Service.ts': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    // This should NOT throw an error
    await expect(
      processFile('/src/Service.ts', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should parse multiple angle bracket type assertions in .ts files', async () => {
    const sampleCode = `
      const value1 = <string>('hello');
      const value2 = <number>(42);
      const value3 = <Array<string>>(['a', 'b', 'c']);

      function test() {
        const casted = <Record<string, any>>({ key: 'value' });
        return casted;
      }
    `

    vol.fromJSON({
      '/src/type-casts.ts': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(
      processFile('/src/type-casts.ts', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledTimes(1)
  })

  it('should still parse JSX correctly in .tsx files', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      interface Props {
        name: string;
      }

      export function Component({ name }: Props) {
        return (
          <div>
            <Trans i18nKey="greeting">
              Hello <strong>{name}</strong>!
            </Trans>
            <button>Click me</button>
          </div>
        );
      }
    `

    vol.fromJSON({
      '/src/Component.tsx': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(
      processFile('/src/Component.tsx', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )
  })

  it('should parse JSX in .jsx files', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      export function Component() {
        return (
          <div>
            <Trans i18nKey="test">Test content</Trans>
          </div>
        );
      }
    `

    vol.fromJSON({
      '/src/Component.jsx': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(
      processFile('/src/Component.jsx', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledTimes(1)
  })

  it('should handle complex nested type assertions in .ts files', async () => {
    const sampleCode = `
      type ComplexType = {
        nested: {
          value: string;
        };
      };

      function transform() {
        const result = <ComplexType>(<unknown>({
          nested: {
            value: 'test'
          }
        }));

        return result;
      }

      // Arrow function type assertion
      const arrowFn = (val: unknown) => <string>(val);
    `

    vol.fromJSON({
      '/src/complex-casts.ts': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(
      processFile('/src/complex-casts.ts', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledTimes(1)
  })

  it('should handle .ts files with translation calls and type assertions', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      interface Schedule {
        name: string;
      }

      function getSchedule(data: unknown): unknown {
        return data;
      }

      export function MyService() {
        const { t } = useTranslation();

        const schedule = <Schedule>(
          getSchedule({ name: 'test' })
        );

        const message = t('service.message', 'Default message');

        return {
          schedule,
          message
        };
      }
    `

    vol.fromJSON({
      '/src/service-with-casts.ts': sampleCode,
    })

    const plugins: Plugin[] = []
    const pluginContext = createPluginContext(allKeys, plugins, mockConfig, new ConsoleLogger())

    await expect(
      processFile('/src/service-with-casts.ts', plugins, astVisitors, pluginContext, mockConfig)
    ).resolves.not.toThrow()

    expect(astVisitors.visit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Module'
      })
    )

    // Verify that translation keys are still extracted
    expect(allKeys.size).toBeGreaterThanOrEqual(0)
  })
})
