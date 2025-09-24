import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/extractor/index'
import type { I18nextToolkitConfig } from '../src/types'

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
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
}

describe('extractor: advanced Trans features', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('should handle the "ns" prop on the Trans component', async () => {
    const sampleCode = '<Trans i18nKey="button.save" ns="common">Save</Trans>'
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const commonFile = results.find(r => r.path.endsWith('/locales/en/common.json'))

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({
      button: {
        save: 'Save',
      },
    })
  })

  it('should extract children as key and get ns from t prop', async () => {
    const sampleCode = `
      import React from 'react';
      import { Trans, useTranslation } from 'react-i18next'

      function MyComponent() {
        const { t } = useTranslation('myNamespace');

        return <Trans t={t}>Hello World</Trans>;
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const myNamespaceFile = results.find(r => r.path.endsWith('/locales/en/myNamespace.json'))

    expect(myNamespaceFile).toBeDefined()
    expect(myNamespaceFile!.newTranslations).toEqual({
      'Hello World': 'Hello World',
    })
  })

  it('should generate plural keys when Trans component has a count prop', async () => {
    const sampleCode = `
      <Trans i18nKey="userMessagesUnread" count={count}>
        Hello <strong>{{name}}</strong>, you have {{count}} unread message.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = 'Hello <strong>{{name}}</strong>, you have {{count}} unread message.'

    expect(translationFile!.newTranslations).toEqual({
      userMessagesUnread_one: expectedDefaultValue,
      userMessagesUnread_other: expectedDefaultValue,
    })
  })

  it('should generate plural keys when Trans component has a count prop and complex children', async () => {
    const sampleCode = `
      const { t } = useTranslation('translation');
      <Trans i18nKey="userMessagesUnread" count={count}>
        Hello <div title={t('nameTitle')}>{{name}}</div>, you have {{count}} unread message. <Link to="/msgs">Go to messages</Link>.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    // The serializer now produces the correct indexed output based on the children's array positions
    // <div> is at index 1, <Link> is at index 5
    const expectedDefaultValue = 'Hello <1>{{name}}</1>, you have {{count}} unread message. <5>Go to messages</5>.'

    // This also correctly extracts the key from the `title` prop inside the Trans component
    expect(translationFile!.newTranslations).toEqual({
      nameTitle: 'nameTitle',
      userMessagesUnread_one: expectedDefaultValue,
      userMessagesUnread_other: expectedDefaultValue,
    })
  })
})
