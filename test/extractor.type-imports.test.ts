import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
    nsSeparator: false,
  },
}

const extractKeys = async (config = mockConfig) => {
  const results = await extract(config)
  return results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))?.newTranslations
}

// "extract: resolve finite dynamic keys through renaming imports and through
//  type declarations living in node_modules" (issues #294 / #213)
describe('extractor: type-aware resolution across imports (issue #294)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  describe('renaming imports (`import { X as Y }`)', () => {
    it('should resolve a string union imported under an alias', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/types.ts', '/src/App.tsx'])
      vol.fromJSON({
        '/src/types.ts': "export type ResourceStatus = 'active' | 'paused';",
        '/src/App.tsx': `
          import { ResourceStatus as Status } from './types';
          declare const s: Status;
          t(\`sdk.status.\${s}\`);
        `,
      })

      const keys = await extractKeys()
      expect(keys).toHaveProperty('sdk.status.active')
      expect(keys).toHaveProperty('sdk.status.paused')
    })

    it('should resolve a string enum imported under an alias', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/types.ts', '/src/App.tsx'])
      vol.fromJSON({
        '/src/types.ts': "export enum OperationName { Create = 'create', Delete = 'delete' }",
        '/src/App.tsx': `
          import { OperationName as Op } from './types';
          declare const o: Op;
          t(\`sdk.op.\${o}\`);
        `,
      })

      const keys = await extractKeys()
      expect(keys).toHaveProperty('sdk.op.create')
      expect(keys).toHaveProperty('sdk.op.delete')
    })

    it('should resolve an alias declared after the file that uses it', async () => {
      // The alias is recorded during the pre-scan of App.tsx, before types.ts is
      // parsed — mirroring must therefore happen once every file has been seen.
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/App.tsx', '/src/types.ts'])
      vol.fromJSON({
        '/src/App.tsx': `
          import { ResourceStatus as Status } from './types';
          declare const s: Status;
          t('sdk.status.' + s);
        `,
        '/src/types.ts': "export type ResourceStatus = 'active' | 'paused';",
      })

      const keys = await extractKeys()
      expect(keys).toHaveProperty('sdk.status.active')
      expect(keys).toHaveProperty('sdk.status.paused')
    })

    it('should resolve a renamed import to the imported declaration, not a same-named one (#306)', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/types.ts', '/src/App.tsx'])
      vol.fromJSON({
        '/src/types.ts': `
          export type ResourceStatus = 'active' | 'paused';
          export type Status = 'on' | 'off';
        `,
        '/src/App.tsx': `
          import { ResourceStatus as Status } from './types';
          declare const s: Status;
          t(\`sdk.status.\${s}\`);
        `,
      })

      const keys = await extractKeys()
      // `Status` here is `ResourceStatus`, whatever else `types.ts` declares as `Status`
      expect(keys).toHaveProperty('sdk.status.active')
      expect(keys).toHaveProperty('sdk.status.paused')
      expect(keys).not.toHaveProperty('sdk.status.on')
    })
  })

  describe('declarations read through an import (#330)', () => {
    it('should resolve the names inside an imported declaration in the file that declares them', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/api.ts', '/src/App.tsx', '/src/other-api.ts'])
      vol.fromJSON({
        '/src/api.ts': `
          export interface components {
            schemas: {
              Foo: { type: string; status?: 'A' | 'B' };
              Bar: Omit<components['schemas']['Foo'], 'type'> & { type: 'BAR' };
            };
          }
        `,
        // openapi-typescript names the root of every generated client \`components\`
        '/src/other-api.ts': "export interface components { schemas: { Foo: { status: 'X' } } }",
        '/src/App.tsx': `
          import { components as api } from './api';
          import * as ns from './api';
          declare const bar: api['schemas']['Bar'];
          declare const nsBar: ns.components['schemas']['Bar'];
          t(\`status.\${bar.status}\`);
          t(\`ns.\${nsBar.status}\`);
        `,
      })

      const keys = await extractKeys()
      expect(keys).toEqual({ status: { A: 'status.A', B: 'status.B' }, ns: { A: 'ns.A', B: 'ns.B' } })
    })

    it('should not resolve them to a same-named declaration of the importing file', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockResolvedValue(['/src/types.ts', '/src/App.tsx'])
      vol.fromJSON({
        '/src/types.ts': `
          type Status = 'A' | 'B';
          export interface Api { Bar: { status: Status } }
          export type Base<T> = { type: T; status: Status };
        `,
        '/src/App.tsx': `
          import { Api, Base } from './types';
          type Status = 'X';
          declare const bar: Api['Bar'];
          declare const base: Base<'BASE'>;
          t(\`indexed.\${bar.status}\`);
          t(\`generic.\${base.status}\`);
        `,
      })

      const keys = await extractKeys()
      expect(keys).toEqual({ indexed: { A: 'indexed.A', B: 'indexed.B' }, generic: { A: 'generic.A', B: 'generic.B' } })
    })
  })

  describe('type declarations inside node_modules (issue #213)', () => {
    it('should scan node_modules when an input pattern explicitly targets it', async () => {
      const { glob } = await import('glob')
      ;(glob as any).mockImplementation(async (_patterns: any, options: any) => {
        // Reproduce glob's filtering so the default ignore is actually exercised
        const all = ['/node_modules/@acme/api-sdk/dist/index.d.ts', '/src/App.tsx']
        const ignore: string[] = options?.ignore ?? []
        return ignore.includes('node_modules/**')
          ? all.filter(p => !p.includes('node_modules'))
          : all
      })
      vol.fromJSON({
        '/node_modules/@acme/api-sdk/dist/index.d.ts': "export type ResourceStatus = 'active' | 'paused';",
        '/src/App.tsx': `
          import { ResourceStatus } from '@acme/api-sdk';
          declare const s: ResourceStatus;
          t(\`sdk.status.\${s}\`);
        `,
      })

      const config: I18nextToolkitConfig = {
        ...mockConfig,
        extract: {
          ...mockConfig.extract,
          input: ['src/**/*.{ts,tsx}', 'node_modules/@acme/api-sdk/dist/*.d.ts'],
        },
      }

      const keys = await extractKeys(config)
      expect(keys).toHaveProperty('sdk.status.active')
      expect(keys).toHaveProperty('sdk.status.paused')
    })

    it('should keep ignoring node_modules when no input pattern mentions it', async () => {
      const { glob } = await import('glob')
      let sourceGlobIgnore: string[] | undefined
      ;(glob as any).mockImplementation(async (patterns: any, options: any) => {
        if (Array.isArray(patterns) && patterns[0] === 'src/**/*.{ts,tsx}') sourceGlobIgnore = options?.ignore
        return ['/src/App.tsx']
      })
      vol.fromJSON({
        '/src/App.tsx': `
          declare const s: ResourceStatus;
          t(\`sdk.status.\${s}\`);
        `,
      })

      const keys = await extractKeys()
      expect(sourceGlobIgnore).toContain('node_modules/**')
      // The union is unresolvable, so nothing is written at all
      expect(keys).toBeUndefined()
    })
  })
})
