import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

// Mock the 'fs/promises' module to use our in-memory file system from 'memfs'
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock the 'glob' module to control which files it "finds"
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
    removeUnusedKeys: false,
  },
}

describe('extractor: runExtractor (sync primary language defaults)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Mock the current working directory to align with the virtual file system's root.
    vi.spyOn(process, 'cwd').mockReturnValue('/')

    // Dynamically import the mocked glob after mocks are set up
    const { glob } = await import('glob')

    // Return different results depending on the glob pattern:
    // - patterns that target source files should return source paths
    // - patterns that target locale files should return locale paths (or an empty list)
    ;(glob as any).mockImplementation(async (pattern: string) => {
      if (pattern.includes('src')) {
        return ['/src/App.tsx', '/src/app.ts'].filter(Boolean)
      }
      if (pattern.includes('locales') || pattern.includes('{{language}}')) {
        // Return locale files if they exist (tests create them), otherwise empty array
        return ['/locales/en/translation.json', '/locales/de/translation.json'].filter(Boolean)
      }
      return []
    })
  })

  it('should sync primary language values with code defaults when syncPrimaryWithDefaults is true', async () => {
    // Setup source files with translation calls
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Initial default value in code
        const title = t('app.title', 'Welcome to My App')
        const subtitle = t('app.subtitle', 'Best app ever')
        const existing = t('app.existing', 'New default value')
      `,
    })

    // Setup existing translation file with different values
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          title: 'Old Welcome Message',     // Should be updated
          subtitle: 'Old subtitle',         // Should be updated
          existing: 'Existing translation', // Should be updated
          preserved: 'Should stay'          // Should remain (no code default)
        }
      }, null, 2),
      [dePath]: JSON.stringify({
        app: {
          title: 'Alte Willkommensnachricht',
          existing: 'Bestehende Übersetzung'
        }
      }, null, 2)
    })

    // Mock glob to find the source files
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    // Run extractor with syncPrimaryWithDefaults enabled
    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    // Check primary language (en) - should sync with code defaults
    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        title: 'Welcome to My App',    // Updated from code
        subtitle: 'Best app ever',     // Updated from code
        existing: 'New default value', // Updated from code
        preserved: 'Should stay'       // Preserved (no code default)
      }
    })

    // Check secondary language (de) - should preserve existing values and add new keys with empty defaults
    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    expect(deContent).toEqual({
      app: {
        title: 'Alte Willkommensnachricht', // Preserved existing value
        subtitle: '',                       // New key gets empty default
        existing: 'Bestehende Übersetzung', // Preserved existing value
        // Note: 'preserved' is NOT added to secondary language because it doesn't exist in code
      }
    })
  })

  it('should NOT sync primary language when syncPrimaryWithDefaults is false (default behavior)', async () => {
    // Setup source files
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        const title = t('app.title', 'New Default Value')
      `,
    })

    // Setup existing translation file
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          title: 'Existing Value'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    // Run extractor without syncPrimaryWithDefaults (default behavior)
    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: false })
    expect(result).toBe(true)

    // Primary language should preserve existing value
    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        title: 'Existing Value' // Should NOT be updated
      }
    })
  })

  it('should sync primary language when syncPrimaryWithDefaults is true but only for keys with code defaults', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        const withDefault = t('app.withDefault', 'Has default')
        const withoutDefault = t('app.withoutDefault')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          withDefault: 'Old value',
          withoutDefault: 'Existing value',
          onlyInJson: 'Should be preserved'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        withDefault: 'Has default',        // Updated (has code default)
        withoutDefault: 'Existing value',  // Preserved (no code default)
        onlyInJson: 'Should be preserved'  // Preserved (not in code)
      }
    })
  })

  it('should preserve existing plural keys when syncPrimaryWithDefaults is true and no defaultValue is provided', async () => {
    // This test reproduces issue #61
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Plural key without defaultValue - should preserve existing plurals
        export const getMessage = t('Hello.multiple', { count: 2 })
        
        // Regular key with defaultValue - should be updated
        const title = t('app.title', 'New Title')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        Hello: {
          multiple_one: 'Hello {count} time',
          multiple_other: 'Hello {count} times'
        },
        app: {
          title: 'Old Title'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      Hello: {
        multiple_one: 'Hello {count} time',   // Should be preserved (no code default)
        multiple_other: 'Hello {count} times' // Should be preserved (no code default)
      },
      app: {
        title: 'New Title' // Should be updated (has code default)
      }
    })
  })

  it('should preserve existing plural keys across all locales when no defaultValue is provided', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        export const getMessage = t('Hello.multiple', { count: 2 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [enPath]: JSON.stringify({
        Hello: {
          multiple_one: 'Hello {count} time',
          multiple_other: 'Hello {count} times'
        }
      }, null, 2),
      [dePath]: JSON.stringify({
        Hello: {
          multiple_one: 'Hallo {count} Mal',
          multiple_other: 'Hallo {count} Mal'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(false) // No changes should be made since we're preserving existing values

    // Both languages should preserve their plural forms
    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      Hello: {
        multiple_one: 'Hello {count} time',
        multiple_other: 'Hello {count} times'
      }
    })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    expect(deContent).toEqual({
      Hello: {
        multiple_one: 'Hallo {count} Mal',
        multiple_other: 'Hallo {count} Mal'
      }
    })
  })

  it('should update plural keys when defaultValue is explicitly provided in code', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Plural with explicit defaultValue - should update primary
        export const getMessage = t('Hello.multiple', 'Updated default', { count: 2 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        Hello: {
          multiple_one: 'Hello {count} time',
          multiple_other: 'Hello {count} times'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      Hello: {
        multiple_one: 'Updated default',
        multiple_other: 'Updated default'
      }
    })
  })

  it('should preserve context variant keys when no defaultValue is provided', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Context key without defaultValue - should preserve existing variants
        export const getGreeting = t('greeting', { context: 'formal' })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        greeting_formal: 'Good day',
        greeting_informal: 'Hey there'
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      greeting_formal: 'Good day',
      greeting_informal: 'Hey there'
    })
  })

  it('should preserve nested plural keys when no defaultValue is provided', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        export const getItemCount = t('items.found', { count: 5 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        items: {
          found_one: '{{count}} item found',
          found_other: '{{count}} items found',
          title: 'My Items'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      items: {
        found_one: '{{count}} item found',
        found_other: '{{count}} items found',
        // Note: 'title' should be removed if removeUnusedKeys is true, but our mock config has it as false
        title: 'My Items'
      }
    })
  })

  it('should handle mixed plural and non-plural keys correctly with syncPrimaryWithDefaults', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Plural without defaultValue - should preserve
        const itemCount = t('items.count', { count: 5 })
        
        // Regular key with defaultValue - should update
        const welcome = t('welcome.message', 'Welcome to our app!')
        
        // Regular key without defaultValue - should preserve
        const goodbye = t('goodbye.message')
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        items: {
          count_one: 'Found {{count}} item',
          count_other: 'Found {{count}} items'
        },
        welcome: {
          message: 'Old welcome message'
        },
        goodbye: {
          message: 'Existing goodbye message'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      items: {
        count_one: 'Found {{count}} item',    // Preserved (no code default)
        count_other: 'Found {{count}} items'  // Preserved (no code default)
      },
      welcome: {
        message: 'Welcome to our app!'        // Updated (has code default)
      },
      goodbye: {
        message: 'Existing goodbye message'   // Preserved (no code default)
      }
    })
  })

  it('should handle ordinal plurals correctly when no defaultValue is provided', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Ordinal plural without defaultValue - should preserve existing
        const position = t('ranking.position', { ordinal: true, count: 3 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        ranking: {
          position_ordinal_one: '{{count}}st place',
          position_ordinal_two: '{{count}}nd place',
          position_ordinal_few: '{{count}}rd place',
          position_ordinal_other: '{{count}}th place'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      ranking: {
        position_ordinal_one: '{{count}}st place',
        position_ordinal_two: '{{count}}nd place',
        position_ordinal_few: '{{count}}rd place',
        position_ordinal_other: '{{count}}th place'
      }
    })
  })

  it('should handle context + plural combinations when no defaultValue is provided', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Context + plural without defaultValue - should preserve existing
        const notification = t('notifications.new', { context: 'email', count: 3 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        notifications: {
          new_email_one: 'You have {{count}} new email',
          new_email_other: 'You have {{count}} new emails',
          new_sms_one: 'You have {{count}} new SMS',
          new_sms_other: 'You have {{count}} new SMS messages'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      notifications: {
        new_email_one: 'You have {{count}} new email',
        new_email_other: 'You have {{count}} new emails',
        new_sms_one: 'You have {{count}} new SMS',
        new_sms_other: 'You have {{count}} new SMS messages'
      }
    })
  })

  it('should preserve existing translations when extracting new keys without defaults', async () => {
    // This test ensures that when new keys are found in code but existing keys are not touched
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // New key without defaultValue
        const newKey = t('new.feature')
        
        // Existing plural without defaultValue
        const existingPlural = t('existing.count', { count: 2 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        existing: {
          count_one: 'One item',
          count_other: '{{count}} items'
        },
        old: {
          unused: 'This should be removed if removeUnusedKeys was true'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true) // Changes are made because new key is added

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      new: {
        feature: ''  // New key gets empty default since no defaultValue provided
      },
      existing: {
        count_one: 'One item',      // Preserved (no code default)
        count_other: '{{count}} items' // Preserved (no code default)
      },
      old: {
        unused: 'This should be removed if removeUnusedKeys was true' // Preserved because removeUnusedKeys is false
      }
    })
  })

  it('should handle partial plural forms when some exist and some don\'t', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Plural key that only has some forms in existing translations
        const partial = t('messages.unread', { count: 5 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        messages: {
          unread_one: 'One unread message',
          // missing unread_other - should be generated with empty default
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      messages: {
        unread_one: 'One unread message', // Preserved existing
        unread_other: ''  // Generated with empty default since no code defaultValue
      }
    })
  })

  it('should handle deeply nested keys with plurals correctly', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Deeply nested plural without defaultValue
        const result = t('features.search.results.found', { count: 10 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        features: {
          search: {
            results: {
              found_one: 'Found {{count}} result',
              found_other: 'Found {{count}} results'
            }
          }
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      features: {
        search: {
          results: {
            found_one: 'Found {{count}} result',
            found_other: 'Found {{count}} results'
          }
        }
      }
    })
  })

  it('should preserve existing plural translations for Trans without plural defaults when syncPrimaryWithDefaults is true', async () => {
    vol.fromJSON({
      'src/App.tsx': `
        import React from 'react'
        import { Trans } from 'react-i18next'

        export const Comp = ({ numberOfAlertInstances, item }: any) => (
          <Trans i18nKey="alerting.policies.metadata.n-instances" count={numberOfAlertInstances ?? 0} tOptions={{ defaultValue_other: 'instances' }}>
            instance
          </Trans>
        )
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    const existing = {
      alerting: {
        policies: {
          metadata: {
            'n-instances_one': 'instance',
            'n-instances_other': 'instances'
          }
        }
      }
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(existing, null, 2),
      [dePath]: JSON.stringify(existing, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual(existing)

    // No changes should be needed — existing plural forms must be preserved.
    expect(result).toBe(false)
  })

  it('should sync primary language when syncPrimaryWithDefaults is true but only for keys with code defaults', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        const withDefault = t('app.withDefault', 'Has default')
        const withoutDefault = t('app.withoutDefault')
        const total = t('app.total', '{{count}} item', { count: total, defaultValue_one: 'item', defaultValue_other: 'items' })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          withDefault: 'Old value',
          withoutDefault: 'Existing value',
          onlyInJson: 'Should be preserved',
          total_one: 'item',
          total_other: 'items'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        withDefault: 'Has default',         // Updated (has code default)
        withoutDefault: 'Existing value',   // Preserved (no code default)
        onlyInJson: 'Should be preserved',  // Preserved (not in code)
        total_one: 'item',                  // Preserved (has code default with count)
        total_other: 'items'                // Preserved (has code default with count)
      }
    })
  })

  it('should preserve existing plural translations for Trans without plural defaults when syncPrimaryWithDefaults is true (without specifying defaultValue)', async () => {
    vol.fromJSON({
      'src/App.tsx': `
        import React from 'react'
        import { Trans } from 'react-i18next'

        export const Comp = ({ numberOfAlertInstances, item }: any) => (
          <Trans i18nKey="alerting.policies.metadata.n-instances" count={numberOfAlertInstances ?? 0}>
            instance
          </Trans>
        )
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    const existing = {
      alerting: {
        policies: {
          metadata: {
            'n-instances_one': 'instance',
            'n-instances_other': 'instances'
          }
        }
      }
    }

    vol.fromJSON({
      [enPath]: JSON.stringify(existing, null, 2),
      [dePath]: JSON.stringify(existing, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual(existing)

    // No changes should be needed — existing plural forms must be preserved.
    expect(result).toBe(false)
  })

  it('should sync primary language when syncPrimaryWithDefaults is true but only for keys with code defaults (without specifying defaultValue)', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        const withDefault = t('app.withDefault', 'Has default')
        const withoutDefault = t('app.withoutDefault')
        const total = t('app.total', '{{count}} item', { count: total })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          withDefault: 'Old value',
          withoutDefault: 'Existing value',
          onlyInJson: 'Should be preserved',
          total_one: 'item',
          total_other: 'items'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        withDefault: 'Has default',         // Updated (has code default)
        withoutDefault: 'Existing value',   // Preserved (no code default)
        onlyInJson: 'Should be preserved',  // Preserved (not in code)
        total_one: 'item',                  // Preserved (has code default with count)
        total_other: 'items'                // Preserved (has code default with count)
      }
    })
  })

  it('should NOT overwrite primary language values with code defaults if no code defaults exist', async () => {
    // Setup source files with translation calls
    vol.fromJSON({
      'src/app.tsx': `
        import { Trans, useTranslation } from 'react-i18next'
        
        export default function App() {
          const { t } = useTranslation()
          // Initial default value in code
          const title = t('app.title', 'Welcome to My App')
          const subtitle = t('app.subtitle', 'Best app ever')
          const existing = t('app.existing', 'New default value')
          const preserved = t('translation:app.preserved')

          return <Trans i18nKey='translation:app.preservedTrans' />
        }
      `,
    })

    // Setup existing translation file with different values
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          title: 'Old Welcome Message',     // Should be updated
          subtitle: 'Old subtitle',         // Should be updated
          existing: 'Existing translation', // Should be updated
          preserved: 'Should stay',          // Should remain (no code default)
          preservedTrans: 'Should also stay'    // Should remain (no code default)
        }
      }, null, 2),
      [dePath]: JSON.stringify({
        app: {
          title: 'Alte Willkommensnachricht',
          existing: 'Bestehende Übersetzung',
        }
      }, null, 2)
    })

    // Mock glob to find the source files
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.tsx'])

    // Run extractor with syncPrimaryWithDefaults enabled
    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    // Check primary language (en) - should sync with code defaults
    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        title: 'Welcome to My App',    // Updated from code
        subtitle: 'Best app ever',     // Updated from code
        existing: 'New default value', // Updated from code
        preserved: 'Should stay',      // Preserved (no code default)
        preservedTrans: 'Should also stay'  // Preserved (no code default)
      }
    })

    // Check secondary language (de) - should preserve existing values and add new keys with empty defaults
    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    expect(deContent).toEqual({
      app: {
        title: 'Alte Willkommensnachricht', // Preserved existing value
        preserved: '',                      // New key gets empty default
        preservedTrans: '',                     // New key gets empty default
        subtitle: '',                       // New key gets empty default
        existing: 'Bestehende Übersetzung', // Preserved existing value
        // Note: 'preserved' is NOT added to secondary language because it doesn't exist in code
      }
    })
  })

  it('should preserve existing translations when extracting new keys without defaults', async () => {
    // This test ensures that when new keys are found in code but existing keys are not touched
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // New key without defaultValue
        const newKey = t('new.feature')
        
        // Existing plural without defaultValue
        const existingPlural = t('existing.count', { count: 2 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        existing: {
          count_one: 'One item',
          count_other: '{{count}} items'
        },
        old: {
          unused: 'This should be removed if removeUnusedKeys was true'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true) // Changes are made because new key is added

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      new: {
        feature: ''  // New key gets empty default since no defaultValue provided
      },
      existing: {
        count_one: 'One item',
        count_other: '{{count}} items'
      },
      old: {
        unused: 'This should be removed if removeUnusedKeys was true'
      }
    })
  })

  it('should handle partial plural forms when some exist and some don\'t', async () => {
    vol.fromJSON({
      'src/app.ts': `
        import { t } from 'i18next'
        
        // Plural key that only has some forms in existing translations
        const partial = t('messages.unread', { count: 5 })
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({
        messages: {
          unread_one: 'One unread message',
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['src/app.ts'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      messages: { unread_one: 'One unread message', unread_other: '' }
    })
  })

  it('should sync primary language defaults for Trans components when syncPrimaryWithDefaults is true', async () => {
    vol.fromJSON({
      'src/App.tsx': `
        import { Trans } from 'react-i18next'
        export default function App() {
          return <Trans i18nKey="app.greeting">Hello from Trans</Trans>
        }
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    // Existing translations differ from the defaults in code
    vol.fromJSON({
      [enPath]: JSON.stringify({
        app: {
          greeting: 'Old greeting'
        }
      }, null, 2),
      [dePath]: JSON.stringify({
        app: {
          greeting: 'Alte Begrüssung'
        }
      }, null, 2)
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({
      app: {
        greeting: 'Hello from Trans'
      }
    })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    // Secondary locale should preserve its existing translation
    expect(deContent).toEqual({
      app: {
        greeting: 'Alte Begrüssung'
      }
    })
  })

  it('should sync primary defaults for <Trans i18nKey={CONST}> when CONST is a simple string constant', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        import { Trans } from 'react-i18next'
        const KEY = 'app.greeting'
        export default function App() {
          return <Trans i18nKey={KEY}>Hello from Trans</Trans>
        }
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [enPath]: JSON.stringify({ app: { greeting: 'Old greeting' } }, null, 2),
      [dePath]: JSON.stringify({ app: { greeting: 'Alte Begrüssung' } }, null, 2),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({ app: { greeting: 'Hello from Trans' } })

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    expect(deContent).toEqual({ app: { greeting: 'Alte Begrüssung' } })
  })

  it('should document behavior for <Trans> without i18nKey (fallback/default text only)', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        import { Trans } from 'react-i18next'
        export default function App() {
          return <Trans>Inline default text</Trans>
        }
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    vol.fromJSON({
      [enPath]: JSON.stringify({ app: { greeting: 'Old greeting' } }, null, 2),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    expect(enContent).toEqual({ 'Inline default text': '', app: { greeting: 'Old greeting' } })
  })

  it('should sync primary defaults for <Trans i18nKey="..."> with nested JSX children', async () => {
    vol.fromJSON({
      '/src/App.tsx': `
        import React from 'react'
        import { Trans } from 'react-i18next'
        export default function App() {
          return <Trans i18nKey="app.rich">Hello <strong>world</strong></Trans>
        }
      `,
    })

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const dePath = resolve(process.cwd(), 'locales/de/translation.json')

    vol.fromJSON({
      [enPath]: JSON.stringify({ app: { rich: 'Old rich' } }, null, 2),
      [dePath]: JSON.stringify({ app: { rich: 'Alte Rich' } }, null, 2),
    })

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    const result = await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })
    expect(result).toBe(true)

    const enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    // Default may be serialized with placeholders; at minimum it must contain the visible text parts
    expect(enContent.app.rich).toEqual(expect.stringContaining('Hello'))
    expect(enContent.app.rich).toEqual(expect.stringContaining('world'))

    const deContent = JSON.parse(vol.readFileSync(dePath, 'utf8') as string)
    expect(deContent).toEqual({ app: { rich: 'Alte Rich' } })
  })

  it('demonstrates Trans without i18nKey creates keys from inline text and cannot "replace" old text when inline default changes', async () => {
    const srcPath = '/src/App.tsx'
    const enPath = resolve(process.cwd(), 'locales/en/translation.json')

    // First version: initial extraction
    vol.fromJSON({
      [srcPath]: `
        import { Trans } from 'react-i18next'
        export default function App() {
          return <Trans>Old default</Trans>
        }
      `,
    })

    vi.mocked((await import('glob')).glob).mockResolvedValue([srcPath])
    // initial extraction (no syncPrimary flag)
    await runExtractor(mockConfig)

    let enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    // extractor currently creates a key from the inline text
    expect(Object.keys(enContent)).toContain('Old default')

    // Change inline default text in source
    vol.fromJSON({
      [srcPath]: `
        import { Trans } from 'react-i18next'
        export default function App() {
          return <Trans>New default</Trans>
        }
      `,
    })

    // Run extractor with syncPrimaryWithDefaults (attempt to sync primary)
    await runExtractor(mockConfig, { syncPrimaryWithDefaults: true })

    enContent = JSON.parse(vol.readFileSync(enPath, 'utf8') as string)
    // Current behavior: both old and new keys exist (no replacement) because keys are derived from the text
    expect(Object.keys(enContent)).toContain('Old default')
    expect(Object.keys(enContent)).toContain('New default')
  })
})
