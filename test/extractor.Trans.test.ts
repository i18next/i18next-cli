import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'

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

  it('should use ns from key instead of t prop', async () => {
    const sampleCode = `
      import React from 'react';
      import { Trans, useTranslation } from 'react-i18next'

      function MyComponent() {
        const { t } = useTranslation('myNamespace');

        return <Trans t={t} i18nKey="myOtherNamespace:myKey">Hello World</Trans>;
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const myNamespaceFile = results.find(r => r.path.endsWith('/locales/en/myOtherNamespace.json'))

    expect(myNamespaceFile).toBeDefined()
    expect(myNamespaceFile!.newTranslations).toEqual({
      myKey: 'Hello World',
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

  it('should extract Trans with inline <code> and t(...) calls in the same file', async () => {
    const sampleCode = `
      import React from 'react';
      import { useTranslation, Trans } from 'react-i18next';

      function Comp1() {
        const { t } = useTranslation();

        return (
          <div className="App">
            <p>
              <Trans i18nKey="title">
                Welcome to react using <code>react-i18next</code> fully type-safe
              </Trans>
            </p>
            <p>{t('description.part1')}</p>
            <p>{t('description.part2')}</p>
          </div>
        );
      }

      export default Comp1;
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedTitle = 'Welcome to react using <1>react-i18next</1> fully type-safe'

    expect(translationFile!.newTranslations).toEqual({
      title: expectedTitle,
      description: {
        part1: 'description.part1',
        part2: 'description.part2',
      },
    })
  })

  it('should extract all possible keys with a ternary i18nKey', async () => {
    const sampleCode = `
          const isOpen = true;
          t('open', 'Open');
          t('closed', 'Closed');
          
          const Component = () => {
            return <Trans i18nKey={isOpen ? 'open' : 'closed'} />;
          }
        `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile!.newTranslations).toEqual({
      open: 'Open',
      closed: 'Closed',
    })
  })

  it('should extract all possible keys from a ternary in the context prop', async () => {
    const sampleCode = `
        const isMale = true;
        <Trans i18nKey="friend" context={isMale ? 'male' : 'female'}>A friend</Trans>
      `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile!.newTranslations).toEqual({
      friend: 'A friend',
      friend_male: 'A friend',
      friend_female: 'A friend',
    })
  })

  it('should extract plural-specific default values from tOptions', async () => {
    const sampleCode = `
      <Trans i18nKey="item" count={count} tOptions={{ defaultValue_other: "Items" }}>
        Item
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => r.path.endsWith('/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    expect(translationFile!.newTranslations).toEqual({
      item_one: 'Item',
      item_other: 'Items',
    })
  })

  it('should find ns and context from the tOptions prop as a fallback', async () => {
    const sampleCode = `
      <Trans 
        i18nKey="myKey" 
        tOptions={{ 
          ns: 'my-ns', 
          context: 'male' 
        }}
      >
        A value
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)

    // It should extract to 'my-ns', not the default 'translation'
    const myNsFile = results.find(r => r.path.endsWith('/locales/en/my-ns.json'))

    expect(myNsFile).toBeDefined()
    // It should apply the context suffix
    expect(myNsFile!.newTranslations).toEqual({
      myKey_male: 'A value',
    })
  })

  it('should handle both context and count props together on Trans component', async () => {
    const sampleCode = `
      <Trans
        ns="event"
        i18nKey="confirm-cancellation-page.body.text.description"
        context={
          isLate
            ? 'late'
            : eventType === EventType.GROUP
            ? 'group'
            : undefined
        }
        count={numberOfHoursLeftToCancel}
      >
        Default text
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const eventFile = results.find(r => r.path.endsWith('/locales/en/event.json'))

    expect(eventFile).toBeDefined()
    expect(eventFile!.newTranslations).toEqual({
      'confirm-cancellation-page': {
        body: {
          text: {
            // Base plural forms (no context)
            description_one: 'Default text',
            description_other: 'Default text',
            // Context + plural combinations
            description_group_one: 'Default text',
            description_group_other: 'Default text',
            description_late_one: 'Default text',
            description_late_other: 'Default text',
          },
        },
      },
    })
  })
})
