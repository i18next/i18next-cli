import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const config: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: 'messages/{{language}}.json',
    mergeNamespaces: true,
    defaultNS: 'shared',
    fallbackNS: 'shared',
  },
}

const existing = {
  shared: { back: 'Back' },
  'reset-page': { form: { title: 'Reset your password' } },
  'reset-email-page': { form: { title: 'Confirm your email' } },
}

async function run (code: string) {
  vol.fromJSON({
    '/src/Page.tsx': code,
    [`${process.cwd()}/messages/en.json`]: JSON.stringify(existing),
  })
  const { glob } = await import('glob')
  ;(glob as any).mockResolvedValue(['/src/Page.tsx'])
  const [result] = await extract(config)
  return result.newTranslations
}

// #299
describe('extractor: useTranslation with a conditional namespace', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('attributes keys to every branch namespace (string / array branches)', async () => {
    const out = await run(`
      export const Page = ({ confirmEmail }) => {
        const { t } = useTranslation(confirmEmail ? ['reset-email-page', 'reset-page'] : 'reset-page')
        return <h1>{t('form.title')}{t('shared:back')}</h1>
      }
    `)
    expect(out).toEqual(existing)
  })

  it('handles string branches and <Trans t={t}>', async () => {
    const out = await run(`
      export const Page = ({ confirmEmail }) => {
        const { t } = useTranslation(confirmEmail ? 'reset-email-page' : 'reset-page')
        return <><h1>{t('form.title')}{t('shared:back')}</h1><Trans t={t} i18nKey="form.hint">Hint</Trans></>
      }
    `)
    expect(out).toEqual({
      shared: { back: 'Back' },
      'reset-page': { form: { title: 'Reset your password', hint: 'Hint' } },
      'reset-email-page': { form: { title: 'Confirm your email', hint: 'Hint' } },
    })
  })
})
