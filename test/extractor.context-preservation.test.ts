import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { resolve } from 'path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

describe('context preservation in translation files', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])
  })

  it('should preserve context variants when base key is used with context', async () => {
    // Source code that uses a key with context - using conditional expression so we can extract both values
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        // Uses context with a conditional expression (which can be extracted)
        return <div>{t('friend', { context: isMale ? 'male' : 'female' })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context variants
    const existingTranslations = {
      friend: 'Friend',
      friend_male: 'Male friend',
      friend_female: 'Female friend',
      friend_other: 'Other friend', // Additional context variant not in code
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // The base key and ALL context variants should be preserved
    // even though 'friend_other' is not explicitly referenced in the code
    expect(result.newTranslations.friend).toBe('Friend')
    expect(result.newTranslations.friend_male).toBe('Male friend')
    expect(result.newTranslations.friend_female).toBe('Female friend')
    expect(result.newTranslations.friend_other).toBe('Other friend')
  })

  it('should preserve context variants with plural forms', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        // Uses context and count together with conditional expression
        return <div>{t('item', { context: isDigital ? 'digital' : 'physical', count: num })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context + plural variants
    const existingTranslations = {
      item_one: '{{count}} item',
      item_other: '{{count}} items',
      item_digital_one: '{{count}} digital item',
      item_digital_other: '{{count}} digital items',
      item_physical_one: '{{count}} physical item',
      item_physical_other: '{{count}} physical items',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All context + plural combinations should be preserved
    expect(result.newTranslations.item_one).toBeDefined()
    expect(result.newTranslations.item_other).toBeDefined()
    expect(result.newTranslations.item_digital_one).toBeDefined()
    expect(result.newTranslations.item_digital_other).toBeDefined()
    expect(result.newTranslations.item_physical_one).toBeDefined()
    expect(result.newTranslations.item_physical_other).toBeDefined()
  })

  it('should NOT preserve context variants when key is used WITHOUT context', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        // No context parameter
        return <div>{t('greeting')}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context variants
    const existingTranslations = {
      greeting: 'Hello',
      greeting_formal: 'Good day',
      greeting_casual: 'Hey',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // Only the base key should be preserved (no context variants)
    expect(result.newTranslations.greeting).toBe('Hello')
    expect(result.newTranslations.greeting_formal).toBeUndefined()
    expect(result.newTranslations.greeting_casual).toBeUndefined()
  })

  it('should not preserve context variants with static context values', async () => {
    const sampleCode = `
      function MyComponent() {
        const { t } = useTranslation();
        // Static context
        return <div>{t('status', { context: 'active' })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with multiple context variants
    const existingTranslations = {
      status_active: 'Active',
      status_inactive: 'Inactive',
      status_pending: 'Pending',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // Context variants should not be preserved because the base key is used with a static context.
    expect(result.newTranslations.status_active).toBe('Active')
    expect(result.newTranslations.status).toBeUndefined()
    expect(result.newTranslations.status_inactive).toBeUndefined()
    expect(result.newTranslations.status_pending).toBeUndefined()
  })

  it('should preserve context variants when used in Trans component', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      function MyComponent(props) {
        return <Trans i18nKey="message" context={isAdmin ? 'admin' : props.user}>Welcome</Trans>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context variants
    const existingTranslations = {
      message: 'Welcome',
      message_admin: 'Welcome, Administrator',
      message_user: 'Welcome, User',
      message_guest: 'Welcome, Guest',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All context variants should be preserved
    expect(result.newTranslations.message).toBeDefined()
    expect(result.newTranslations.message_admin).toBe('Welcome, Administrator')
    expect(result.newTranslations.message_user).toBe('Welcome, User')
    expect(result.newTranslations.message_guest).toBe('Welcome, Guest')
  })

  it('should preserve context variants when used in Trans component even if context is entirely dynamic', async () => {
    const sampleCode = `
      import { Trans } from 'react-i18next';

      function MyComponent(props) {
        return <Trans i18nKey="message" context={props.user}>Welcome</Trans>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context variants
    const existingTranslations = {
      message: 'Welcome',
      message_admin: 'Welcome, Administrator',
      message_user: 'Welcome, User',
      message_guest: 'Welcome, Guest',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All context variants should be preserved
    expect(result.newTranslations.message).toBeDefined()
    expect(result.newTranslations.message_admin).toBe('Welcome, Administrator')
    expect(result.newTranslations.message_user).toBe('Welcome, User')
    expect(result.newTranslations.message_guest).toBe('Welcome, Guest')
  })

  it('should work with custom context separator', async () => {
    const sampleCode = `
      function MyComponent(props) {
        const { t } = useTranslation();
        return <div>{t('title', { context: isAdvanced ? 'advanced' : props.title })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with custom separator
    const existingTranslations = {
      title: 'Title',
      'title--beginner': 'Beginner Title',
      'title--advanced': 'Advanced Title',
      'title--expert': 'Expert Title',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        contextSeparator: '--',
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All context variants with custom separator should be preserved
    expect(result.newTranslations.title).toBe('Title')
    expect(result.newTranslations['title--beginner']).toBe('Beginner Title')
    expect(result.newTranslations['title--advanced']).toBe('Advanced Title')
    expect(result.newTranslations['title--expert']).toBe('Expert Title')
  })

  it('should preserve nested key context variants', async () => {
    const sampleCode = `
      function MyComponent(props) {
        const { t } = useTranslation();
        return <div>{t('user.role.label', { context: isAdmin ? 'admin' : props.role })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with nested keys and context
    const existingTranslations = {
      user: {
        role: {
          label: 'Role',
          label_admin: 'Administrator Role',
          label_moderator: 'Moderator Role',
          label_viewer: 'Viewer Role',
        },
      },
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All nested context variants should be preserved
    expect(result.newTranslations.user.role.label).toBe('Role')
    expect(result.newTranslations.user.role.label_admin).toBe('Administrator Role')
    expect(result.newTranslations.user.role.label_moderator).toBe('Moderator Role')
    expect(result.newTranslations.user.role.label_viewer).toBe('Viewer Role')
  })

  it('should NOT preserve context variants when preserveContextVariants is false (default)', async () => {
    const sampleCode = `
      function MyComponent(props) {
        const { t } = useTranslation();
        return <div>{t('friend', { context: props.gender })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file with context variants
    const existingTranslations = {
      friend: 'Friend',
      friend_male: 'Male friend',
      friend_female: 'Female friend',
      friend_other: 'Other friend',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        // preserveContextVariants: false (default)
      },
    }

    const [result] = await extract(config)

    // Only explicitly extracted keys should be preserved
    expect(result.newTranslations.friend).toBe('Friend')
    expect(result.newTranslations.friend_male).toBeUndefined()
    expect(result.newTranslations.friend_female).toBeUndefined()
    expect(result.newTranslations.friend_other).toBeUndefined()
  })

  it('should correctly handle keys ending with plural-like suffixes', async () => {
    // This test ensures we don't confuse keys naturally ending in plural forms
    // (like 'formula_one') with plural variants
    const sampleCode = `
      function MyComponent(props) {
        const { t } = useTranslation();
        // 'formula_one' is a key that naturally ends with '_one', not a plural form
        return <div>{t('formula_one', { context: props.team })}</div>;
      }
    `

    vol.fromJSON({
      '/src/App.tsx': sampleCode,
    })

    // Existing translation file
    const existingTranslations = {
      formula_one: 'Formula One',
      formula_one_ferrari: 'Ferrari',
      formula_one_mc_laren: 'McLaren',
    }

    const enPath = resolve(process.cwd(), 'locales/en/translation.json')
    await vol.promises.mkdir(resolve(process.cwd(), 'locales/en'), { recursive: true })
    await vol.promises.writeFile(enPath, JSON.stringify(existingTranslations, null, 2))

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
        removeUnusedKeys: true,
        preserveContextVariants: true,
      },
    }

    const [result] = await extract(config)

    // All context variants of 'formula_one' should be preserved
    // The key is that 'formula_one' itself is the base key (not 'formula')
    expect(result.newTranslations.formula).toBeUndefined()
    expect(result.newTranslations.formula_one).toBe('Formula One')
    expect(result.newTranslations.formula_one_ferrari).toBe('Ferrari')
    expect(result.newTranslations.formula_one_mc_laren).toBe('McLaren')
  })
})
