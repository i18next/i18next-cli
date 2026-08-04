import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.tsx'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
  },
}

describe('extractor: locations with multi-byte characters (#276)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('reports char-based line/column when the file contains multi-byte chars', async () => {
    vol.fromJSON({
      '/src/App.tsx': `import { useTranslation } from "react-i18next";

/**
 * Component — uses em dashes (3-byte UTF-8 each)
 * café résumé naïve — more multi-byte chars
 * 日本語テスト — CJK characters (3 bytes each)
 * emoji: 🚀🎉 — 4-byte UTF-8 each
 */

export function MyComponent() {
  const { t } = useTranslation();

  return (
    <div>
        <div>{t("Test 123")}</div>
    </div>
  );
}
`,
    })

    const { allKeys } = await findKeys(mockConfig)
    const key = [...allKeys.values()].find((k: any) => k.key === 'Test 123')
    expect(key?.locations?.[0]).toEqual({ file: '/src/App.tsx', line: 15, column: 16 })
  })

  it('is unaffected by multi-byte chars in leading comments', async () => {
    vol.fromJSON({
      '/src/App.tsx': `// héllo — leading comment with multi-byte chars 🚀
import { useTranslation } from "react-i18next";

export function MyComponent() {
  const { t } = useTranslation();
  return <div>{t("Test 123")}</div>;
}
`,
    })

    const { allKeys } = await findKeys(mockConfig)
    const key = [...allKeys.values()].find((k: any) => k.key === 'Test 123')
    expect(key?.locations?.[0]).toEqual({ file: '/src/App.tsx', line: 6, column: 17 })
  })
})
