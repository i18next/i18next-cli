import { vol } from 'memfs'
import { normalize, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { I18nextToolkitConfig } from '../src/index'
import { runSyncer } from '../src/index'
import { runLinter } from '../src/linter'
import { getNamespaceFromOutputPath } from '../src/utils/file-utils'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const abs = (p: string) => resolve(process.cwd(), p)

// https://github.com/i18next/i18next-cli/issues/324
describe('namespace from the output template, not the file name', () => {
  it('reads the namespace where the template has it', () => {
    expect(getNamespaceFromOutputPath('locales/{{namespace}}/{{language}}.json', 'en', 'locales/common/en.json')).toBe('common')
    expect(getNamespaceFromOutputPath('locales/{{language}}/{{namespace}}.json', 'en', abs('locales/en/common.json'))).toBe('common')
    expect(getNamespaceFromOutputPath('locales/{{lng}}/{{namespace}}.flat.json', 'en', 'locales/en/common.flat.json')).toBe('common')
    expect(getNamespaceFromOutputPath('locales/{{language}}/{{namespace}}.json', 'en', 'locales/en/app.settings.json')).toBe('app.settings')
    expect(getNamespaceFromOutputPath((lng, ns) => `public/${ns}/${lng}.json`, 'en', 'public/home/en.json')).toBe('home')
    // no namespace in the template: the file name, as before
    expect(getNamespaceFromOutputPath('locales/{{language}}.json', 'en', 'locales/en.json')).toBe('en')
  })

  describe('with locales/{{namespace}}/{{language}}.json', () => {
    const config = (extra: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
      locales: ['en', 'de'],
      extract: { input: ['src/**/*.ts'], output: 'locales/{{namespace}}/{{language}}.json', ...extra },
    })

    beforeEach(async () => {
      vol.reset()
      vi.clearAllMocks()
      const { glob } = await import('glob')
      vi.mocked(glob).mockImplementation(async (pattern: any) => String(pattern).startsWith('locales/')
        ? Object.keys(vol.toJSON()).filter(p => p.endsWith('/en.json'))
        : [])
    })

    it('sync fills each namespace folder', async () => {
      vol.fromJSON({
        [abs('locales/common/en.json')]: JSON.stringify({ hello: 'Hello' }),
        [abs('locales/home/en.json')]: JSON.stringify({ title: 'Home' }),
      })

      await runSyncer(config())

      expect(JSON.parse(vol.readFileSync(abs('locales/common/de.json'), 'utf-8') as string)).toEqual({ hello: '' })
      expect(JSON.parse(vol.readFileSync(abs('locales/home/de.json'), 'utf-8') as string)).toEqual({ title: '' })
      expect(vol.existsSync(abs('locales/en/de.json'))).toBe(false)
    })

    it('lint checks the messages of each namespace', async () => {
      vol.fromJSON({ [abs('locales/common/en.json')]: JSON.stringify({ greeting: 'Hello {name' }) })

      const result = await runLinter(config({ messageFormat: 'icu' }))

      expect(result.files[normalize('locales/common/en.json')]?.map(i => i.text))
        .toEqual(['greeting: ICU syntax error: EXPECT_ARGUMENT_CLOSING_BRACE at column 7'])
    })
  })
})
