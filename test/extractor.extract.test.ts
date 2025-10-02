import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
// Fix import path based on actual module location
import { extract } from '../src/index' // Verify this path exists
import type { I18nextToolkitConfig } from '../src/index'

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

describe('extractor.extract', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    // Use consistent file paths
    // Make the glob mock conditional and more realistic
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      // If glob is looking for source files, return the source file.
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) {
        return ['src/App.tsx']
      }
      // If glob is looking for existing translation files (from translation-manager),
      // check the virtual file system. In this test, none exist, so return empty.
      if (typeof pattern === 'string' && pattern.startsWith('locales/')) {
        return []
      }
      // Default fallback
      return []
    })
  })

  it('creates locale files with primary defaults and empty secondary values', async () => {
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
      'src/App.tsx': sampleCode, // Remove leading slash for consistency
    })

    const result = await extract(mockConfig)
    // Use Vitest assertion syntax
    expect(result).toHaveLength(2)

    const enJson = result[0].newTranslations
    const deJson = result[1].newTranslations

    expect(enJson).toEqual({
      app: {
        description: 'This is a <strong>description</strong>.',
        title: 'Welcome!',
      },
    })

    expect(deJson).toEqual({
      app: {
        description: '',
        title: '',
      },
    })
  })
})
