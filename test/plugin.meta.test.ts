import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin, ExtractedKey, I18nextToolkitConfig } from '../src/index'
import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'

/**
 * An example plugin to capture and export location metadata for extracted keys.
 * This plugin demonstrates how to track where translation keys are used in the codebase.
 *
 * The plugin:
 * - Automatically receives location data from the core extractor
 * - Outputs a separate metadata.json file with source locations
 * - Doesn't modify the actual translation JSON files
 *
 * @param options - Plugin configuration options
 * @returns A configured i18next-cli Plugin object.
 */
interface LocationMetadataOptions {
  /** Output path for the metadata file */
  output?: string
  /** Whether to include line and column numbers */
  includePosition?: boolean
  /** Group by namespace or keep flat */
  groupByNamespace?: boolean
}

const locationMetadataPlugin = (options: LocationMetadataOptions = {}): Plugin => {
  const {
    output = 'locales/metadata.json',
    includePosition = true,
    groupByNamespace = false
  } = options

  return {
    name: 'location-metadata',

    /**
     * The `onEnd` hook runs after all keys have been extracted.
     * It processes the location information and writes it to a separate file.
     *
     * @param keys - The map of all extracted keys with their metadata
     */
    async onEnd (keys: Map<string, ExtractedKey>) {
      const metadata: Record<string, any> = {}

      for (const [, extractedKey] of keys.entries()) {
        const { key, ns, locations } = extractedKey

        if (!locations || locations.length === 0) {
          continue
        }

        const locationData = locations.map(loc => {
          if (includePosition && loc.line !== undefined) {
            return `${loc.file}:${loc.line}:${loc.column ?? 0}`
          }
          return loc.file
        })

        if (groupByNamespace) {
          const namespace = ns || 'translation'
          if (!metadata[namespace]) {
            metadata[namespace] = {}
          }
          metadata[namespace][key] = locationData
        } else {
          const fullKey = ns ? `${ns}:${key}` : key
          metadata[fullKey] = locationData
        }
      }

      // ✅ Create directory before writing
      await mkdir(dirname(output), { recursive: true })
      // Write to the metadata file
      await writeFile(output, JSON.stringify(metadata, null, 2), 'utf-8')
    }
  }
}

// Mocks
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{lng}}/{{ns}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
  },
  plugins: [locationMetadataPlugin()],
}

describe('plugin system: location metadata', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should capture location metadata for extracted keys', async () => {
    const { glob } = await import('glob')
    // ✅ Mock glob to return only files that exist
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx', 'src/Home.tsx', 'src/components/Header.tsx'])

    const appCode = `
      import { useTranslation } from 'react-i18next'
      
      function App() {
        const { t } = useTranslation()
        return <h1>{t('app.title', 'My App')}</h1>
      }
    `

    const homeCode = `
      import { useTranslation } from 'react-i18next'
      
      function Home() {
        const { t } = useTranslation()
        return (
          <div>
            <h1>{t('home.welcome', 'Welcome')}</h1>
            <p>{t('home.description', 'This is the home page')}</p>
          </div>
        )
      }
    `

    const headerCode = `
      import { useTranslation } from 'react-i18next'
      
      function Header() {
        const { t } = useTranslation()
        return <nav>{t('app.title', 'My App')}</nav>
      }
    `

    vol.fromJSON({
      'src/App.tsx': appCode,
      'src/Home.tsx': homeCode,
      'src/components/Header.tsx': headerCode,
    })

    const { allKeys: keys } = await findKeys(mockConfig)

    // Verify keys were extracted
    expect(keys.size).toBe(3)
    expect(Array.from(keys.keys())).toEqual([
      'translation:app.title',
      'translation:home.welcome',
      'translation:home.description'
    ])

    // Verify location data was captured
    const appTitleKey = keys.get('translation:app.title')
    expect(appTitleKey?.locations).toBeDefined()
    expect(appTitleKey?.locations).toHaveLength(2) // Used in App.tsx and Header.tsx
    expect(appTitleKey?.locations?.[0]?.file).toBe('src/App.tsx')
    expect(appTitleKey?.locations?.[1]?.file).toBe('src/components/Header.tsx')

    const homeWelcomeKey = keys.get('translation:home.welcome')
    expect(homeWelcomeKey?.locations).toBeDefined()
    expect(homeWelcomeKey?.locations).toHaveLength(1)
    expect(homeWelcomeKey?.locations?.[0]?.file).toBe('src/Home.tsx')

    // Verify metadata file was written
    const metadataContent = await readFile('locales/metadata.json', 'utf-8')
    const metadata = JSON.parse(metadataContent)

    expect(metadata).toHaveProperty('translation:app.title')
    expect(metadata['translation:app.title']).toHaveLength(2)
    expect(metadata['translation:app.title'][0]).toMatch(/src\/App\.tsx:\d+:\d+/)
    expect(metadata['translation:app.title'][1]).toMatch(/src\/components\/Header\.tsx:\d+:\d+/)

    expect(metadata).toHaveProperty('translation:home.welcome')
    expect(metadata['translation:home.welcome']).toHaveLength(1)
    expect(metadata['translation:home.welcome'][0]).toMatch(/src\/Home\.tsx:\d+:\d+/)
  })

  it('should support custom output path', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const customConfig: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [locationMetadataPlugin({ output: 'custom/path/locations.json' })],
    }

    const code = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('test.key', 'Test')
    `

    vol.fromJSON({
      'src/App.tsx': code,
    })

    await findKeys(customConfig)

    // Verify custom path was used
    const metadataContent = await readFile('custom/path/locations.json', 'utf-8')
    expect(metadataContent).toBeDefined()

    const metadata = JSON.parse(metadataContent)
    expect(metadata).toHaveProperty('translation:test.key')
  })

  it('should support file-only mode without line numbers', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const noPositionConfig: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [locationMetadataPlugin({ includePosition: false })],
    }

    const code = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('test.key', 'Test')
    `

    vol.fromJSON({
      'src/App.tsx': code,
    })

    await findKeys(noPositionConfig)

    const metadataContent = await readFile('locales/metadata.json', 'utf-8')
    const metadata = JSON.parse(metadataContent)

    expect(metadata['translation:test.key']).toEqual(['src/App.tsx'])
    expect(metadata['translation:test.key'][0]).not.toMatch(/:\d+:\d+$/)
  })

  it('should support grouping by namespace', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const groupedConfig: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [locationMetadataPlugin({ groupByNamespace: true })],
    }

    const code = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation(['common', 'errors'])
      t('common:button.submit', 'Submit')
      t('errors:validation.required', 'Required')
    `

    vol.fromJSON({
      'src/App.tsx': code,
    })

    await findKeys(groupedConfig)

    const metadataContent = await readFile('locales/metadata.json', 'utf-8')
    const metadata = JSON.parse(metadataContent)

    expect(metadata).toHaveProperty('common')
    expect(metadata).toHaveProperty('errors')
    expect(metadata.common).toHaveProperty('button.submit')
    expect(metadata.errors).toHaveProperty('validation.required')
  })

  it('should handle keys used in multiple files', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx', 'src/Home.tsx', 'src/components/Header.tsx'])

    const file1 = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('shared.key', 'Shared Value')
    `

    const file2 = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('shared.key', 'Shared Value')
    `

    const file3 = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('shared.key', 'Shared Value')
    `

    vol.fromJSON({
      'src/App.tsx': file1,
      'src/Home.tsx': file2,
      'src/components/Header.tsx': file3,
    })

    const { allKeys: keys } = await findKeys(mockConfig)

    const sharedKey = keys.get('translation:shared.key')
    expect(sharedKey?.locations).toHaveLength(3)
    expect(sharedKey?.locations?.map(l => l.file)).toEqual([
      'src/App.tsx',
      'src/Home.tsx',
      'src/components/Header.tsx'
    ])

    const metadataContent = await readFile('locales/metadata.json', 'utf-8')
    const metadata = JSON.parse(metadataContent)

    expect(metadata['translation:shared.key']).toHaveLength(3)
  })

  it('should handle Trans components with location tracking', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const code = `
      import { Trans } from 'react-i18next'
      
      function Component() {
        return (
          <>
            <Trans i18nKey="trans.simple">Simple text</Trans>
            <Trans i18nKey="trans.withHtml">Text with <strong>bold</strong></Trans>
          </>
        )
      }
    `

    vol.fromJSON({
      'src/App.tsx': code,
    })

    const { allKeys: keys } = await findKeys(mockConfig)

    const simpleKey = keys.get('translation:trans.simple')
    expect(simpleKey?.locations).toBeDefined()
    expect(simpleKey?.locations?.[0]?.file).toBe('src/App.tsx')
    expect(simpleKey?.locations?.[0]?.line).toBeGreaterThan(0)

    const htmlKey = keys.get('translation:trans.withHtml')
    expect(htmlKey?.locations).toBeDefined()
    expect(htmlKey?.locations?.[0]?.file).toBe('src/App.tsx')
  })

  it('should skip keys without location data', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValueOnce(['src/App.tsx'])

    const emptyConfig: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [
        // Custom plugin that adds keys without locations
        {
          name: 'no-location-plugin',
          async onEnd (keys: Map<string, ExtractedKey>) {
            keys.set('manual:key', {
              key: 'key',
              ns: 'manual',
              defaultValue: 'Manual key',
              // No locations property
            })
          }
        },
        locationMetadataPlugin()
      ],
    }

    const code = `
      import { useTranslation } from 'react-i18next'
      const { t } = useTranslation()
      t('normal.key', 'Normal')
    `

    vol.fromJSON({
      'src/App.tsx': code,
    })

    await findKeys(emptyConfig)

    const metadataContent = await readFile('locales/metadata.json', 'utf-8')
    const metadata = JSON.parse(metadataContent)

    // Only the key with locations should be in metadata
    expect(metadata).toHaveProperty('translation:normal.key')
    expect(metadata).not.toHaveProperty('manual:key')
  })
})
