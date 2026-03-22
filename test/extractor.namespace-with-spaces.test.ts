import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

// Mock the 'fs/promises' module to use our in-memory file system from 'memfs'
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock the 'glob' module to control which files it "finds"
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

describe('extractor: namespaces with spaces (#221)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    vi.spyOn(process, 'cwd').mockReturnValue('/')

    const { glob } = await import('glob')
    vi.mocked(glob).mockImplementation(async () => {
      const candidates = ['/src/App.tsx']
      return candidates.filter(p => vol.existsSync(p))
    })
  })

  it('should support namespaces with spaces from useTranslation', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      export default function Example() {
        const { t } = useTranslation(['Generic category']);
        return <div>{t('I do not get found!')}</div>;
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        keySeparator: false,
        nsSeparator: false,
        defaultNS: 'Example',
      },
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/Generic category.json'))
    const defaultFile = results.find(r => pathEndsWith(r.path, '/locales/en/Example.json'))

    // The key should be in the "Generic category" namespace file
    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'I do not get found!': 'I do not get found!',
    })

    // The default namespace file should NOT exist (no keys for it)
    expect(defaultFile).toBeUndefined()
  })

  it('should support namespaces with spaces from explicit ns option', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      export default function Example() {
        const { t } = useTranslation();
        return (
          <div>
            <h1>{t('I still do not get found!', { ns: 'Example two' })}</h1>
            <h1>{t('Yay, you found me!', { ns: 'ExampleTwo' })}</h1>
          </div>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        keySeparator: false,
        nsSeparator: false,
        defaultNS: 'Example',
      },
    }

    const results = await extract(config)
    const exampleTwoSpaced = results.find(r => pathEndsWith(r.path, '/locales/en/Example two.json'))
    const exampleTwo = results.find(r => pathEndsWith(r.path, '/locales/en/ExampleTwo.json'))

    expect(exampleTwoSpaced).toBeDefined()
    expect(exampleTwoSpaced!.newTranslations).toEqual({
      'I still do not get found!': 'I still do not get found!',
    })

    expect(exampleTwo).toBeDefined()
    expect(exampleTwo!.newTranslations).toEqual({
      'Yay, you found me!': 'Yay, you found me!',
    })
  })

  it('should still prevent natural language keys from being split by nsSeparator', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      export default function Example() {
        const { t } = useTranslation();
        return <div>{t('Error message: something went wrong')}</div>;
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        defaultNS: 'translation',
      },
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    // "Error message: something went wrong" should NOT be split into
    // namespace "Error message" + key "something went wrong"
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toHaveProperty('Error message: something went wrong')

    // There should be no "Error message" namespace file
    const errorFile = results.find(r => pathEndsWith(r.path, '/locales/en/Error message.json'))
    expect(errorFile).toBeUndefined()
  })

  it('should reproduce the full scenario from issue #221', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';

      export default function Example() {
        const { t } = useTranslation(['Generic category']);
        const { t: t2 } = useTranslation(['IContainNoSpaces']);

        return (
          <div>
            <h1>{t('I do not get found!')}</h1>
            <h1>{t('I do get found!', { ns: 'Common' })}</h1>
            <h1>{t('I still do not get found!', { ns: 'Example two' })}</h1>
            <h1>{t('Yay, you found me!', { ns: 'ExampleTwo' })}</h1>
            <h1>{t2('I contain no spaces, and therefore the prefix behaviour is correct')}</h1>
          </div>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        keySeparator: false,
        nsSeparator: false,
        defaultNS: 'Example',
      },
    }

    const results = await extract(config)

    const genericCategory = results.find(r => pathEndsWith(r.path, '/locales/en/Generic category.json'))
    const common = results.find(r => pathEndsWith(r.path, '/locales/en/Common.json'))
    const exampleTwo = results.find(r => pathEndsWith(r.path, '/locales/en/Example two.json'))
    const exampleTwoNoSpaces = results.find(r => pathEndsWith(r.path, '/locales/en/ExampleTwo.json'))
    const noSpaces = results.find(r => pathEndsWith(r.path, '/locales/en/IContainNoSpaces.json'))
    const defaultNs = results.find(r => pathEndsWith(r.path, '/locales/en/Example.json'))

    // Namespaces with spaces should work correctly
    expect(genericCategory).toBeDefined()
    expect(genericCategory!.newTranslations).toEqual({
      'I do not get found!': 'I do not get found!',
    })

    expect(exampleTwo).toBeDefined()
    expect(exampleTwo!.newTranslations).toEqual({
      'I still do not get found!': 'I still do not get found!',
    })

    // Namespaces without spaces should still work
    expect(common).toBeDefined()
    expect(common!.newTranslations).toEqual({
      'I do get found!': 'I do get found!',
    })

    expect(exampleTwoNoSpaces).toBeDefined()
    expect(exampleTwoNoSpaces!.newTranslations).toEqual({
      'Yay, you found me!': 'Yay, you found me!',
    })

    expect(noSpaces).toBeDefined()
    expect(noSpaces!.newTranslations).toEqual({
      'I contain no spaces, and therefore the prefix behaviour is correct':
        'I contain no spaces, and therefore the prefix behaviour is correct',
    })

    // The default namespace should NOT contain any keys with namespace prefixes
    expect(defaultNs).toBeUndefined()
  })
})
