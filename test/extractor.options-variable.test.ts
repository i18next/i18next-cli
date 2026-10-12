import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const extract = async (files: Record<string, string>) => {
  vol.fromJSON(files)
  vi.mocked(glob).mockResolvedValue(Object.keys(files))
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.{ts,tsx}'], output: 'locales/{{language}}/{{namespace}}.json' },
  })
  return Object.fromEntries([...allKeys.values()].map(k => [k.key, k.defaultValue]))
}

// Another file's function-local array with the same name as a variable of app.tsx
const someFile = `
  function abc(x: string) {
    const overwrittenParams = [
      \`x=\${encodeURIComponent(x)}\`,
      \`y=true\`,
    ];
  }
`

describe('extractor: options passed in a variable (#307)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('reads the options of a variable like inline ones', async () => {
    expect(await extract({
      '/src/app.tsx': `
        import { useTranslation } from "react-i18next";

        export default function MyComponent() {
          const {t} = useTranslation();
          const count = 5;
          const params = { count };
          const overwrittenParams = { count };
          const withContext = { context: 'male', defaultValue: 'Hi' };
          return <>
            {t('incorrectlyOverwritten', overwrittenParams)}
            {t('incorrectlyNotPlural', params)}
            {t('correctlyPlural', { count: 5 })}
            {t('greeting', withContext)}
          </>;
        }
      `,
      '/src/some-file.ts': someFile,
    })).toEqual({
      correctlyPlural_one: 'correctlyPlural',
      correctlyPlural_other: 'correctlyPlural',
      greeting_male: 'Hi',
      incorrectlyNotPlural_one: 'incorrectlyNotPlural',
      incorrectlyNotPlural_other: 'incorrectlyNotPlural',
      incorrectlyOverwritten_one: 'incorrectlyOverwritten',
      incorrectlyOverwritten_other: 'incorrectlyOverwritten',
    })
  })

  it('never takes a default value from another file\'s same-named variable', async () => {
    expect(await extract({
      '/src/app.ts': `
        const overwrittenParams = getParams();
        t('key', overwrittenParams);
      `,
      '/src/some-file.ts': someFile,
    })).toEqual({ key: 'key' })
  })
})
