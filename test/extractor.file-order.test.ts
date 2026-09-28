import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin } from '../src/index'
import { ASTVisitors } from '../src/extractor/core/ast-visitors'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const config = (): I18nextToolkitConfig => ({
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t', '*.t', 'tProps.*', 'TranslatedError'],
  },
})

const defaultsOf = (allKeys: Map<string, any>) =>
  Object.fromEntries([...allKeys.values()].map(k => [k.key, k.defaultValue]))

describe('extractor: file order and extraction-site prescreen', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('picks the same default for a conflicting key whatever order glob returns (#296)', async () => {
    vol.fromJSON({
      '/src/a.tsx': "t('shared.key', 'Adding...')",
      '/src/b.tsx': "t('shared.key', 'Importing...')",
    })

    vi.mocked(glob).mockResolvedValue(['/src/b.tsx', '/src/a.tsx'])
    const first = defaultsOf((await findKeys(config())).allKeys)
    vi.mocked(glob).mockResolvedValue(['/src/a.tsx', '/src/b.tsx'])
    const second = defaultsOf((await findKeys(config())).allKeys)

    expect(first).toEqual({ 'shared.key': 'Adding...' })
    expect(second).toEqual(first)
  })

  it('skips the extraction walk for files without a trigger token, but not their types (#297)', async () => {
    const files = {
      '/src/model.ts': "export type Scope = 'local' | 'remote'",
      '/src/util.ts': "// don't translate this\nexport const at = (s: string) => s.at(0)",
      // eslint-disable-next-line no-template-curly-in-string
      '/src/dashboard.ts': "import type { Scope } from './model'\nexport const f = (scope: Scope) => t(`prefix.${scope}`)",
      '/src/hook.tsx': "const { t: translate } = useTranslation()\ntranslate('hook.key')",
      '/src/fixed.ts': "const tt = i18next.getFixedT(null, 'ns')\ntt('fixed.key')",
      '/src/typed.ts': "export const g = (tr: TFunction<'typed'>) => tr('typed.key')",
      '/src/member.ts': "i18n\n  .t('member.key')",
      '/src/optional.ts': "i18n.t?.('optional.key')",
      '/src/props.ts': "tProps.label('props.key')",
      '/src/error.ts': "throw new TranslatedError('error.key')",
      '/src/comment.ts': "// t('comment.key')",
      '/src/trans.tsx': 'export const C = () => <Trans i18nKey="trans.key" />',
    }
    vol.fromJSON(files)
    vi.mocked(glob).mockResolvedValue(Object.keys(files))
    const visit = vi.spyOn(ASTVisitors.prototype, 'visit')

    const { allKeys } = await findKeys(config())

    expect([...allKeys.values()].map(k => k.key).sort()).toEqual([
      'comment.key', 'error.key', 'fixed.key', 'hook.key', 'member.key', 'optional.key',
      'prefix.local', 'prefix.remote', 'props.key', 'trans.key', 'typed.key',
    ])
    expect(visit).toHaveBeenCalledTimes(Object.keys(files).length - 2)
  })

  it('still walks token-free files when a plugin visits nodes', async () => {
    vol.fromJSON({ '/src/model.ts': "export const LABEL = 'from.plugin'" })
    vi.mocked(glob).mockResolvedValue(['/src/model.ts'])
    const plugin: Plugin = {
      name: 'const-keys',
      onVisitNode (node: any, ctx) {
        if (node.type === 'StringLiteral') ctx.addKey({ key: node.value })
      },
    }

    const { allKeys } = await findKeys({ ...config(), plugins: [plugin] })

    expect([...allKeys.values()].map(k => k.key)).toEqual(['from.plugin'])
  })
})
