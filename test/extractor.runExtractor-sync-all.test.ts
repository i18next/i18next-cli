import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import { resolve } from 'node:path'
import { vol } from 'memfs'
import { glob } from 'glob'
import type { I18nextToolkitConfig } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

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

describe('extractor: --sync-all', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  it('should update primary from code defaults and clear secondary translations when syncAll is true', async () => {
    vol.fromJSON({
      '/src/app.ts': `
        import { t } from 'i18next'
        const title = t('app.title', 'Primary Default')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    // Prepopulate existing translations where DE already has a (now incorrect) translation
    vol.fromJSON({
      [enPath]: JSON.stringify({ app: { title: 'Old EN' } }, null, 2),
      [dePath]: JSON.stringify({ app: { title: 'Alte DE' } }, null, 2),
    })

    vi.mocked(glob).mockResolvedValue(['/src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true, syncAll: true })
    expect(result.anyFileUpdated).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({ app: { title: 'Primary Default' } })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    // syncAll should clear the secondary translation (use configured default empty string)
    expect(deContent).toEqual({ app: { title: '' } })
  })

  it('should be idempotent across repeated syncAll runs for keyPrefix-derived defaults', async () => {
    const appPath = '/src/App.tsx'
    const keyPrefixPath = '/src/KeyPrefix.tsx'
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [appPath]: `
        import KeyPrefix from './KeyPrefix'

        export default function App() {
          return <KeyPrefix />
        }
      `,
      [keyPrefixPath]: `
        import { useTranslation } from 'react-i18next'

        export default function KeyPrefix() {
          const { t } = useTranslation('translation', { keyPrefix: 'nested' })
          return <>{t('key')}</>
        }
      `,
    })

    vi.mocked(glob).mockResolvedValue([appPath, keyPrefixPath])

    const firstRun = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true, syncAll: true })
    expect(firstRun.anyFileUpdated).toBe(true)

    const enAfterFirstRun = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    const deAfterFirstRun = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)

    expect(enAfterFirstRun).toEqual({ nested: { key: '' } })
    expect(deAfterFirstRun).toEqual({ nested: { key: '' } })

    const secondRun = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true, syncAll: true })

    const enAfterSecondRun = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    const deAfterSecondRun = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)

    expect(secondRun.anyFileUpdated).toBe(false)
    expect(enAfterSecondRun).toEqual(enAfterFirstRun)
    expect(deAfterSecondRun).toEqual(deAfterFirstRun)
  })

  it('should trust derived defaults during syncAll when trustDerivedDefaults is enabled', async () => {
    const appPath = '/src/App.tsx'
    const keyPrefixPath = '/src/KeyPrefix.tsx'
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [appPath]: `
        import KeyPrefix from './KeyPrefix'

        export default function App() {
          return <KeyPrefix />
        }
      `,
      [keyPrefixPath]: `
        import { useTranslation } from 'react-i18next'

        export default function KeyPrefix() {
          const { t } = useTranslation('translation', { keyPrefix: 'nested' })
          return <>{t('key')}</>
        }
      `,
    })

    vi.mocked(glob).mockResolvedValue([appPath, keyPrefixPath])

    const firstRun = await runExtractor(mockConfig, {
      syncPrimaryWithDefaults: true,
      syncAll: true,
      trustDerivedDefaults: true,
    })
    expect(firstRun.anyFileUpdated).toBe(true)

    const enAfterFirstRun = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    const deAfterFirstRun = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)

    expect(enAfterFirstRun).toEqual({ nested: { key: 'key' } })
    expect(deAfterFirstRun).toEqual({ nested: { key: '' } })

    const secondRun = await runExtractor(mockConfig, {
      syncPrimaryWithDefaults: true,
      syncAll: true,
      trustDerivedDefaults: true,
    })

    const enAfterSecondRun = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    const deAfterSecondRun = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)

    expect(secondRun.anyFileUpdated).toBe(false)
    expect(enAfterSecondRun).toEqual(enAfterFirstRun)
    expect(deAfterSecondRun).toEqual(deAfterFirstRun)
  })

  it('should preserve secondary translations for trusted derived defaults when the primary value is already up to date', async () => {
    const appPath = '/src/App.tsx'
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [appPath]: `
        import { t } from 'i18next'
        const title = t('my new text')
      `,
      [enPath]: JSON.stringify({ 'my new text': 'my new text' }, null, 2),
      [dePath]: JSON.stringify({ 'my new text': 'Mein neuer Text' }, null, 2),
    })

    vi.mocked(glob).mockResolvedValue([appPath])

    const result = await runExtractor(mockConfig, {
      syncPrimaryWithDefaults: true,
      syncAll: true,
      trustDerivedDefaults: true,
    })

    expect(result.anyFileUpdated).toBe(false)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)

    expect(enContent).toEqual({ 'my new text': 'my new text' })
    expect(deContent).toEqual({ 'my new text': 'Mein neuer Text' })
  })
})
