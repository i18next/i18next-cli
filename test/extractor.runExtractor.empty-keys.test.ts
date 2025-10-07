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
  },
}

describe('extractor: empty key prevention', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    // Mock the current working directory to align with the virtual file system's root.
    vi.spyOn(process, 'cwd').mockReturnValue('/')

    // Dynamically import the mocked glob after mocks are set up
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/test.tsx'])
  })

  async function getTranslationFileContent (filePath: string): Promise<any> {
    try {
      const content = await vol.promises.readFile(filePath, 'utf-8')
      return JSON.parse(content as string)
    } catch (error) {
      // File doesn't exist or is empty
      return {}
    }
  }

  it('should not extract empty string keys from t() calls', async () => {
    const sourceCode = `
      import { useTranslation } from 'react-i18next'
      
      function MyComponent() {
        const { t } = useTranslation()
        
        // These should be ignored
        t('')
        t('', 'Some default')
        t('', { defaultValue: 'Some default' })
        
        // These should be extracted
        t('valid.key', 'Valid translation')
        t('another.key')
        
        return null
      }
    `

    vol.fromJSON({
      '/src/test.tsx': sourceCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enJson = await getTranslationFileContent(enPath)

    console.log('enJson content:', JSON.stringify(enJson, null, 2))

    // Check that we got the expected valid content
    expect(enJson).toBeTruthy()
    expect(enJson).toMatchObject({
      valid: {
        key: 'Valid translation',
      },
      another: {
        key: 'another.key',
      },
    })

    // Fixed assertion - check for empty string key properly
    expect(Object.prototype.hasOwnProperty.call(enJson, '')).toBe(false)
    expect(Object.keys(enJson)).not.toContain('')
  })

  it('should not extract empty string keys from Trans components', async () => {
    const sourceCode = `
      import { Trans } from 'react-i18next'
      
      function MyComponent() {
        return (
          <div>
            {/* These should be ignored */}
            <Trans i18nKey="">Empty key</Trans>
            <Trans i18nKey="   ">Whitespace key</Trans>
            
            {/* These should be extracted */}
            <Trans i18nKey="valid.key">Valid translation</Trans>
            <Trans>Children as key</Trans>
          </div>
        )
      }
    `

    vol.fromJSON({
      '/src/test.tsx': sourceCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enJson = await getTranslationFileContent(enPath)

    console.log('JSX enJson content:', JSON.stringify(enJson, null, 2))

    // Check that we got the expected valid content
    expect(enJson).toBeTruthy()
    expect(enJson).toMatchObject({
      valid: {
        key: 'Valid translation',
      },
      'Children as key': 'Children as key',
    })

    // Fixed assertion - check for empty string key properly
    expect(Object.prototype.hasOwnProperty.call(enJson, '')).toBe(false)
    expect(Object.keys(enJson)).not.toContain('')
  })

  it('should show that empty keys are currently being extracted (demonstrating the bug)', async () => {
    const sourceCode = `
      import { useTranslation } from 'react-i18next'
      
      function MyComponent() {
        const { t } = useTranslation()
        
        // This should be ignored but currently isn't
        t('')
        
        // Valid key for comparison
        t('valid.key', 'Valid translation')
        
        return null
      }
    `

    vol.fromJSON({
      '/src/test.tsx': sourceCode,
    })

    await runExtractor(mockConfig)

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    const enJson = await getTranslationFileContent(enPath)

    console.log('Bug demonstration - enJson content:', JSON.stringify(enJson, null, 2))
    console.log('Keys found:', Object.keys(enJson))

    // This test shows the current behavior (which has the bug)
    // The empty string key should NOT be present, but currently it is
    const hasEmptyKey = Object.prototype.hasOwnProperty.call(enJson, '') || Object.keys(enJson).includes('')

    if (hasEmptyKey) {
      console.log('BUG CONFIRMED: Empty string key found in translations!')
      console.log('Empty key value:', enJson[''])
    } else {
      console.log('No empty key found - bug might be fixed or not triggered by this test')
    }

    // Expect valid key to be present
    expect(enJson).toMatchObject({
      valid: {
        key: 'Valid translation',
      },
    })
  })

  it('should handle keyPrefix edge cases and prevent empty keys', async () => {
    const sourceCode = `
      import { useTranslation } from 'react-i18next'
      
      function MyComponent() {
        const { t } = useTranslation('ns', { keyPrefix: 'prefix.' })
        
        // These should be ignored due to validation
        t('.')   // Results in 'prefix..' which has empty segment
        t('')    // Results in 'prefix.' which ends with separator
        t('...')  // Results in 'prefix....' which has empty segments
        
        // Valid key
        t('valid', 'Valid value')
        
        return null
      }
    `

    vol.fromJSON({
      '/src/test.tsx': sourceCode,
    })

    await runExtractor(mockConfig)

    const nsPath = resolve(process.cwd(), 'locales/en/ns.json')
    const nsJson = await getTranslationFileContent(nsPath)

    console.log('KeyPrefix fix - nsJson content:', JSON.stringify(nsJson, null, 2))

    // Should only contain the valid key, no nested empty keys
    expect(nsJson).toEqual({
      prefix: {
        valid: 'Valid value',
      },
    })

    // Ensure no empty string keys exist anywhere in the structure
    const flatKeys = JSON.stringify(nsJson).match(/"[^"]*":/g) || []
    console.log('All keys found:', flatKeys)

    const emptyKeys = flatKeys.filter(key => key === '"":')
    expect(emptyKeys).toHaveLength(0)
  })

  it('should demonstrate namespace processing that creates empty keys', async () => {
    const sourceCode = `
      import { useTranslation } from 'react-i18next'
      
      function MyComponent() {
        const { t } = useTranslation('myns')
        
        // This could create empty keys after namespace processing
        t('myns:', 'Some value')    // Key becomes empty after removing 'myns:'
        t('myns::', 'Double colon') // Key becomes ':' after removing 'myns:'
        t(':test', 'Starts with colon') // Might cause issues
        
        // Valid key
        t('myns:valid.key', 'Valid value')
        
        return null
      }
    `

    vol.fromJSON({
      '/src/test.tsx': sourceCode,
    })

    await runExtractor(mockConfig)

    // Check all created files
    console.log('Files in volume:', Object.keys(vol.toJSON()))

    const mynsPath = resolve(process.cwd(), 'locales/en/myns.json')
    const mynsJson = await getTranslationFileContent(mynsPath)

    console.log('Namespace processing - mynsJson content:', JSON.stringify(mynsJson, null, 2))

    // Check for empty or problematic keys
    const flatKeys = JSON.stringify(mynsJson).match(/"[^"]*":/g) || []
    console.log('All keys in myns:', flatKeys)

    const emptyKeys = flatKeys.filter(key => key === '"":' || key === '":"')
    if (emptyKeys.length > 0) {
      console.log('PROBLEMATIC KEYS FOUND:', emptyKeys)
    }
  })
})
