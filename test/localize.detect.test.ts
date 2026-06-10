import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectStack, hasStackPlugin } from '../src/localize/detect'
import type { I18nextToolkitConfig } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

const noInitFile = async () => null

const packageJson = (deps: Record<string, string>) =>
  JSON.stringify({ name: 'app', dependencies: deps })

describe('detectStack', () => {
  beforeEach(() => {
    vol.reset()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects React', async () => {
    vol.fromJSON({ '/package.json': packageJson({ react: '^19.0.0' }) })
    const stack = await detectStack(noInitFile)
    expect(stack.framework).toBe('react')
    expect(stack.hasI18next).toBe(false)
    expect(stack.hasParaglide).toBe(false)
  })

  it('detects Next.js before React and flags the App Router', async () => {
    vol.fromJSON({
      '/package.json': packageJson({ next: '^15.0.0', react: '^19.0.0' }),
      '/app/page.tsx': 'export default function Page() {}',
    })
    const stack = await detectStack(noInitFile)
    expect(stack.framework).toBe('next')
    expect(stack.hasAppRouter).toBe(true)
  })

  it('does not flag the App Router for a pages-router Next app', async () => {
    vol.fromJSON({
      '/package.json': packageJson({ next: '^15.0.0', react: '^19.0.0' }),
      '/pages/index.tsx': 'export default function Page() {}',
    })
    const stack = await detectStack(noInitFile)
    expect(stack.framework).toBe('next')
    expect(stack.hasAppRouter).toBe(false)
  })

  it('detects Vue', async () => {
    vol.fromJSON({ '/package.json': packageJson({ vue: '^3.0.0' }) })
    const stack = await detectStack(noInitFile)
    expect(stack.framework).toBe('vue')
  })

  it('detects i18next presence and TypeScript', async () => {
    vol.fromJSON({
      '/package.json': packageJson({ react: '^19.0.0', 'react-i18next': '^15.0.0' }),
      '/tsconfig.json': '{}',
    })
    const stack = await detectStack(noInitFile)
    expect(stack.hasI18next).toBe(true)
    expect(stack.hasTypeScript).toBe(true)
  })

  it('returns unknown framework when package.json is missing', async () => {
    const stack = await detectStack(noInitFile)
    expect(stack.framework).toBe('unknown')
    expect(stack.hasI18next).toBe(false)
  })

  it('passes through the injected init-file locator result', async () => {
    vol.fromJSON({ '/package.json': packageJson({ react: '^19.0.0' }) })
    const stack = await detectStack(async () => 'src/i18n.ts')
    expect(stack.initFile).toBe('src/i18n.ts')
  })

  describe('Paraglide guard', () => {
    it('detects @inlang/paraglide-js as a dependency', async () => {
      vol.fromJSON({ '/package.json': packageJson({ svelte: '^5.0.0', '@inlang/paraglide-js': '^2.0.0' }) })
      const stack = await detectStack(noInitFile)
      expect(stack.hasParaglide).toBe(true)
    })

    it('detects a project.inlang directory', async () => {
      vol.fromJSON({
        '/package.json': packageJson({ react: '^19.0.0' }),
        '/project.inlang/settings.json': '{}',
      })
      const stack = await detectStack(noInitFile)
      expect(stack.hasParaglide).toBe(true)
    })
  })
})

describe('hasStackPlugin', () => {
  const configWith = (plugins: any[]): I18nextToolkitConfig => ({
    locales: ['en'],
    extract: { input: ['src/'], output: 'locales/{{language}}.json' },
    plugins,
  })

  it('matches a plugin declaring instrumentExtensions for the stack', () => {
    const config = configWith([{ name: 'vue-plugin', instrumentExtensions: ['.vue'] }])
    expect(hasStackPlugin(config, 'vue')).toBe(true)
  })

  it('matches a plugin declaring lintExtensions for the stack', () => {
    const config = configWith([{ name: 'svelte-plugin', lintExtensions: ['svelte'] }])
    expect(hasStackPlugin(config, 'svelte')).toBe(true)
  })

  it('returns false when no plugin covers the stack', () => {
    const config = configWith([{ name: 'other-plugin', instrumentExtensions: ['.pug'] }])
    expect(hasStackPlugin(config, 'vue')).toBe(false)
  })

  it('returns false without plugins or for natively supported frameworks', () => {
    expect(hasStackPlugin(configWith([]), 'vue')).toBe(false)
    const config = configWith([{ name: 'vue-plugin', instrumentExtensions: ['.vue'] }])
    expect(hasStackPlugin(config, 'react')).toBe(false)
  })
})
