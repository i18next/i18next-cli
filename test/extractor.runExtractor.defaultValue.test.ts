import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('runExtractor: defaultValue option', () => {
  let tempDir: string

  beforeEach(async () => {
    // Create a unique temporary directory for each test
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-test-'))

    // Create src directory
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })

    // Create locales directories
    await fs.mkdir(join(tempDir, 'locales', 'en'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales', 'de'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales', 'fr'), { recursive: true })
  })

  afterEach(async () => {
    // Clean up the temporary directory
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should use configured defaultValue for missing keys in secondary languages', async () => {
    const sampleCode = `
      t('welcome.title', 'Welcome to our app');
      t('user.profile.name', 'Name');
      t('button.save', 'Save');
    `

    // Write the source file
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Simulate existing translation files where secondary languages have some but not all keys
    const existingDeTranslations = {
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation
      },
      // Missing: user.profile.name and button.save
    }

    const existingFrTranslations = {
      user: {
        profile: {
          name: 'Nom', // Existing translation
        },
      },
      // Missing: welcome.title and button.save
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )
    await fs.writeFile(
      join(tempDir, 'locales', 'fr', 'translation.json'),
      JSON.stringify(existingFrTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: '[NEEDS_TRANSLATION]', // Custom default value for missing keys
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the German translation file
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      button: {
        save: '[NEEDS_TRANSLATION]', // Missing key gets defaultValue
      },
      user: {
        profile: {
          name: '[NEEDS_TRANSLATION]', // Missing key gets defaultValue
        },
      },
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation preserved
      },
    })

    // Check the French translation file
    const frContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'translation.json'), 'utf-8')
    const frTranslations = JSON.parse(frContent)

    expect(frTranslations).toEqual({
      button: {
        save: '[NEEDS_TRANSLATION]', // Missing key gets defaultValue
      },
      user: {
        profile: {
          name: 'Nom', // Existing translation preserved
        },
      },
      welcome: {
        title: '[NEEDS_TRANSLATION]', // Missing key gets defaultValue
      },
    })

    // Check the primary language (English) uses the actual default values from code
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      button: {
        save: 'Save', // Primary language uses actual default values
      },
      user: {
        profile: {
          name: 'Name',
        },
      },
      welcome: {
        title: 'Welcome to our app',
      },
    })
  })

  it('should use empty string as defaultValue when option is not specified', async () => {
    const sampleCode = `
      t('new.key', 'New Key Value');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        // defaultValue not specified, should default to empty string
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check secondary languages get empty strings
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      new: {
        key: '', // Empty string when defaultValue not configured
      },
    })

    const frContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'translation.json'), 'utf-8')
    const frTranslations = JSON.parse(frContent)

    expect(frTranslations).toEqual({
      new: {
        key: '', // Empty string when defaultValue not configured
      },
    })

    // Primary language still gets the actual default value
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      new: {
        key: 'New Key Value',
      },
    })
  })

  it('should apply defaultValue to keys extracted from different sources (t calls, Trans components, comments)', async () => {
    const sampleCode = `
      // t('comment.key', 'From Comment')
      t('function.key', 'From Function Call');
      
      function MyComponent() {
        return <Trans i18nKey="trans.key">From Trans Component</Trans>;
      }
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: '{{TODO}}', // Distinctive placeholder
        transComponents: ['Trans'],
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check that all keys from different sources get the same defaultValue treatment in secondary languages
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      comment: {
        key: '{{TODO}}', // From comment extraction
      },
      function: {
        key: '{{TODO}}', // From function call extraction
      },
      trans: {
        key: '{{TODO}}', // From Trans component extraction
      },
    })

    // Primary language should have the actual default values
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      comment: {
        key: 'From Comment',
      },
      function: {
        key: 'From Function Call',
      },
      trans: {
        key: 'From Trans Component',
      },
    })
  })

  it('should not overwrite existing translations with defaultValue', async () => {
    const sampleCode = `
      t('existing.key', 'New Default Value');
      t('new.key', 'Brand New Key');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Existing German file with one translated key
    const existingDeTranslations = {
      existing: {
        key: 'Bestehender Schlüssel', // Already translated
      },
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: '[MISSING]',
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      existing: {
        key: 'Bestehender Schlüssel', // Existing translation preserved
      },
      new: {
        key: '[MISSING]', // New key gets defaultValue
      },
    })
  })

  it('should accept a function as defaultValue and call it with (key, namespace, language)', async () => {
    const sampleCode = `
      t('welcome.title', 'Welcome to our app');
      t('user.profile.name', 'Name');
      t('button.save', 'Save');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Existing translation files where secondary languages have some but not all keys
    const existingDeTranslations = {
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation
      },
      // Missing: user.profile.name and button.save
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `[${language.toUpperCase()}:${namespace}:${key}]`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the German translation file
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      button: {
        save: '[DE:translation:button.save]', // Function called with key, namespace, language
      },
      user: {
        profile: {
          name: '[DE:translation:user.profile.name]', // Function called with key, namespace, language
        },
      },
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation preserved
      },
    })

    // Check the French translation file
    const frContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'translation.json'), 'utf-8')
    const frTranslations = JSON.parse(frContent)

    expect(frTranslations).toEqual({
      button: {
        save: '[FR:translation:button.save]', // Function called with key, namespace, language
      },
      user: {
        profile: {
          name: '[FR:translation:user.profile.name]', // Function called with key, namespace, language
        },
      },
      welcome: {
        title: '[FR:translation:welcome.title]', // Function called with key, namespace, language
      },
    })

    // Primary language still gets the actual default values from code
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      button: {
        save: 'Save', // Primary language uses actual default values
      },
      user: {
        profile: {
          name: 'Name',
        },
      },
      welcome: {
        title: 'Welcome to our app',
      },
    })
  })

  it('should use function defaultValue for multiple namespaces', async () => {
    const sampleCode = `
      t('common:button.save', 'Save');
      t('app:title', 'My App');
      t('user:profile.name', 'Name');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        nsSeparator: ':',
        defaultValue: (key: string, namespace: string, language: string) => {
          // Different format per namespace
          if (namespace === 'common') return `COMMON_${key.toUpperCase()}_${language}`
          if (namespace === 'app') return `APP_${key}_${language}`
          return `${namespace}:${key}:${language}`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the common namespace
    const commonDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'common.json'), 'utf-8')
    const commonDeTranslations = JSON.parse(commonDeContent)

    expect(commonDeTranslations).toEqual({
      button: {
        save: 'COMMON_BUTTON.SAVE_de', // Custom format for common namespace
      },
    })

    // Check the app namespace
    const appDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'app.json'), 'utf-8')
    const appDeTranslations = JSON.parse(appDeContent)

    expect(appDeTranslations).toEqual({
      title: 'APP_title_de', // Custom format for app namespace
    })

    // Check the user namespace
    const userDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'user.json'), 'utf-8')
    const userDeTranslations = JSON.parse(userDeContent)

    expect(userDeTranslations).toEqual({
      profile: {
        name: 'user:profile.name:de', // Default format for other namespaces
      },
    })
  })

  it('should handle function defaultValue with Trans components', async () => {
    const sampleCode = `
      function MyComponent() {
        return (
          <div>
            <Trans i18nKey="welcome.message" ns="greetings">Welcome!</Trans>
            <Trans i18nKey="error.general">Something went wrong</Trans>
          </div>
        );
      }
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        transComponents: ['Trans'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `🌍 ${language} | ${namespace} | ${key}`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the greetings namespace
    const greetingsDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'greetings.json'), 'utf-8')
    const greetingsDeTranslations = JSON.parse(greetingsDeContent)

    expect(greetingsDeTranslations).toEqual({
      welcome: {
        message: '🌍 de | greetings | welcome.message',
      },
    })

    // Check the default translation namespace
    const translationDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const translationDeTranslations = JSON.parse(translationDeContent)

    expect(translationDeTranslations).toEqual({
      error: {
        general: '🌍 de | translation | error.general',
      },
    })

    // Primary language should still use the actual default values
    const greetingsEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'greetings.json'), 'utf-8')
    const greetingsEnTranslations = JSON.parse(greetingsEnContent)

    expect(greetingsEnTranslations).toEqual({
      welcome: {
        message: 'Welcome!',
      },
    })
  })

  it('should fallback to empty string if function defaultValue throws an error', async () => {
    const sampleCode = `
      t('test.key', 'Test Value');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          // This function will throw an error
          throw new Error('Function error')
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Should fallback to empty string when function throws
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      test: {
        key: '', // Falls back to empty string on error
      },
    })
  })

  it('should work with function defaultValue and existing partial translations', async () => {
    const sampleCode = `
      t('new.key1', 'New Key 1');
      t('new.key2', 'New Key 2');
      t('existing.key', 'Updated Value');
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Create existing partial translation
    const existingDeTranslations = {
      existing: {
        key: 'Existing German Translation',
      },
      // new.key1 and new.key2 are missing
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `TODO_${language}_${key.replace(/\./g, '_')}`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      existing: {
        key: 'Existing German Translation', // Preserved existing translation
      },
      new: {
        key1: 'TODO_de_new_key1', // Function called for missing key
        key2: 'TODO_de_new_key2', // Function called for missing key
      },
    })
  })

  it('should use function defaultValue for Trans components with various patterns', async () => {
    const sampleCode = `
      import React from 'react';
      import { Trans } from 'react-i18next';

      function MyComponent() {
        return (
          <div>
            {/* Explicit i18nKey with defaults */}
            <Trans i18nKey="explicit.key" defaults="Explicit Default">
              Content that should be ignored
            </Trans>
            
            {/* Explicit i18nKey without defaults - should use children */}
            <Trans i18nKey="no.defaults">
              Children content as default
            </Trans>
            
            {/* No i18nKey - should use children as key and default */}
            <Trans>Children as key and default</Trans>
            
            {/* With namespace */}
            <Trans i18nKey="title" ns="homepage">
              Welcome to our app
            </Trans>
            
            {/* Complex JSX children */}
            <Trans i18nKey="complex.jsx">
              Hello <strong>{{name}}</strong>, you have <Link to="/messages">{{count}} messages</Link>!
            </Trans>
            
            {/* With count (pluralization) */}
            <Trans i18nKey="item.count" count={5}>
              You have one item
            </Trans>
            
            {/* With context - using string literal for static context */}
            <Trans i18nKey="greeting" context="formal">
              Hello there
            </Trans>
          </div>
        );
      }
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Create existing partial translations
    const existingDeTranslations = {
      explicit: {
        key: 'Existing German Translation', // This should be preserved
      },
      // All other keys are missing and should get function-generated defaults
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        transComponents: ['Trans'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `[${language.toUpperCase()}] ${namespace}/${key}`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the German translation file
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      'Children as key and default': '[DE] translation/Children as key and default',
      complex: {
        jsx: '[DE] translation/complex.jsx',
      },
      explicit: {
        key: 'Existing German Translation', // Preserved existing translation
      },
      greeting_formal: '[DE] translation/greeting_formal',
      // Note: context variants might not be generated for static string literals in JSX context
      item: {
        count_one: '[DE] translation/item.count_one', // Plural forms
        count_other: '[DE] translation/item.count_other',
      },
      no: {
        defaults: '[DE] translation/no.defaults',
      },
    })

    // Check the French translation file
    const frContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'translation.json'), 'utf-8')
    const frTranslations = JSON.parse(frContent)

    expect(frTranslations).toEqual({
      'Children as key and default': '[FR] translation/Children as key and default',
      complex: {
        jsx: '[FR] translation/complex.jsx',
      },
      explicit: {
        key: '[FR] translation/explicit.key',
      },
      greeting_formal: '[FR] translation/greeting_formal',
      item: {
        count_one: '[FR] translation/item.count_one',
        count_other: '[FR] translation/item.count_other',
      },
      no: {
        defaults: '[FR] translation/no.defaults',
      },
    })

    // Check the homepage namespace (for the Trans with ns="homepage")
    const homepageDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'homepage.json'), 'utf-8')
    const homepageDeTranslations = JSON.parse(homepageDeContent)

    expect(homepageDeTranslations).toEqual({
      title: '[DE] homepage/title',
    })

    const homepageFrContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'homepage.json'), 'utf-8')
    const homepageFrTranslations = JSON.parse(homepageFrContent)

    expect(homepageFrTranslations).toEqual({
      title: '[FR] homepage/title',
    })

    // Primary language should use the actual default values from JSX
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      'Children as key and default': 'Children as key and default', // Uses children as default
      complex: {
        jsx: 'Hello <1>{{name}}</1>, you have <3>{{count}} messages</3>!', // Serialized JSX (Link becomes <3>)
      },
      explicit: {
        key: 'Explicit Default', // Uses explicit defaults prop
      },
      greeting_formal: 'Hello there',
      item: {
        count_one: 'You have one item', // Plural forms get same default
        count_other: 'You have one item',
      },
      no: {
        defaults: 'Children content as default', // Uses children when no defaults prop
      },
    })

    const homepageEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'homepage.json'), 'utf-8')
    const homepageEnTranslations = JSON.parse(homepageEnContent)

    expect(homepageEnTranslations).toEqual({
      title: 'Welcome to our app', // Uses children content
    })
  })

  it('should handle function defaultValue with Trans components that have explicit defaults attribute', async () => {
    const sampleCode = `
      import React from 'react';
      import { Trans } from 'react-i18next';

      function MyComponent() {
        return (
          <div>
            {/* When defaults is explicitly provided, it should be used in primary language */}
            <Trans i18nKey="with.explicit.defaults" defaults="Explicit Default Value">
              This JSX content should be ignored in favor of defaults prop
            </Trans>
            
            {/* When no defaults provided, JSX children should be used */}
            <Trans i18nKey="with.jsx.children">
              JSX content <em>with emphasis</em> should be used
            </Trans>
          </div>
        );
      }
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        transComponents: ['Trans'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `FUNC[${language}:${key}]`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Secondary language should use function-generated defaults
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      with: {
        explicit: {
          defaults: 'FUNC[de:with.explicit.defaults]', // Function called for secondary language
        },
        jsx: {
          children: 'FUNC[de:with.jsx.children]', // Function called for secondary language
        },
      },
    })

    // Primary language should use actual defaults from JSX/defaults prop
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      with: {
        explicit: {
          defaults: 'Explicit Default Value', // Uses explicit defaults prop
        },
        jsx: {
          children: 'JSX content <1>with emphasis</1> should be used', // Uses serialized JSX children (em becomes <1>)
        },
      },
    })
  })

  it('should extract translations with context and pluralization', async () => {
    const sampleCode = `
      t('item.count', { count: 1, defaultValue_one: 'You have {{count}} item', defaultValue_other: 'You have {{count}} items' });
      t('greeting', 'Hello', { context: 'formal' });
      t('greeting', 'Hi', { context: 'informal' });
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        defaultValue: (key: string, namespace: string, language: string) => {
          return `[${language.toUpperCase()}] ${key}`
        },
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check translations with pluralization and context in secondary language
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      // Note: Base greeting key might not be generated when only context variants exist
      greeting_formal: '[DE] greeting_formal', // Context variant with underscore
      greeting_informal: '[DE] greeting_informal', // Context variant with underscore
      item: {
        count_one: '[DE] item.count_one', // Pluralization key for singular
        count_other: '[DE] item.count_other', // Pluralization key for plural
      },
    })

    // Primary language should have actual default values
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      // Note: Base greeting key might not be generated when only context variants exist
      greeting_formal: 'Hello', // Context variants
      greeting_informal: 'Hi',
      item: {
        count_one: 'You have {{count}} item', // Uses specific defaultValue_one
        count_other: 'You have {{count}} items', // Uses specific defaultValue_other
      },
    })
  })

  // Fix the namespace tests by expecting separate namespace files
  it('should extract and merge translations from different source files with namespaces', async () => {
    const sampleCode1 = `
      t('app:title', 'App Title');
      t('app:description', 'App Description');
    `
    const sampleCode2 = `
      t('user:name', 'User Name');
      t('user:age', 'User Age');
    `
    const sampleCode3 = `
      t('button:save', 'Save');
      t('button:cancel', 'Cancel');
    `

    // Write multiple source files with namespaces
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode1)
    await fs.writeFile(join(tempDir, 'src', 'User.tsx'), sampleCode2)
    await fs.writeFile(join(tempDir, 'src', 'Button.tsx'), sampleCode3)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        nsSeparator: ':',
        // defaultValue not specified, should default to empty string
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check app namespace
    const appDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'app.json'), 'utf-8')
    const appDeTranslations = JSON.parse(appDeContent)

    expect(appDeTranslations).toEqual({
      title: '', // Empty string for missing defaultValue
      description: '',
    })

    // Check user namespace
    const userDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'user.json'), 'utf-8')
    const userDeTranslations = JSON.parse(userDeContent)

    expect(userDeTranslations).toEqual({
      name: '',
      age: '',
    })

    // Check button namespace
    const buttonDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'button.json'), 'utf-8')
    const buttonDeTranslations = JSON.parse(buttonDeContent)

    expect(buttonDeTranslations).toEqual({
      save: '',
      cancel: '',
    })

    // Check primary language files
    const appEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'app.json'), 'utf-8')
    const appEnTranslations = JSON.parse(appEnContent)

    expect(appEnTranslations).toEqual({
      title: 'App Title',
      description: 'App Description',
    })

    const userEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'user.json'), 'utf-8')
    const userEnTranslations = JSON.parse(userEnContent)

    expect(userEnTranslations).toEqual({
      name: 'User Name',
      age: 'User Age',
    })

    const buttonEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'button.json'), 'utf-8')
    const buttonEnTranslations = JSON.parse(buttonEnContent)

    expect(buttonEnTranslations).toEqual({
      save: 'Save',
      cancel: 'Cancel',
    })
  })

  it('should handle conflicting translations from different source files with namespaces', async () => {
    const sampleCode1 = `
      t('app:title', 'App Title');
      t('app:description', 'App Description');
    `
    const sampleCode2 = `
      t('app:title', 'New App Title'); // Conflict here
      t('user:name', 'User Name');
    `
    const sampleCode3 = `
      t('button:save', 'Save');
      t('button:cancel', 'Cancel');
    `

    // Write multiple source files with conflicts and namespaces
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode1)
    await fs.writeFile(join(tempDir, 'src', 'User.tsx'), sampleCode2)
    await fs.writeFile(join(tempDir, 'src', 'Button.tsx'), sampleCode3)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        nsSeparator: ':',
        // defaultValue not specified, should default to empty string
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check app namespace with conflict resolution
    const appDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'app.json'), 'utf-8')
    const appDeTranslations = JSON.parse(appDeContent)

    expect(appDeTranslations).toEqual({
      title: '', // Empty string for missing defaultValue
      description: '',
    })

    // Check user namespace
    const userDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'user.json'), 'utf-8')
    const userDeTranslations = JSON.parse(userDeContent)

    expect(userDeTranslations).toEqual({
      name: '',
    })

    // Check button namespace
    const buttonDeContent = await fs.readFile(join(tempDir, 'locales', 'de', 'button.json'), 'utf-8')
    const buttonDeTranslations = JSON.parse(buttonDeContent)

    expect(buttonDeTranslations).toEqual({
      save: '',
      cancel: '',
    })

    // Primary language should resolve conflicts (last value wins)
    const appEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'app.json'), 'utf-8')
    const appEnTranslations = JSON.parse(appEnContent)

    expect(appEnTranslations).toEqual({
      title: 'New App Title', // Resolves conflict with new value
      description: 'App Description',
    })

    const userEnContent = await fs.readFile(join(tempDir, 'locales', 'en', 'user.json'), 'utf-8')
    const userEnTranslations = JSON.parse(userEnContent)

    expect(userEnTranslations).toEqual({
      name: 'User Name',
    })
  })

  it('should support i18next-parser style behavior using defaultValue: (key) => key', async () => {
    const sampleCode = `
      t('welcome.title', 'Welcome to our app');
      t('user.profile.name', 'Name');
      t('button.save', 'Save');
      t('error.network'); // No default value provided
      t('page.title'); // No default value provided
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), sampleCode)

    // Existing translation files where secondary languages have some but not all keys
    const existingDeTranslations = {
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation
      },
      // Missing: user.profile.name, button.save, error.network, page.title
    }

    const existingFrTranslations = {
      user: {
        profile: {
          name: 'Nom', // Existing translation
        },
      },
      // Missing: welcome.title, button.save, error.network, page.title
    }

    await fs.writeFile(
      join(tempDir, 'locales', 'de', 'translation.json'),
      JSON.stringify(existingDeTranslations, null, 2)
    )
    await fs.writeFile(
      join(tempDir, 'locales', 'fr', 'translation.json'),
      JSON.stringify(existingFrTranslations, null, 2)
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de', 'fr'],
      extract: {
        input: [normalizePath(join(tempDir, 'src/**/*.{ts,tsx}'))],
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        defaultNS: 'translation',
        // This mimics i18next-parser behavior: use the key itself as the default value
        // for missing translations in secondary languages
        defaultValue: (key: string) => key,
      },
    }

    const wasUpdated = await runExtractor(config, { isDryRun: false })

    expect(wasUpdated).toBe(true)

    // Check the German translation file
    const deContent = await fs.readFile(join(tempDir, 'locales', 'de', 'translation.json'), 'utf-8')
    const deTranslations = JSON.parse(deContent)

    expect(deTranslations).toEqual({
      button: {
        save: 'button.save', // Missing key uses key itself as default (i18next-parser style)
      },
      error: {
        network: 'error.network', // No default value in code, uses key itself
      },
      page: {
        title: 'page.title', // No default value in code, uses key itself
      },
      user: {
        profile: {
          name: 'user.profile.name', // Missing key uses key itself as default
        },
      },
      welcome: {
        title: 'Willkommen in unserer App', // Existing translation preserved
      },
    })

    // Check the French translation file
    const frContent = await fs.readFile(join(tempDir, 'locales', 'fr', 'translation.json'), 'utf-8')
    const frTranslations = JSON.parse(frContent)

    expect(frTranslations).toEqual({
      button: {
        save: 'button.save', // Missing key uses key itself as default
      },
      error: {
        network: 'error.network', // No default value in code, uses key itself
      },
      page: {
        title: 'page.title', // No default value in code, uses key itself
      },
      user: {
        profile: {
          name: 'Nom', // Existing translation preserved
        },
      },
      welcome: {
        title: 'welcome.title', // Missing key uses key itself as default
      },
    })

    // Check the primary language (English) uses the actual default values from code
    const enContent = await fs.readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8')
    const enTranslations = JSON.parse(enContent)

    expect(enTranslations).toEqual({
      button: {
        save: 'Save', // Primary language uses actual default values from code
      },
      error: {
        network: 'error.network', // No default in code, falls back to key (same as secondary languages)
      },
      page: {
        title: 'page.title', // No default in code, falls back to key (same as secondary languages)
      },
      user: {
        profile: {
          name: 'Name', // Primary language uses actual default values from code
        },
      },
      welcome: {
        title: 'Welcome to our app', // Primary language uses actual default values from code
      },
    })
  })
})
