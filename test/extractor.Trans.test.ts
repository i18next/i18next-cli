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

  it('should handle the "ns" prop as a string literal expression on the Trans component', async () => {
    const sampleCode = `
      <Fragment>
        <Trans i18nKey="button.save1" ns={"common"}>Save</Trans>
        <Trans i18nKey="button.save2" ns={\`common\`}>Save</Trans>
      </Fragment>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const commonFile = results.find(r => pathEndsWith(r.path, '/locales/en/common.json'))

    expect(commonFile).toBeDefined()
    expect(commonFile!.newTranslations).toEqual({
      button: {
        save1: 'Save',
        save2: 'Save',
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

  it('should use defaults as a string literal, from Trans props', async () => {
    const sampleCode = `
      <Trans
        i18nKey="myKey"
        defaults={"Hello!"}
      />
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myKey: 'Hello!',
    })
  })

  it('should use defaults as a simple template string literal, from Trans props', async () => {
    const sampleCode = `
      <Trans
        i18nKey="myKey"
        defaults={\`Hello!\`}
      />
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myKey: 'Hello!',
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

  it('should handle TextLink with explicit spacing and correct index', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey='SomeKey'>
            Some text{' '}
            <TextLink
              to='someUrl'
              target='_blank'
              rel='noreferrer'
              external
            >
              link
            </TextLink>
            .
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      SomeKey: 'Some text <2>link</2>.',
    })
  })

  it('should NOT extract space between text and component when separated by newline (formatting)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey='SomeKey'>
            Some text
            <TextLink
              to='someUrl'
              target='_blank'
              rel='noreferrer'
              external
            >
              link
            </TextLink>
            .
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // Should NOT have space before <2> because the newline is formatting whitespace
    expect(translationFile!.newTranslations).toEqual({
      SomeKey: 'Some text<1>link</1>.',
    })
  })

  it('should handle word split across component with newline formatting', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey='SomeKey'>
            I want to highlight part of this wo
            <SomeCustomHighlighting
              a
              lot
              of
              args
            >
              rd
            </SomeCustomHighlighting>
            .
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // Should NOT have space before <2> - the word "word" should be continuous
    expect(translationFile!.newTranslations).toEqual({
      SomeKey: 'I want to highlight part of this wo<1>rd</1>.',
    })
  })

  it('should handle br tag with surrounding text', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey='SomeKey'>
            Some text <br /> other text.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      SomeKey: 'Some text <br /> other text.',
    })
  })

  it('should handle nested paragraphs with inline elements and correct indexes', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans i18nKey="testme">
            <p>
              If you&apos;re having a problem or question about LosslessCut, please first check the links in the <b>Help</b> menu. If you cannot find any resolution, you may ask a question in <span className="link-button" role="button" onClick={() => electron.shell.openExternal('https://github.com/vaultrice/sdk/discussions')}>GitHub discussions</span> or on <span className="link-button" role="button" onClick={() => electron.shell.openExternal('https://github.com/vaultrice/sdk')}>Discord.</span>
            </p>
            <p>
              If you believe that you found a bug in LosslessCut, you may <span className="link-button" role="button" onClick={() => electron.shell.openExternal('https://github.com/vaultrice/sdk/issues')}>report a bug</span>.
            </p>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      testme: "<0>If you're having a problem or question about LosslessCut, please first check the links in the <1>Help</1> menu. If you cannot find any resolution, you may ask a question in <3>GitHub discussions</3> or on <5>Discord.</5></0><1>If you believe that you found a bug in LosslessCut, you may <1>report a bug</1>.</1>",
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
      'Maybe you mistyped the URL or the plugin with the id <1></1> is unavailable.<br />To see a list of available datasources please <5>click here</5>.'

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
      'Your changes will be lost when you update the plugin.<br /><2>Use <strong>Save As</strong> to create custom version.</2>'

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
      'A dashboard with the same name in selected folder already exists.<br /><2>Would you still like to save this dashboard?</2>'

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

  it('should serialize string literals', async () => {
    const sampleCode = `
      <Trans i18nKey="myKey">{"Hello!"}</Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myKey: 'Hello!',
    })
  })

  it('should serialize simple template string literals', async () => {
    const sampleCode = `
      <Trans i18nKey="myKey">{\`Hello pink\`} {\`fluffy \`}<strong>{\`world\`}</strong>!</Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myKey: 'Hello pink fluffy <strong>world</strong>!',
    })
  })

  it('should preserve spacing in self-closing tags like <br />', async () => {
    const sampleCode = `
      <Trans i18nKey='SomeKey'>
        SomeText
        <br />
        <br />
        Some other Text
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // Should preserve the space before the closing slash
    expect(translationFile!.newTranslations).toEqual({
      SomeKey: 'SomeText<br /><br />Some other Text',
    })
  })

  it('should NOT add space after <br /> with indented newline formatting', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';
      
      function Component() {
        return (
          <Trans i18nKey="message">
            First line.<br />
            Second line starts on new line.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      message: 'First line.<br />Second line starts on new line.',
    })
  })

  it('should NOT add space after <br /> when text continues on same indentation level', async () => {
    const sampleCode = `
      <Trans i18nKey="multiline">
        Line one
        <br />
        Line two
        <br />
        Line three
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      multiline: 'Line one<br />Line two<br />Line three',
    })
  })

  it('should handle <br /> with varying indentation correctly', async () => {
    const sampleCode = `
      <Trans i18nKey="address">
        John Doe
        <br />
        123 Main Street
        <br />
        City, State 12345
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      address: 'John Doe<br />123 Main Street<br />City, State 12345',
    })
  })

  it('should distinguish between <br /> with newline vs explicit space in complex case', async () => {
    const sampleCode = `
      <Trans i18nKey="mixed">
        Text before<br />
        Newline after br
        <br /> Space after this br
        Final text
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    // First br has newline (no space), second br has explicit space before next text
    expect(translationFile!.newTranslations).toEqual({
      mixed: 'Text before<br />Newline after br<br /> Space after this br Final text',
    })
  })

  it('should NOT add space after self-closing <br/> (no space before slash)', async () => {
    const sampleCode = `
      <Trans i18nKey="compact">
        First<br/>
        Second
      </Trans>
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      compact: 'First<br />Second',
    })
  })

  it('should handle inline component in middle of word (no newlines)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.inlineMiddle">
            wo<b>r</b>d
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        inlineMiddle: 'wo<1>r</1>d',
      },
    })
  })

  it('should handle inline component in middle of word (with newlines)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.inlineMiddleMultiline">
            wo
            <b>r</b>d
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        inlineMiddleMultiline: 'wo<1>r</1>d',
      },
    })
  })

  it('should handle component at start of text', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.componentStart">
            <b>start</b>text
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        componentStart: '<0>start</0>text',
      },
    })
  })

  it('should handle component at end of text', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.componentEnd">
            text<b>end</b>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        componentEnd: 'text<1>end</1>',
      },
    })
  })

  it('should handle TextLink between words with newlines (no spaces)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.noSpaces">
            word
            <TextLink to="/path">link</TextLink>
            word
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        noSpaces: 'word<1>link</1>word',
      },
    })
  })

  it('should handle TextLink between words with explicit spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.withSpaces">
            word <TextLink to="/path">link</TextLink> word
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        withSpaces: 'word <1>link</1> word',
      },
    })
  })

  it('should handle multiple inline components without spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.multipleInline">
            first<b>middle</b>last
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        multipleInline: 'first<1>middle</1>last',
      },
    })
  })

  it('should handle multiline with TextLink and no spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.multilineNoSpaces">
            line one
            <TextLink to="/path">link</TextLink>
            line two
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        multilineNoSpaces: 'line one<1>link</1>line two',
      },
    })
  })

  it('should handle multiline with TextLink and explicit JSX spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.multilineWithSpaces">
            line one{" "}
            <TextLink to="/path">
              linkthatisveryverylong
            </TextLink>{" "}
            longword that is very long
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        multilineWithSpaces: 'line one <2>linkthatisveryverylong</2> longword that is very long',
      },
    })
  })

  it('should handle nested components with newlines', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.nested">
            before
            <b>
              nested
              <TextLink to="/path">inner</TextLink>
            </b>
            after
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        nested: 'before<1>nested<1>inner</1></1>after',
      },
    })
  })

  it('should handle single line with tight component', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.singleLine">
            prefix<b>suffix</b>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        singleLine: 'prefix<1>suffix</1>',
      },
    })
  })

  it('should handle tight spacing with multiple components', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.tightSpacing">
            start<b>middle</b>end
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        tightSpacing: 'start<1>middle</1>end',
      },
    })
  })

  it('should handle component with text content and newlines', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.componentWithText">
            text
            <TextLink to="/path">link text</TextLink>
            more text
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        componentWithText: 'text<1>link text</1>more text',
      },
    })
  })

  it('should handle multiple different components with mixed spacing', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      
      function Component() {
        const { t } = useTranslation();
        
        return (
          <Trans t={t} i18nKey="example.multipleComponents">
            word<b>r</b>d<TextLink to="/path">link</TextLink>
            word
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        multipleComponents: 'word<1>r</1>d<3>link</3>word',
      },
    })
  })

  it('should handle long single-line props without adding spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.longPropsSingleLine">
            text
            <TextLink to="/very/long/path/that/spans/multiple/lines/and/keeps/going/and/going/and/going">link</TextLink>
            more
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        longPropsSingleLine: 'text<1>link</1>more',
      },
    })
  })

  it('should handle long props with explicit spaces preserved', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.longPropsWithSpaces">
            text{" "}
            <TextLink to="/very/long/path/that/spans/multiple/lines/and/keeps/going/and/going/and/going">
              link
            </TextLink>{" "}
            more
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        longPropsWithSpaces: 'text <2>link</2> more',
      },
    })
  })

  it('should handle long inline props on a tag spanning multiple lines', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.longPropsInline">
            before
            <b
              className="very-long-class-name-that-spans-across-multiple-lines-and-contains-many-words"
              data-testid="another-very-long-attribute-value-that-goes-on-and-on"
            >
              middle
            </b>
            after
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        longPropsInline: 'before<1>middle</1>after',
      },
    })
  })

  it('should handle nested long props with inner link', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.longPropsNested">
            start
            <b className="very-long-class-name-that-spans-across-multiple-lines-and-contains-many-words">
              nested
              <TextLink
                to="/very/long/path/that/spans/multiple/lines/and/keeps/going/and/going/and/going"
                className="another-very-long-class-name"
              >
                inner
              </TextLink>
            </b>
            end
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        longPropsNested: 'start<1>nested<1>inner</1></1>end',
      },
    })
  })

  it('should handle multiple long-prop components in sequence', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.multipleLongProps">
            first
            <TextLink to="/very/long/path/that/spans/multiple/lines/and/keeps/going/and/going/and/going">
              second
            </TextLink>
            third
            <b
              className="very-long-class-name-that-spans-across-multiple-lines-and-contains-many-words"
              data-testid="another-very-long-attribute-value-that-goes-on-and-on"
            >
              fourth
            </b>
            fifth
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        multipleLongProps: 'first<1>second</1>third<3>fourth</3>fifth',
      },
    })
  })

  it('should handle self-closing component with long props', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.selfClosingLongProps">
            text
            <Custom
              name="somethingverylongthatspansacrossmultiplelinesandkeepsgoingandgoingandgoing"
              className="another-very-long-class-name-that-spans-across-multiple-lines"
            />
            more
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        selfClosingLongProps: 'text<1></1>more',
      },
    })
  })

  it('should preserve explicit space before punctuation after link', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.spaceBeforePunctuation">
            In our{" "}
            <TextLink to="/help/article">help article</TextLink>
            , you will find the most important tips.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        spaceBeforePunctuation: 'In our <2>help article</2>, you will find the most important tips.',
      },
    })
  })

  it('should handle feedback description with br and nested button/text', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.feedbackDescription">
            <br />
            Your feedback will be incorporated into the further
            development of this application and will be
            discussed, evaluated, and prioritized by us in the
            next step. Due to the large amount of feedback we
            receive, we are unfortunately unable to respond to
            each piece of feedback individually.
            <br />
            <br />
            <b>
              If you have any questions or problems, please
              contact our{" "}
              <Text
                fontSize="inherit"
                type="button"
                as="button"
                onClick={() => {
                  // Example handler
                }}
              >
                free support
              </Text>
              .
            </b>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()

    const expectedDefaultValue =
      '<br />Your feedback will be incorporated into the further development of this application and will be discussed, evaluated, and prioritized by us in the next step. Due to the large amount of feedback we receive, we are unfortunately unable to respond to each piece of feedback individually.<br /><br /><4>If you have any questions or problems, please contact our <2>free support</2>.</4>'

    expect(translationFile!.newTranslations).toEqual({
      example: {
        feedbackDescription: expectedDefaultValue,
      },
    })
  })

  it('should handle action warning with strong and explicit space', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.actionWarning">
            This <strong>can affect existing records</strong>{" "}
            associated with this item. Alternatively, you can
            create a new item and assign it to your records.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        actionWarning:
          'This <strong>can affect existing records</strong> associated with this item. Alternatively, you can create a new item and assign it to your records.',
      },
    })
  })

  it('should handle permission info with explicit JSX space before TextLink', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.permissionInfo">
            You can easily change the role, and thus the access
            rights, of your users. To do this, navigate to the{" "}
            <TextLink target="_blank" to="/settings/team">
              team settings
            </TextLink>
            . There you can define a role for each user in their
            individual settings.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        permissionInfo:
          'You can easily change the role, and thus the access rights, of your users. To do this, navigate to the <2>team settings</2>. There you can define a role for each user in their individual settings.',
      },
    })
  })

  it('should handle permission info with newline (no explicit space) before TextLink', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.permissionInfoNoSpace">
            You can easily change the role, and thus the access
            rights, of your users. To do this, navigate to the
            <TextLink target="_blank" to="/settings/team">
              team settings
            </TextLink>
            . There you can define a role for each user in their
            individual settings.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        permissionInfoNoSpace:
          'You can easily change the role, and thus the access rights, of your users. To do this, navigate to the<1>team settings</1>. There you can define a role for each user in their individual settings.',
      },
    })
  })

  it('should handle duration value with NumberInput and trailing text', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.durationValue">
            <NumberInput
              className="text-right"
              value={1.5}
              locale="en"
              format={{
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              }}
              onChange={(value) => {
                if (value === null) return;
              }}
            />
            days
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        durationValue: '<0></0>days',
      },
    })
  })

  it('should handle welcome message with bold name placeholder', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        const name = "John";
        return (
          <Trans i18nKey="example.welcomeMessage" values={{ name: "John" }} t={t}>
            Welcome to the app, <b>{name}</b>!
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        welcomeMessage: 'Welcome to the app, <1>{{name}}</1>!',
      },
    })
  })

  it('should handle action description with strong and explicit spaces', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans i18nKey="example.actionDescription">
            This{" "}
            <strong>
              can affect the absences already recorded by your
              employees
            </strong>{" "}
            to whom the model is assigned. Alternatively, you
            can create a new working time model and assign your
            employees to it.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        actionDescription:
          'This <strong>can affect the absences already recorded by your employees</strong> to whom the model is assigned. Alternatively, you can create a new working time model and assign your employees to it.',
      },
    })
  })

  it('should handle phone confirmation with bold app and phone placeholders', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        const phoneNumber = "1234567890";
        return (
          <Trans
            t={t}
            i18nKey="example.phoneConfirmation"
            values={{
              phoneNumber: "1234567890",
            }}
          >
            Your user can now log into the <b>app</b> using the
            mobile number <b>{phoneNumber}</b>.
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        phoneConfirmation:
          'Your user can now log into the <1>app</1> using the mobile number <3>{{phoneNumber}}</3>.',
      },
    })
  })

  it('should handle Text children with explicit JSX space and correct indexes for reloadStep', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="example.reloadStep">
            <Text
              fontSize="20px"
              style={{ marginRight: "6px" }}
            >
              1.{" "}
            </Text>
            <Text fontSize="20px" onClick={() => {}}>
              Reload the page
            </Text>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      example: {
        reloadStep: '<0>1. </0><1>Reload the page</1>',
      },
    })
  })

  it('should handle embedded paragraphs with anchor and correct indexes', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="embed_answer">
            <p>text</p>
            <p><a href="/">ink</a></p>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      embed_answer: '<p>text</p><1><0>ink</0></1>',
    })
  })

  it('should handle embedded paragraphs with anchor and correct indexes (disabled transKeepBasicHtmlNodesFor)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans t={t} i18nKey="embed_answer">
            <p>text</p>
            <p><a href="/">ink</a></p>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract({ ...mockConfig, extract: { ...mockConfig.extract, transKeepBasicHtmlNodesFor: [] } })
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      embed_answer: '<0>text</0><1><0>ink</0></1>',
    })
  })

  it.skip('should handle space before component inside paragraph and correct indexes (space-comp)', async () => {
    const sampleCode = `
      import { useTranslation } from 'react-i18next';
      function Component() {
        const { t } = useTranslation();
        return (
          <Trans i18nKey="space-comp">
            <p>text{" "}<a href="/">link</a></p>
          </Trans>
        );
      }
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      'space-comp': '<0>text <2>link</2></0>',
      // 'space-comp': '<p>text <2>link</2></p>', // currently generates this
    })
  })
})
