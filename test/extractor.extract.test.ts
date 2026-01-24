import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
// Fix import path based on actual module location
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

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

describe('extractor.extract - default', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) {
        return ['src/App.tsx']
      }
      if (typeof pattern === 'string' && pattern.startsWith('src/')) {
        return ['src/App.tsx']
      }
      if (typeof pattern === 'string' && pattern.startsWith('locales/')) {
        return []
      }
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
      'src/App.tsx': sampleCode,
    })

    const result = await extract(mockConfig)
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

    expect(pathEndsWith(result[0].path, '/locales/en/translation.json')).toBe(true)
    expect(pathEndsWith(result[1].path, '/locales/de/translation.json')).toBe(true)
  })
})

describe('extractor.extract - custom function and useTranslationNames', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
      if (Array.isArray(pattern) && pattern[0].startsWith('src/')) {
        return ['src/createDeclareKey.tsx', 'src/exampleConfig.tsx']
      }
      if (typeof pattern === 'string' && pattern.startsWith('src/')) {
        return ['src/createDeclareKey.tsx', 'src/exampleConfig.tsx']
      }
      if (typeof pattern === 'string' && pattern.startsWith('locales/')) {
        return []
      }
      return []
    })
  })

  it('extracts keys with custom function and useTranslationNames (issue #162)', async () => {
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{ts,tsx}'],
        output: 'locales/{{language}}/{{namespace}}.json',
        functions: ['t', '*.t', 'declareKey'],
        useTranslationNames: ['useTranslation', 'getT', 'useT', 'createDeclareKey'],
        defaultNS: 'translation',
      },
    }

    const createDeclareKeyCode = `
      export const createDeclareKey = (namespace, options) => {
        return { declareKey: (key) => key };
      };
    `
    const exampleConfigCode = `
      import { createDeclareKey } from "./createDeclareKey";
      const { declareKey } = createDeclareKey("use-case-1", { keyPrefix: "config" });
      export const exampleConfig = {
        value: declareKey("key")
      };
    `
    vol.fromJSON({
      'src/createDeclareKey.tsx': createDeclareKeyCode,
      'src/exampleConfig.tsx': exampleConfigCode,
    })

    const result = await extract(config)
    expect(result).toHaveLength(1)
    expect(pathEndsWith(result[0].path, '/locales/en/use-case-1.json')).toBe(true)
  })
})
