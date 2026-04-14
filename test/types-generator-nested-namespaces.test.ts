import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import { resolve } from 'node:path'
import { runTypesGenerator } from '../src/types-generator'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

describe('types-generator with nested namespaces (basePath)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/project')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('basePath support', () => {
    it('should resolve nested namespaces when basePath is provided', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/public/locales/en/common.json',
        '/project/public/locales/en/dashboard.json',
        '/project/public/locales/en/dashboard/user.json',
        '/project/public/locales/en/dashboard/settings.json',
        '/project/public/locales/en/features/auth/login.json'
      ])

      vol.fromJSON({
        '/project/public/locales/en/common.json': JSON.stringify({ key: 'value' }),
        '/project/public/locales/en/dashboard.json': JSON.stringify({ title: 'Dashboard' }),
        '/project/public/locales/en/dashboard/user.json': JSON.stringify({ name: 'User Name' }),
        '/project/public/locales/en/dashboard/settings.json': JSON.stringify({ title: 'Settings' }),
        '/project/public/locales/en/features/auth/login.json': JSON.stringify({ button: 'Login' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'public/locales/{{language}}/{{namespace}}.json',
        },
        types: {
          input: 'public/locales/en/**/*.json',
          basePath: 'public/locales/en',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"common"')
      expect(content).toContain('"dashboard"')
      expect(content).toContain('"dashboard/user"')
      expect(content).toContain('"dashboard/settings"')
      expect(content).toContain('"features/auth/login"')
    })

    it('should support basePath with {{language}} placeholder', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/translations/common.json',
        '/project/locales/en/translations/admin/users.json'
      ])

      vol.fromJSON({
        '/project/locales/en/translations/common.json': JSON.stringify({ key: 'value' }),
        '/project/locales/en/translations/admin/users.json': JSON.stringify({ title: 'Users' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/{{language}}/translations/{{namespace}}.json',
        },
        types: {
          input: 'locales/en/translations/**/*.json',
          basePath: 'locales/{{language}}/translations',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"common"')
      expect(content).toContain('"admin/users"')
    })
  })

  describe('Backwards compatibility', () => {
    it('should use filename-only namespaces when basePath is not provided', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/common.json',
        '/project/locales/en/user.json'
      ])

      vol.fromJSON({
        '/project/locales/en/common.json': JSON.stringify({ key: 'value' }),
        '/project/locales/en/user.json': JSON.stringify({ name: 'User' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/en/*.json',
        },
        types: {
          input: ['locales/en/*.json'], // No basePath
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"common"')
      expect(content).toContain('"user"')
      expect(content).toMatch(/"common":\s*\{/)
      expect(content).toMatch(/"user":\s*\{/)
      expect(content).not.toContain('"common/')
      expect(content).not.toContain('"user/')
      expect(content).not.toContain('"dashboard/')
    })

    it('should work with array of glob patterns (legacy behavior)', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/common.json',
        '/project/locales/en/errors.json'
      ])

      vol.fromJSON({
        '/project/locales/en/common.json': JSON.stringify({ key: 'value' }),
        '/project/locales/en/errors.json': JSON.stringify({ error: 'Error message' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/en/*.json',
        },
        types: {
          input: ['locales/en/common.json', 'locales/en/errors.json'],
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"common"')
      expect(content).toContain('"errors"')
    })
  })

  describe('Edge cases', () => {
    it('should handle deeply nested directory structures', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/a/b/c/d/deep.json'
      ])

      vol.fromJSON({
        '/project/locales/en/a/b/c/d/deep.json': JSON.stringify({ key: 'value' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/{{language}}/{{namespace}}.json',
        },
        types: {
          input: 'locales/en/**/*.json',
          basePath: 'locales/en',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"a/b/c/d/deep"')
    })

    it('should normalize paths to forward slashes for i18next', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/dashboard/user.json'
      ])

      vol.fromJSON({
        '/project/locales/en/dashboard/user.json': JSON.stringify({ name: 'User' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/{{language}}/{{namespace}}.json',
        },
        types: {
          input: 'locales/en/**/*.json',
          basePath: '/project/locales/en',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"dashboard/user"')
      expect(content).not.toContain('\\')
    })

    it('should handle mixed flat and nested namespaces', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/locales/en/common.json',
        '/project/locales/en/dashboard.json',
        '/project/locales/en/dashboard/user.json',
        '/project/locales/en/features/auth/login.json'
      ])

      vol.fromJSON({
        '/project/locales/en/common.json': JSON.stringify({ key: 'value' }),
        '/project/locales/en/dashboard.json': JSON.stringify({ title: 'Dashboard' }),
        '/project/locales/en/dashboard/user.json': JSON.stringify({ name: 'User' }),
        '/project/locales/en/features/auth/login.json': JSON.stringify({ button: 'Login' })
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/{{language}}/{{namespace}}.json',
        },
        types: {
          input: 'locales/en/**/*.json',
          basePath: 'locales/en',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"common"')
      expect(content).toContain('"dashboard"')
      expect(content).toContain('"dashboard/user"')
      expect(content).toContain('"features/auth/login"')
    })

    it('should handle empty directories gracefully', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([])

      vol.fromJSON({
        '/project/locales/en/.gitkeep': ''
      })

      const config: any = {
        locales: ['en'],
        extract: {
          primaryLanguage: 'en',
          output: 'locales/{{language}}/{{namespace}}.json',
        },
        types: {
          input: 'locales/en/**/*.json',
          basePath: 'locales/en',
          output: 'src/types/i18next.d.ts',
          resourcesFile: 'src/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('interface Resources')
    })
  })

  describe('Integration with mergeNamespaces', () => {
    it('should still support mergeNamespaces mode', async () => {
      const { glob } = await import('glob') as any

      ;(glob as any).mockResolvedValue([
        '/project/localization/translations/en.json'
      ])

      vol.fromJSON({
        '/project/localization/translations/en.json': JSON.stringify({
          translation: {
            addTerm: {
              tabTitle: 'Add clue'
            }
          },
          common: {
            button: 'Click me'
          }
        }, null, 2),
      })

      const config: any = {
        locales: ['en'],
        extract: {
          mergeNamespaces: true,
          primaryLanguage: 'en',
          output: 'localization/translations/{{language}}.json',
        },
        types: {
          enableSelector: true,
          input: 'localization/translations/en.json',
          output: 'localization/types/i18next.d.ts',
          resourcesFile: 'localization/types/resources.d.ts',
        },
      }

      await runTypesGenerator(config)

      const resourcesPath = resolve('/project', config.types.resourcesFile)
      const content = await vol.promises.readFile(resourcesPath, 'utf8')

      expect(content).toContain('"translation"')
      expect(content).toContain('"common"')
      expect(content).toContain('addTerm')
      expect(content).toContain('button')
    })
  })
})
