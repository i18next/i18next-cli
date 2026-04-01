import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig, Plugin, PluginContext } from '../src/index'
import type { CallExpression, VariableDeclarator } from '@swc/core'
import { pathEndsWith } from './utils/path'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// ---------------------------------------------------------------------------
// Minimal plugin that unwraps Svelte 5 $derived.by() wrappers around
// useTranslation-style hooks so the extractor can resolve namespace/keyPrefix.
//
// This is the plugin logic that i18next-cli-plugin-svelte (or a similar plugin)
// would add to solve https://github.com/i18next/i18next-cli/issues/231.
// ---------------------------------------------------------------------------
const svelteDerivedPlugin = (): Plugin => ({
  name: 'svelte-derived-unwrap',

  onVisitNode (node, context: PluginContext) {
    if (node.type !== 'VariableDeclarator') return

    const declarator = node as unknown as VariableDeclarator
    const init = declarator.init
    if (!init || init.type !== 'CallExpression') return

    const outerCall = init as CallExpression

    // Detect $derived.by(<inner>) — MemberExpression callee
    let innerCall: CallExpression | undefined
    if (
      outerCall.callee.type === 'MemberExpression' &&
      outerCall.callee.object.type === 'Identifier' &&
      outerCall.callee.object.value === '$derived' &&
      outerCall.callee.property.type === 'Identifier' &&
      outerCall.callee.property.value === 'by'
    ) {
      const firstArg = outerCall.arguments?.[0]?.expression
      if (firstArg?.type === 'CallExpression') {
        innerCall = firstArg as CallExpression
      }
    }

    // Detect $derived(<inner>) — Identifier callee
    if (
      !innerCall &&
      outerCall.callee.type === 'Identifier' &&
      outerCall.callee.value === '$derived'
    ) {
      const firstArg = outerCall.arguments?.[0]?.expression
      if (firstArg?.type === 'CallExpression') {
        innerCall = firstArg as CallExpression
      }
    }

    if (!innerCall) return
    if (innerCall.callee.type !== 'Identifier') return

    const hookName = innerCall.callee.value

    // Check if the inner call matches a registered useTranslationNames entry
    const useTranslationNames = context.config.extract.useTranslationNames || ['useTranslation']
    let nsArgIndex = 0
    let kpArgIndex = 1
    let matched = false

    for (const item of useTranslationNames) {
      if (typeof item === 'string' && item === hookName) {
        matched = true
        break
      }
      if (typeof item === 'object' && item.name === hookName) {
        nsArgIndex = item.nsArg ?? 0
        kpArgIndex = item.keyPrefixArg ?? 1
        matched = true
        break
      }
    }

    if (!matched) return

    // Extract namespace and keyPrefix from the inner call's arguments
    const nsNode = nsArgIndex !== -1 ? innerCall.arguments?.[nsArgIndex]?.expression : undefined
    const kpNode = kpArgIndex !== -1 ? innerCall.arguments?.[kpArgIndex]?.expression : undefined

    const defaultNs = nsNode?.type === 'StringLiteral' ? nsNode.value : undefined
    const keyPrefix = kpNode?.type === 'StringLiteral' ? kpNode.value : undefined

    if (!defaultNs && !keyPrefix) return

    // Register destructured variables in scope
    if (declarator.id.type === 'ObjectPattern') {
      for (const prop of declarator.id.properties) {
        if (prop.type === 'AssignmentPatternProperty' && prop.key.type === 'Identifier') {
          context.setVarInScope(prop.key.value, { defaultNs, keyPrefix })
        }
        if (prop.type === 'KeyValuePatternProperty' && prop.value.type === 'Identifier') {
          context.setVarInScope(prop.value.value, { defaultNs, keyPrefix })
        }
      }
    } else if (declarator.id.type === 'Identifier') {
      context.setVarInScope(declarator.id.value, { defaultNs, keyPrefix })
    }
  },
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans'],
    defaultNS: 'translation',
    useTranslationNames: ['useTranslation', 'getTranslationContext'],
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('plugin: Svelte 5 $derived.by() wrapper unwrapping (#231)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // -----------------------------------------------------------------------
  // Sanity: without $derived.by, useTranslationNames works normally
  // -----------------------------------------------------------------------
  it('sanity: getTranslationContext without $derived.by resolves namespace', async () => {
    const sampleCode = `
      const { t } = getTranslationContext('my-namespace')
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const results = await extract(mockConfig)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'hello-world': 'Hello World',
    })
  })

  // -----------------------------------------------------------------------
  // Baseline: without the plugin, $derived.by wrapper breaks ns resolution
  // -----------------------------------------------------------------------
  it('baseline: without plugin, $derived.by(getTranslationContext(...)) falls back to defaultNS', async () => {
    const sampleCode = `
      const { t } = $derived.by(getTranslationContext('my-namespace'))
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    // No plugin — core cannot unwrap $derived.by
    const results = await extract(mockConfig)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    // Key should NOT be in my-namespace (core doesn't handle this)
    expect(nsFile).toBeUndefined()

    // It ends up in the default namespace instead
    const defaultFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(defaultFile).toBeDefined()
    expect(defaultFile!.newTranslations).toHaveProperty('hello-world')
  })

  // -----------------------------------------------------------------------
  // With plugin: $derived.by(getTranslationContext('ns')) resolves correctly
  // -----------------------------------------------------------------------
  it('with plugin, $derived.by(getTranslationContext(...)) resolves namespace', async () => {
    const sampleCode = `
      const { t } = $derived.by(getTranslationContext('my-namespace'))
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'hello-world': 'Hello World',
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: $derived (without .by) also works
  // -----------------------------------------------------------------------
  it('with plugin, $derived(getTranslationContext(...)) resolves namespace', async () => {
    const sampleCode = `
      const { t } = $derived(getTranslationContext('my-namespace'))
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'hello-world': 'Hello World',
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: multiple keys extracted with correct namespace
  // -----------------------------------------------------------------------
  it('with plugin, extracts multiple keys into the correct namespace', async () => {
    const sampleCode = `
      const { t } = $derived.by(getTranslationContext('my-namespace'))
      t('title', 'Title')
      t('description', 'Description')
      t('footer.text', 'Footer text')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      title: 'Title',
      description: 'Description',
      footer: {
        text: 'Footer text',
      },
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: destructured alias (const { t: translate } = ...)
  // -----------------------------------------------------------------------
  it('with plugin, handles destructured alias', async () => {
    const sampleCode = `
      const { t: translate } = $derived.by(getTranslationContext('my-namespace'))
      translate('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'hello-world': 'Hello World',
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: keyPrefix via custom hook config
  // -----------------------------------------------------------------------
  it('with plugin, resolves keyPrefix from $derived.by wrapper', async () => {
    const sampleCode = `
      const { t } = $derived.by(useCustomHook('myPrefix'))
      t('title', 'Title')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      extract: {
        ...mockConfig.extract,
        useTranslationNames: [
          'useTranslation',
          { name: 'useCustomHook', nsArg: -1, keyPrefixArg: 0 },
        ],
      },
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

    expect(translationFile).toBeDefined()
    expect(translationFile!.newTranslations).toEqual({
      myPrefix: {
        title: 'Title',
      },
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: non-$derived calls are not affected
  // -----------------------------------------------------------------------
  it('with plugin, does not interfere with non-$derived calls', async () => {
    const sampleCode = `
      const { t } = getTranslationContext('my-namespace')
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    const nsFile = results.find(r => pathEndsWith(r.path, '/locales/en/my-namespace.json'))

    expect(nsFile).toBeDefined()
    expect(nsFile!.newTranslations).toEqual({
      'hello-world': 'Hello World',
    })
  })

  // -----------------------------------------------------------------------
  // With plugin: unregistered hooks inside $derived.by are ignored
  // -----------------------------------------------------------------------
  it('with plugin, ignores $derived.by wrapping unknown functions', async () => {
    const sampleCode = `
      const { t } = $derived.by(someUnrelatedFunction('arg'))
      t('hello-world', 'Hello World')
    `
    vol.fromJSON({ '/src/App.tsx': sampleCode })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)
    // Key should fall back to the defaultNS since someUnrelatedFunction is not registered
    const defaultFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
    expect(defaultFile).toBeDefined()
    expect(defaultFile!.newTranslations).toHaveProperty('hello-world')
  })

  // -----------------------------------------------------------------------
  // With plugin: coexistence of $derived.by and normal useTranslation
  // -----------------------------------------------------------------------
  it('with plugin, both $derived.by wrapped and normal hooks work together', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx', '/src/Other.tsx'])

    vol.fromJSON({
      '/src/App.tsx': `
        const { t } = $derived.by(getTranslationContext('svelte-ns'))
        t('key1', 'Value 1')
      `,
      '/src/Other.tsx': `
        const { t } = useTranslation('react-ns')
        t('key2', 'Value 2')
      `,
    })

    const config: I18nextToolkitConfig = {
      ...mockConfig,
      plugins: [svelteDerivedPlugin()],
    }

    const results = await extract(config)

    const svelteFile = results.find(r => pathEndsWith(r.path, '/locales/en/svelte-ns.json'))
    expect(svelteFile).toBeDefined()
    expect(svelteFile!.newTranslations).toEqual({ key1: 'Value 1' })

    const reactFile = results.find(r => pathEndsWith(r.path, '/locales/en/react-ns.json'))
    expect(reactFile).toBeDefined()
    expect(reactFile!.newTranslations).toEqual({ key2: 'Value 2' })
  })
})
