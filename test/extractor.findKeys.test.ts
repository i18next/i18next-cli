import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/extractor'
import type { I18nextToolkitConfig } from '../src/types'

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
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
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
    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    const keys = await findKeys(mockConfig)
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
})
