import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

// Mocks
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
    defaultNS: 'common',
  },
}

describe('extractor: next-i18next useT/getT support (#232)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should extract keys into namespace from useT (client component)', async () => {
    const sampleCode = `
      'use client'
      import { useT } from 'next-i18next/client'

      export default function TodoPage() {
        const { t } = useT('todos')
        return (
          <div>
            <input placeholder={t('addPlaceholder', 'What needs to be done?')} />
            <button>{t('addButton', 'Add')}</button>
          </div>
        )
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const todosFile = results.find(r => pathEndsWith(r.path, '/locales/en/todos.json'))
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(todosFile).toBeDefined()
    expect(todosFile!.newTranslations).toEqual({
      addPlaceholder: 'What needs to be done?',
      addButton: 'Add',
    })
    // Should NOT end up in common (default) namespace
    expect(commonFile?.newTranslations?.addPlaceholder).toBeUndefined()
  })

  it('should extract keys into namespace from getT (server component)', async () => {
    const sampleCode = `
      import { getT } from 'next-i18next/server'

      export default async function TodoPage() {
        const { t } = await getT('todos')
        return (
          <div>
            <h1>{t('title', 'My Todos')}</h1>
            <p>{t('description', 'Manage your tasks')}</p>
          </div>
        )
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const todosFile = results.find(r => pathEndsWith(r.path, '/locales/en/todos.json'))
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(todosFile).toBeDefined()
    expect(todosFile!.newTranslations).toEqual({
      title: 'My Todos',
      description: 'Manage your tasks',
    })
    expect(commonFile?.newTranslations?.title).toBeUndefined()
  })

  it('should use default namespace when useT is called without namespace', async () => {
    const sampleCode = `
      'use client'
      import { useT } from 'next-i18next/client'

      export default function Header() {
        const { t } = useT()
        return <h1>{t('appTitle', 'My App')}</h1>
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({
      appTitle: 'My App',
    })
  })

  it('should use default namespace when getT is called without namespace', async () => {
    const sampleCode = `
      import { getT } from 'next-i18next/server'

      export default async function Header() {
        const { t } = await getT()
        return <h1>{t('appTitle', 'My App')}</h1>
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({
      appTitle: 'My App',
    })
  })

  it('should handle useT with keyPrefix option', async () => {
    const sampleCode = `
      'use client'
      import { useT } from 'next-i18next/client'

      export default function TodoForm() {
        const { t } = useT('todos', { keyPrefix: 'form' })
        return <button>{t('submit', 'Submit')}</button>
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const todosFile = results.find(r => pathEndsWith(r.path, '/locales/en/todos.json'))

    expect(todosFile).toBeDefined()
    expect(todosFile!.newTranslations).toEqual({
      form: {
        submit: 'Submit',
      },
    })
  })

  it('should handle getT with keyPrefix option', async () => {
    const sampleCode = `
      import { getT } from 'next-i18next/server'

      export default async function TodoForm() {
        const { t } = await getT('todos', { keyPrefix: 'form' })
        return <button>{t('submit', 'Submit')}</button>
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const todosFile = results.find(r => pathEndsWith(r.path, '/locales/en/todos.json'))

    expect(todosFile).toBeDefined()
    expect(todosFile!.newTranslations).toEqual({
      form: {
        submit: 'Submit',
      },
    })
  })

  it('should handle both useT and useTranslation in same file', async () => {
    const sampleCode = `
      'use client'
      import { useT } from 'next-i18next/client'
      import { useTranslation } from 'react-i18next'

      export default function Page() {
        const { t } = useT('todos')
        const { t: tCommon } = useTranslation('common')
        return (
          <div>
            <h1>{t('title', 'Todos')}</h1>
            <p>{tCommon('welcome', 'Welcome')}</p>
          </div>
        )
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const todosFile = results.find(r => pathEndsWith(r.path, '/locales/en/todos.json'))
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(todosFile).toBeDefined()
    expect(todosFile!.newTranslations).toEqual({ title: 'Todos' })

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({ welcome: 'Welcome' })
  })
})
