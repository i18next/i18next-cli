import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { I18nextToolkitConfig } from '../types.js'

/** Frontend framework classification used by the `localize` orchestrator. */
export type DetectedFramework = 'react' | 'next' | 'vue' | 'svelte' | 'angular' | 'unknown'

export interface DetectedStack {
  /** The detected frontend framework (`next` takes precedence over `react`). */
  framework: DetectedFramework
  /** Whether i18next (or a framework binding like react-i18next) is a dependency */
  hasI18next: boolean
  /** Whether TypeScript is in use (tsconfig.json present) */
  hasTypeScript: boolean
  /** Path of an existing i18n init file (relative to cwd), if any */
  initFile: string | null
  /** Next.js App Router detected (`app/` or `src/app/` directory) */
  hasAppRouter: boolean
  /** The app uses inlang Paraglide (`@inlang/paraglide-js` or a `project.inlang/` dir) */
  hasParaglide: boolean
}

async function pathExists (path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readPackageDeps (): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(process.cwd(), 'package.json'), 'utf-8')
    const packageJson = JSON.parse(content)
    return { ...packageJson.dependencies, ...packageJson.devDependencies }
  } catch {
    return {}
  }
}

/**
 * Detects the project stack relevant to the `localize` orchestrator:
 * frontend framework, i18next presence, an existing i18n init file,
 * Next.js App Router usage and inlang Paraglide usage.
 *
 * All checks are `process.cwd()`-relative (run from the package directory
 * in monorepos).
 *
 * @param findInitFile - locator for an existing i18n init file
 *                       (injected to reuse the instrumenter's implementation)
 */
export async function detectStack (
  findInitFile: () => Promise<string | null>
): Promise<DetectedStack> {
  const deps = await readPackageDeps()
  const has = (name: string) => !!deps[name]

  let framework: DetectedFramework = 'unknown'
  if (has('next')) framework = 'next'
  else if (has('react') || has('react-i18next')) framework = 'react'
  else if (has('vue') || has('nuxt')) framework = 'vue'
  else if (has('svelte') || has('@sveltejs/kit')) framework = 'svelte'
  else if (has('@angular/core')) framework = 'angular'

  const cwd = process.cwd()
  const hasAppRouter = framework === 'next' &&
    (await pathExists(join(cwd, 'app')) || await pathExists(join(cwd, 'src', 'app')))

  const hasParaglide = has('@inlang/paraglide-js') || await pathExists(join(cwd, 'project.inlang'))

  return {
    framework,
    hasI18next: has('i18next') || has('react-i18next'),
    hasTypeScript: await pathExists(join(cwd, 'tsconfig.json')),
    initFile: await findInitFile(),
    hasAppRouter,
    hasParaglide,
  }
}

/** File extensions associated with frameworks the instrumenter cannot transform natively. */
const STACK_EXTENSIONS: Partial<Record<DetectedFramework, string[]>> = {
  vue: ['.vue', 'vue'],
  svelte: ['.svelte', 'svelte'],
}

/**
 * Checks whether a configured plugin covers the detected stack's file
 * extension via `instrumentExtensions` or `lintExtensions` — in which case
 * the instrument/extract runners can process the stack's files through the
 * plugin hooks and `localize` runs the full flow.
 */
export function hasStackPlugin (config: I18nextToolkitConfig, framework: DetectedFramework): boolean {
  const extensions = STACK_EXTENSIONS[framework]
  if (!extensions || !config.plugins?.length) return false
  return config.plugins.some((plugin: any) => {
    const declared: string[] = [
      ...(plugin.instrumentExtensions || []),
      ...(plugin.lintExtensions || []),
    ]
    return declared.some(ext => extensions.includes(ext))
  })
}
