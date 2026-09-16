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

    it('should not let an alias shadow a type actually declared under that name', async () => {
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
      // Name-keyed resolution: the real `Status` declaration wins over the mirror.
      expect(keys).toHaveProperty('sdk.status.on')
      expect(keys).toHaveProperty('sdk.status.off')
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
