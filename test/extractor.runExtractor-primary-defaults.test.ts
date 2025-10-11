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
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
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
})
