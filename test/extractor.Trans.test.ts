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
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

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
    const myNamespaceFile = results.find(r => pathEndsWith(r.path, '/locales/en/myNamespace.json'))

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
    const myNamespaceFile = results.find(r => pathEndsWith(r.path, '/locales/en/myOtherNamespace.json'))

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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    // The serializer now produces the correct indexed output based on the children's array positions
    // <div> is at index 1, <Link> is at index 6
    const expectedDefaultValue = 'Hello <1>{{name}}</1>, you have {{count}} unread message. <6>Go to messages</6>.'

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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile!.newTranslations).toEqual({
      friend: 'A friend',
      friend_male: 'A friend',
      friend_female: 'A friend',
    })
  })

  it('should extract all possible keys with a template string first argument', async () => {
    const sampleCode = `
          const isOpen = true;
  
          const Component = () => {
            return <Trans i18nKey={\`state.\${isDone ? 'done' : 'notDone'}.title\`}>Done</Trans>;
          }
        `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile!.newTranslations).toEqual({
      state: {
        done: {
          title: 'Done',
        },
        notDone: {
          title: 'Done',
        },
      },
    })
  })

  it('should extract all possible keys with nested expressions', async () => {
    const sampleCode = `
          const test = false;
          const state = 'unknown';
  
          <Trans i18nKey={test ? \`state.\${state === 'final' ? 'finalized' : \`\${state === 'pending' ? 'pending' : 'unknown'}\`}.title\` : 'state.test.title'}>State</Trans>;
        `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile!.newTranslations).toEqual({
      state: {
        finalized: {
          title: 'State',
        },
        pending: {
          title: 'State',
        },
        test: {
          title: 'State',
        },
        unknown: {
          title: 'State',
        },
      },
    })
  })

  it('should use defaults, components and values from Trans props', async () => {
    const sampleCode = `
      <Trans
        i18nKey="myKey"
        defaults="hello <italic>beautiful</italic> <bold>{{what}}</bold>"
        values={{ what: 'world' }}
        components={{ italic: <i />, bold: <strong /> }}
      />
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myKey: 'hello <italic>beautiful</italic> <bold>{{what}}</bold>',
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
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

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
    const myNsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-ns.json'))

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
    const eventFile = results.find(r => pathEndsWith(r.path, '/locales/en/event.json'))

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

  it('should extract variable placeholders from object expressions in Trans components', async () => {
    const sampleCode = `
      <Trans i18nKey="greeting">Hello {{name: userName}}, you have {{count: messageCount}} messages</Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      greeting: 'Hello {{name}}, you have {{count}} messages',
    })
  })

  it('should ignore boundary whitespace-only JSXText nodes so component indexes start at first meaningful child', async () => {
    const sampleCode = `
      <Trans i18nKey={'ticket_received_msg'} count={1}>
        <span className="font-extrabold">
          {{ username: item.userName }}
        </span>{' '}
        got{' '}
        <span className="font-extrabold text-brand">
          {{ count: 1 }}
        </span>{' '}
        ticket
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = '<0>{{username}}</0> got <4>{{count}}</4> ticket'

    expect(translationFile!.newTranslations).toEqual({
      ticket_received_msg_one: expectedDefaultValue,
      ticket_received_msg_other: expectedDefaultValue,
    })
  })

  it('should calculate correct index for children', async () => {
    const sampleCode = `
      <Trans i18nKey="children_receive_wrong_index">
        First line with empty JSXTextNode
        <p>
          <span>Span that should have index 1 but has index 0</span>
        </p>
        Second line
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = 'First line with empty JSXTextNode <p><1>Span that should have index 1 but has index 0</1></p> Second line'

    expect(translationFile!.newTranslations).toEqual({
      children_receive_wrong_index: expectedDefaultValue,
    })
  })

  it('should calculate correct index for children (with attr)', async () => {
    const sampleCode = `
      <Trans i18nKey="children_receive_wrong_index_attr">
        First line with empty JSXTextNode
        <a href="http://www.grafana.com">Span that should have index 1 but has index 0</a>
        Second line
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = 'First line with empty JSXTextNode <1>Span that should have index 1 but has index 0</1> Second line'

    expect(translationFile!.newTranslations).toEqual({
      children_receive_wrong_index_attr: expectedDefaultValue,
    })
  })

  it('should calculate correct index for children (next index)', async () => {
    const sampleCode = `
      <Trans i18nKey="children_receive_wrong_second_index">
        First line with empty JSXTextNode{' '}
        <a href="http://www.grafana.com">Span that should have index 2 but has index 0</a>
        Second line
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = 'First line with empty JSXTextNode <2>Span that should have index 2 but has index 0</2> Second line'

    expect(translationFile!.newTranslations).toEqual({
      children_receive_wrong_second_index: expectedDefaultValue,
    })
  })

  it('should handle explicit {" "} spacing and correct indexes', async () => {
    const sampleCode = `
      <Trans i18nKey={"ticket_two_received_msg"} count={1}>
        <span className="font-extrabold text-fg">
          {{ username: item.userName }}
        </span>{" "}
        got <span className="font-extrabold text-brand">{{ count: 1 }}</span>{" "}
        ticket
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = '<0>{{username}}</0> got <3>{{count}}</3> ticket'

    expect(translationFile!.newTranslations).toEqual({
      ticket_two_received_msg_one: expectedDefaultValue,
      ticket_two_received_msg_other: expectedDefaultValue,
    })
  })

  it('should handle explicit {" "} spacing and produce index 4 for the count element', async () => {
    const sampleCode = `
      <Trans i18nKey={"ticket_received_msg"} count={1}>
        <span className="font-extrabold text-fg">
          {{ username: item.userName }}
        </span>{" "}
        got{" "}
        <span className="font-extrabold text-brand">{{ count: 1 }}</span>{" "}
        ticket
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = '<0>{{username}}</0> got <4>{{count}}</4> ticket'

    expect(translationFile!.newTranslations).toEqual({
      ticket_received_msg_one: expectedDefaultValue,
      ticket_received_msg_other: expectedDefaultValue,
    })
  })

  it('should serialize mixed inline tags and preserve indexes for <pre> and nested text', async () => {
    const sampleCode = `
      <Trans i18nKey="children_receive_wronger_index">
        If you use a <pre variant="code">parse_mode</pre> option other than <pre variant="code">None</pre>,
        truncation may result in an invalid message, causing the notification to fail. For longer messages, we
        recommend using an alternative contact method.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      'If you use a <1>parse_mode</1> option other than <3>None</3>, truncation may result in an invalid message, causing the notification to fail. For longer messages, we recommend using an alternative contact method.'

    expect(translationFile!.newTranslations).toEqual({
      children_receive_wronger_index: expectedDefaultValue,
    })
  })

  it('should serialize code-wrapped placeholders and assign correct indexes for multiple code tags', async () => {
    const sampleCode = `
      <Trans i18nKey="children_receive_more_wronger_index" values={{ from: fromLabel, to: toLabel }}>
        <code>{'{{from}}'}</code> to <code>{'{{to}}'}</code>        
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = '<0>{{from}}</0> to <2>{{to}}</2>'

    expect(translationFile!.newTranslations).toEqual({
      children_receive_more_wronger_index: expectedDefaultValue,
    })
  })

  it('should handle Badge and TextLink placeholders and preserve indexes', async () => {
    const sampleCode = `
      <Trans i18nKey="another_children_receive_wrong_index">
        Maybe you mistyped the URL or the plugin with the id <Badge text={id} color="orange" /> is unavailable.
        <br />
        To see a list of available datasources please <TextLink href={ROUTES.AddNewConnection}>click here</TextLink>.
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      'Maybe you mistyped the URL or the plugin with the id <1></1> is unavailable.<br/>To see a list of available datasources please <5>click here</5>.'

    expect(translationFile!.newTranslations).toEqual({
      another_children_receive_wrong_index: expectedDefaultValue,
    })
  })

  it('should serialize nested inline tags inside a single <span> and assign correct indexes', async () => {
    const sampleCode = `
      <Trans i18nKey="another_children_receive_wrong_code_index">
        <span>
          Specifies the time column used for filtering. Defaults to the first tables <code>timeSpan</code> column,
          the first <code>datetime</code> column found or <code>TimeGenerated</code>.
        </span>
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      '<0>Specifies the time column used for filtering. Defaults to the first tables <1>timeSpan</1> column, the first <3>datetime</3> column found or <5>TimeGenerated</5>.</0>'

    expect(translationFile!.newTranslations).toEqual({
      another_children_receive_wrong_code_index: expectedDefaultValue,
    })
  })

  it('should serialize nested small/strong with correct indexes (1)', async () => {
    const sampleCode = `
      <Trans i18nKey="another_wrong_code_index_1">
        Your changes will be lost when you update the plugin.
        <br />
        <small>
          Use <strong>Save As</strong> to create custom version.
        </small>
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      'Your changes will be lost when you update the plugin.<br/><2>Use <strong>Save As</strong> to create custom version.</2>'

    expect(translationFile!.newTranslations).toEqual({
      another_wrong_code_index_1: expectedDefaultValue,
    })
  })

  it('should serialize small with single-line text and correct indexes (2)', async () => {
    const sampleCode = `
      <Trans i18nKey="another_wrong_code_index_2">
        A dashboard with the same name in selected folder already exists.
        <br />
        <small>Would you still like to save this dashboard?</small>
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      'A dashboard with the same name in selected folder already exists.<br/><2>Would you still like to save this dashboard?</2>'

    expect(translationFile!.newTranslations).toEqual({
      another_wrong_code_index_2: expectedDefaultValue,
    })
  })

  it('should serialize nested TextLink and span inside div with correct nested indexes (3)', async () => {
    const sampleCode = `
      <Trans i18nKey="another_wrong_code_index_3">
        <div>
          <TextLink href="https://grafana.com/docs/grafana/latest/dashboards/time-range-controls" external>
            Read the documentation
          </TextLink>
          <span> to find out more about how to enter custom time ranges.</span>
        </div>
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()

    const expectedDefaultValue = '<0><0>Read the documentation</0><1> to find out more about how to enter custom time ranges.</1></0>'

    expect(translationFile!.newTranslations).toEqual({
      another_wrong_code_index_3: expectedDefaultValue,
    })
  })
})
