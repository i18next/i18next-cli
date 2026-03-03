import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter, writeExtractedKeys } from '../src/instrumenter'
import type { I18nextToolkitConfig, Logger } from '../src/types'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { normalizePath } from './utils/path'

// Silent logger for test runs
const silentLogger: Logger = {
  info () {},
  warn () {},
  error () {}
}

describe('instrumenter integration', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-instrument-'))

    // Create project directory structure
    await fs.mkdir(join(tempDir, 'src', 'components'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'pages'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'utils'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales', 'en'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales', 'de'), { recursive: true })

    // Create package.json with React dependency
    await fs.writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: {
          react: '^18.0.0',
          'react-i18next': '^13.0.0',
          i18next: '^23.0.0'
        }
      }, null, 2)
    )

    // Create tsconfig.json so the generated init file uses .ts
    await fs.writeFile(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
    )

    // ── Source files ──

    // React component with user-facing strings
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'Greeting.tsx'),
      `import React from 'react'

export function Greeting () {
  const welcomeMessage = "Welcome to our application"
  const instructions = "Please sign in to continue"

  return (
    <div className="greeting-container">
      <h1>{welcomeMessage}</h1>
      <p>{instructions}</p>
    </div>
  )
}
`
    )

    // Another React component with several string types
    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'Dashboard.tsx'),
      `import React from 'react'

export function Dashboard () {
  const pageTitle = "Your dashboard is ready to use"
  const errorMsg = "Something went wrong. Please try again."
  const btnLabel = "Save your changes"

  console.log("Debug: rendering dashboard")

  return (
    <div>
      <h1>{pageTitle}</h1>
      <p className="error-text">{errorMsg}</p>
      <button>{btnLabel}</button>
      <a href="https://docs.example.com">Docs</a>
    </div>
  )
}
`
    )

    // Plain TypeScript utility with user-facing messages
    await fs.writeFile(
      join(tempDir, 'src', 'utils', 'messages.ts'),
      `export function getMessages () {
  return {
    title: "Welcome back to your account",
    description: "You have new notifications waiting",
    emptyState: "There are no items to display",
    errorFallback: "An unexpected error occurred. Please contact support."
  }
}
`
    )

    // Config / constants file — mostly technical, nothing should be instrumented
    await fs.writeFile(
      join(tempDir, 'src', 'config.ts'),
      `export const API_URL = "https://api.example.com/v2"
export const ERROR_PREFIX = "INVALID_TOKEN"
export const CSS_CLASS = "btn-primary"
export const DATE_FORMAT = "yyyy-mm-dd"
`
    )

    // File with template literals (backtick strings)
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'Notices.tsx'),
      `import React from 'react'

export function Notices () {
  const notice = \`Your session is about to expire\`
  const interpolated = \`Hello \${name}\`
  const technical = \`btn-primary\`

  return (
    <div>
      <p>{notice}</p>
      <p>{interpolated}</p>
    </div>
  )
}
`
    )

    // Switch cwd so isProjectUsingReact reads the temp project's package.json
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeConfig (overrides?: Partial<I18nextToolkitConfig['extract']>): I18nextToolkitConfig {
    return {
      locales: ['en', 'de'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        functions: ['t'],
        transComponents: ['Trans'],
        primaryLanguage: 'en',
        secondaryLanguages: ['de'],
        defaultNS: 'translation',
        ...overrides
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Dry-run: no files should be modified
  // ─────────────────────────────────────────────────────────────────────
  it('dry run detects candidates without modifying source files', async () => {
    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)

    // Should have found candidates across multiple files
    expect(results.totalCandidates).toBeGreaterThan(0)
    expect(results.files.length).toBeGreaterThan(0)

    // Source files must remain untouched
    const greetingSrc = await readFile(join(tempDir, 'src', 'components', 'Greeting.tsx'), 'utf-8')
    expect(greetingSrc).toContain('"Welcome to our application"')
    expect(greetingSrc).toContain('"Please sign in to continue"')
    expect(greetingSrc).not.toContain("t('")

    const dashboardSrc = await readFile(join(tempDir, 'src', 'pages', 'Dashboard.tsx'), 'utf-8')
    expect(dashboardSrc).toContain('"Your dashboard is ready to use"')
    expect(dashboardSrc).not.toContain("t('")
  })

  // ─────────────────────────────────────────────────────────────────────
  // Full run: source files are rewritten with t() calls
  // ─────────────────────────────────────────────────────────────────────
  it('instruments source files with t() calls in a real project', async () => {
    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // ── Aggregate counts ──
    expect(results.totalCandidates).toBeGreaterThan(0)
    expect(results.totalTransformed).toBeGreaterThan(0)
    expect(results.files.length).toBeGreaterThan(0)

    // ── Greeting.tsx ──
    const greetingSrc = await readFile(join(tempDir, 'src', 'components', 'Greeting.tsx'), 'utf-8')

    // User-facing strings should be wrapped in t()
    expect(greetingSrc).toContain("t('")
    expect(greetingSrc).toContain('Welcome to our application')
    expect(greetingSrc).toContain('Please sign in to continue')
    // The original bare string literals should be gone
    expect(greetingSrc).not.toContain('"Welcome to our application"')
    expect(greetingSrc).not.toContain('"Please sign in to continue"')

    // CSS class name must NOT have been touched
    expect(greetingSrc).toContain('"greeting-container"')

    // An import for react-i18next should have been injected
    expect(greetingSrc).toContain('react-i18next')
    // useTranslation hook should be auto-injected inside the component
    expect(greetingSrc).toContain('const { t } = useTranslation()')
    expect(greetingSrc).not.toContain('TODO')

    // ── Dashboard.tsx ──
    const dashboardSrc = await readFile(join(tempDir, 'src', 'pages', 'Dashboard.tsx'), 'utf-8')

    // User-facing strings should be wrapped
    expect(dashboardSrc).toContain("t('")
    expect(dashboardSrc).toContain('Your dashboard is ready to use')
    expect(dashboardSrc).toContain('Save your changes')
    expect(dashboardSrc).not.toContain('"Your dashboard is ready to use"')
    expect(dashboardSrc).not.toContain('"Save your changes"')

    // Sentences with periods must also be instrumented (not skipped as "URL")
    expect(dashboardSrc).toContain('Something went wrong. Please try again.')
    expect(dashboardSrc).not.toContain('"Something went wrong. Please try again."')

    // Console.log argument should NOT be transformed
    expect(dashboardSrc).toContain('"Debug: rendering dashboard"')

    // CSS class still intact
    expect(dashboardSrc).toContain('"error-text"')

    // URL still intact
    expect(dashboardSrc).toContain('"https://docs.example.com"')

    // ── messages.ts ──
    const messagesSrc = await readFile(join(tempDir, 'src', 'utils', 'messages.ts'), 'utf-8')

    // User-facing messages should be instrumented with i18next.t() (not a React component)
    expect(messagesSrc).toContain("i18next.t('")
    expect(messagesSrc).toContain('Welcome back to your account')
    expect(messagesSrc).not.toContain('"Welcome back to your account"')

    // Sentence with period should also be instrumented
    expect(messagesSrc).toContain('An unexpected error occurred. Please contact support.')
    expect(messagesSrc).not.toContain('"An unexpected error occurred. Please contact support."')

    // Non-component files in a React project should use i18next import
    expect(messagesSrc).toContain("import i18next from 'i18next'")
  })

  // ─────────────────────────────────────────────────────────────────────
  // Technical / config file should remain entirely untouched
  // ─────────────────────────────────────────────────────────────────────
  it('does not instrument technical strings, URLs, or error codes', async () => {
    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const configSrc = await readFile(join(tempDir, 'src', 'config.ts'), 'utf-8')

    // Nothing in this file should have been transformed
    expect(configSrc).not.toContain("t('")
    expect(configSrc).toContain('"https://api.example.com/v2"')
    expect(configSrc).toContain('"INVALID_TOKEN"')
    expect(configSrc).toContain('"btn-primary"')
    expect(configSrc).toContain('"yyyy-mm-dd"')
  })

  // ─────────────────────────────────────────────────────────────────────
  // writeExtractedKeys persists discovered translations to disk
  // ─────────────────────────────────────────────────────────────────────
  it('writes extracted keys to translation JSON files', async () => {
    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Collect all candidates from all files
    const allCandidates = results.files.flatMap(f => f.candidates)
    expect(allCandidates.length).toBeGreaterThan(0)

    // Write the keys
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const translationFilePath = join(tempDir, 'locales', 'en', 'translation.json')
    const translationContent = await readFile(translationFilePath, 'utf-8')
    const translations = JSON.parse(translationContent)

    // Every candidate that had a key should appear in the JSON
    for (const candidate of allCandidates) {
      if (candidate.key) {
        expect(translations).toHaveProperty(candidate.key)
        expect(translations[candidate.key]).toBe(candidate.content)
      }
    }

    // Spot-check a couple of well-known values
    expect(Object.values(translations)).toContain('Welcome to our application')
    expect(Object.values(translations)).toContain('Save your changes')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Result shape: every file result has meaningful data
  // ─────────────────────────────────────────────────────────────────────
  it('returns well-structured results for each processed file', async () => {
    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)

    for (const fileResult of results.files) {
      // Every result references an existing source file
      expect(fileResult.file).toBeTruthy()
      const stat = await fs.stat(fileResult.file)
      expect(stat.isFile()).toBe(true)

      // Candidates have required fields
      for (const candidate of fileResult.candidates) {
        expect(candidate.content).toBeTruthy()
        expect(candidate.confidence).toBeGreaterThanOrEqual(0.7)
        expect(candidate.offset).toBeGreaterThanOrEqual(0)
        expect(candidate.endOffset).toBeGreaterThan(candidate.offset)
        expect(candidate.line).toBeGreaterThan(0)
        expect(typeof candidate.key).toBe('string')
      }

      // TransformResult has a diff in dry-run mode
      expect(fileResult.result.diff).toBeTruthy()
      expect(fileResult.result.transformCount).toBeGreaterThan(0)
    }
  })

  // ─────────────────────────────────────────────────────────────────────
  // Second run is idempotent: already-instrumented strings are skipped
  // ─────────────────────────────────────────────────────────────────────
  it('second run does not double-instrument already transformed strings', async () => {
    const config = makeConfig()

    // First pass
    const firstResults = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    expect(firstResults.totalTransformed).toBeGreaterThan(0)

    // Second pass on the same (now-instrumented) files
    const secondResults = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // No new transformations should occur
    expect(secondResults.totalTransformed).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────────────
  // i18n init file is auto-generated when missing
  // ─────────────────────────────────────────────────────────────────────
  it('generates bundled-resources init file when i18next.t() is used (React + sync)', async () => {
    // The default project has messages.ts (utility file → i18next.t()) plus React components,
    // so the strategy should be 'bundled-resources' (synchronous).
    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const initFilePath = join(tempDir, 'src', 'i18n.ts')
    const initContent = await readFile(initFilePath, 'utf-8')

    // Should have core imports
    expect(initContent).toContain("import i18next from 'i18next'")
    expect(initContent).toContain('initReactI18next')
    expect(initContent).toContain('.init(')
    expect(initContent).toContain("fallbackLng: 'en'")
    expect(initContent).toContain("defaultNS: 'translation'")
    expect(initContent).toContain('locize.com')

    // Bundled-resources: static imports of locale JSON files + resources option
    expect(initContent).toMatch(/import enTranslation from ['"].*locales\/en\/translation\.json['"]/)
    expect(initContent).toMatch(/import deTranslation from ['"].*locales\/de\/translation\.json['"]/)
    expect(initContent).toContain('resources: {')
    expect(initContent).toContain('en: { translation: enTranslation }')
    expect(initContent).toContain('de: { translation: deTranslation }')

    // Should NOT use resources-to-backend (async) since i18next.t() needs sync resources
    expect(initContent).not.toContain('resourcesToBackend')
    expect(initContent).not.toContain('import(`')
  })

  it('generates resources-to-backend init file for React-only project (no i18next.t())', async () => {
    // Remove the utility file so only React components remain (all use t() from hook)
    const { unlink } = await import('node:fs/promises')
    try { await unlink(join(tempDir, 'src', 'utils', 'messages.ts')) } catch { /* ignore */ }

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const initFilePath = join(tempDir, 'src', 'i18n.ts')
    const initContent = await readFile(initFilePath, 'utf-8')

    // React project with no i18next.t() → async resources-to-backend
    expect(initContent).toContain("import i18next from 'i18next'")
    expect(initContent).toContain('initReactI18next')
    expect(initContent).toContain("import resourcesToBackend from 'i18next-resources-to-backend'")
    expect(initContent).toContain('.use(resourcesToBackend(')
    expect(initContent).toContain('import(`')
    expect(initContent).toContain("fallbackLng: 'en'")
    expect(initContent).toContain("defaultNS: 'translation'")

    // Dynamic import path should be relative from src/ to locales/
    expect(initContent).toMatch(/import\(`\.\.\/.*locales\/\$\{language\}\/\$\{namespace\}\.json`\)/)

    // Should NOT have bundled resources
    expect(initContent).not.toContain('resources: {')
  })

  it('generates fs-backend init file for non-React (server-side) project', async () => {
    // Rewrite package.json WITHOUT React but WITH a server framework
    await fs.writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-server-project',
        dependencies: { i18next: '^23.0.0', express: '^4.0.0' }
      }, null, 2)
    )

    // Remove React components, keep only a plain TS utility with strings
    const { unlink } = await import('node:fs/promises')
    for (const f of ['Greeting.tsx', 'Notices.tsx']) {
      try { await unlink(join(tempDir, 'src', 'components', f)) } catch { /* ignore */ }
    }
    try { await unlink(join(tempDir, 'src', 'pages', 'Dashboard.tsx')) } catch { /* ignore */ }

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const initFilePath = join(tempDir, 'src', 'i18n.ts')
    const initContent = await readFile(initFilePath, 'utf-8')

    // Server-side → fs-backend
    expect(initContent).toContain("import i18next from 'i18next'")
    expect(initContent).toContain("import Backend from 'i18next-fs-backend'")
    expect(initContent).toContain('.use(Backend)')
    expect(initContent).toContain('initImmediate: false,')
    expect(initContent).toContain("preload: ['en', 'de']")
    expect(initContent).toContain('backend: {')
    expect(initContent).toContain('loadPath:')
    expect(initContent).toContain('{{lng}}')
    expect(initContent).toContain('{{ns}}')
    expect(initContent).toContain("fallbackLng: 'en'")
    expect(initContent).toContain('await i18next')

    // Should import path utilities for __dirname
    expect(initContent).toContain("from 'node:path'")
    expect(initContent).toContain("from 'node:url'")
    expect(initContent).toContain('import.meta.url')

    // Should NOT have React-specific imports
    expect(initContent).not.toContain('initReactI18next')
    expect(initContent).not.toContain('resourcesToBackend')
  })

  it('generates bundled-resources init for unknown environment (no React, no server framework)', async () => {
    // Package.json with only i18next — no React, no server framework, no bundler.
    // The utility file (messages.ts) causes i18next.t() to be emitted, so
    // usesI18nextT=true → bundled-resources (works everywhere, synchronous).
    // Crucially, it should NOT default to fs-backend since we can't assume
    // filesystem access in an unknown environment.
    await fs.writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-unknown-project',
        dependencies: { i18next: '^23.0.0' }
      }, null, 2)
    )

    // Remove React components, keep only the plain TS utility with strings
    const { unlink } = await import('node:fs/promises')
    for (const f of ['Greeting.tsx', 'Notices.tsx']) {
      try { await unlink(join(tempDir, 'src', 'components', f)) } catch { /* ignore */ }
    }
    try { await unlink(join(tempDir, 'src', 'pages', 'Dashboard.tsx')) } catch { /* ignore */ }

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const initFilePath = join(tempDir, 'src', 'i18n.ts')
    const initContent = await readFile(initFilePath, 'utf-8')

    // Unknown environment with i18next.t() → bundled-resources (synchronous, portable)
    expect(initContent).toContain("import i18next from 'i18next'")
    expect(initContent).toContain('resources: {')
    expect(initContent).toMatch(/import \w+Translation from ['"]/)
    expect(initContent).toContain("fallbackLng: 'en'")

    // Should NOT use fs-backend (can't assume filesystem) or React imports
    expect(initContent).not.toContain('i18next-fs-backend')
    expect(initContent).not.toContain('initReactI18next')
    expect(initContent).not.toContain('initImmediate')
  })

  it('generates bundled-resources init for edge runtime project', async () => {
    // Package.json with Cloudflare Workers types (edge environment)
    await fs.writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-edge-project',
        dependencies: { i18next: '^23.0.0' },
        devDependencies: { '@cloudflare/workers-types': '^4.0.0', wrangler: '^3.0.0' }
      }, null, 2)
    )

    // Write a plain utility file so i18next.t() is used
    const { unlink } = await import('node:fs/promises')
    for (const f of ['Greeting.tsx', 'Notices.tsx']) {
      try { await unlink(join(tempDir, 'src', 'components', f)) } catch { /* ignore */ }
    }
    try { await unlink(join(tempDir, 'src', 'pages', 'Dashboard.tsx')) } catch { /* ignore */ }

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const initFilePath = join(tempDir, 'src', 'i18n.ts')
    const initContent = await readFile(initFilePath, 'utf-8')

    // Edge with i18next.t() → bundled-resources (no filesystem on edge)
    expect(initContent).toContain("import i18next from 'i18next'")
    expect(initContent).toContain('resources: {')
    expect(initContent).toMatch(/import \w+Translation from ['"]/)

    // Should NOT have fs-backend or React-specific imports
    expect(initContent).not.toContain('i18next-fs-backend')
    expect(initContent).not.toContain('initReactI18next')
    expect(initContent).not.toContain('initImmediate')
  })

  // ─────────────────────────────────────────────────────────────────────
  // useTranslation hook is injected in React function components
  // ─────────────────────────────────────────────────────────────────────
  it('injects useTranslation() hook into React function components', async () => {
    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Greeting.tsx — FunctionDeclaration component
    const greetingSrc = await readFile(join(tempDir, 'src', 'components', 'Greeting.tsx'), 'utf-8')
    expect(greetingSrc).toContain('const { t } = useTranslation()')
    expect(greetingSrc).toContain("import { useTranslation } from 'react-i18next'")

    // Dashboard.tsx — FunctionDeclaration component
    const dashboardSrc = await readFile(join(tempDir, 'src', 'pages', 'Dashboard.tsx'), 'utf-8')
    expect(dashboardSrc).toContain('const { t } = useTranslation()')
    expect(dashboardSrc).toContain("import { useTranslation } from 'react-i18next'")

    // messages.ts — plain utility, should NOT have useTranslation
    const messagesSrc = await readFile(join(tempDir, 'src', 'utils', 'messages.ts'), 'utf-8')
    expect(messagesSrc).not.toContain('useTranslation')
    expect(messagesSrc).toContain("import i18next from 'i18next'")
  })

  // ─────────────────────────────────────────────────────────────────────
  // Template literals: static and interpolated backtick strings
  // ─────────────────────────────────────────────────────────────────────
  it('instruments static and interpolated template literals', async () => {
    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const noticesSrc = await readFile(join(tempDir, 'src', 'components', 'Notices.tsx'), 'utf-8')

    // Static template literal should be instrumented
    expect(noticesSrc).toContain('Your session is about to expire')
    expect(noticesSrc).not.toContain('`Your session is about to expire`')
    expect(noticesSrc).toContain("t('")

    // Interpolated template literal should now be instrumented with i18next interpolation
    expect(noticesSrc).toContain('Hello {{name}}')
    expect(noticesSrc).toContain('{ name }')
    expect(noticesSrc).not.toContain('`Hello $' + '{name}`')

    // Technical string in backticks should remain untouched (low confidence)
    expect(noticesSrc).toContain('`btn-primary`')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Namespace targeting: --namespace writes to the specified namespace
  // ─────────────────────────────────────────────────────────────────────
  it('uses the specified namespace in generated code', async () => {
    const config = makeConfig()
    const results = await runInstrumenter(config, {
      isDryRun: false,
      quiet: true,
      namespace: 'common'
    }, silentLogger)

    expect(results.totalTransformed).toBeGreaterThan(0)

    // Non-component file should use i18next.t with { ns: 'common' }
    const messagesSrc = await readFile(join(tempDir, 'src', 'utils', 'messages.ts'), 'utf-8')
    expect(messagesSrc).toContain("{ ns: 'common' }")

    // React component should use useTranslation('common')
    const greetingSrc = await readFile(join(tempDir, 'src', 'components', 'Greeting.tsx'), 'utf-8')
    expect(greetingSrc).toContain("useTranslation('common')")
  })

  // ─────────────────────────────────────────────────────────────────────
  // Custom scorer: instrumentScorer overrides built-in confidence
  // ─────────────────────────────────────────────────────────────────────
  it('respects custom instrumentScorer from config', async () => {
    // Use a scorer that skips everything containing "Welcome" but boosts everything else to 1.0
    const config = makeConfig({
      instrumentScorer: (content: string) => {
        if (content.includes('Welcome')) return null
        return 1.0
      }
    })
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    expect(results.totalTransformed).toBeGreaterThan(0)

    // Greeting.tsx — "Welcome to our application" should NOT be instrumented (scorer returned null)
    const greetingSrc = await readFile(join(tempDir, 'src', 'components', 'Greeting.tsx'), 'utf-8')
    expect(greetingSrc).toContain('"Welcome to our application"') // still a raw string
    // But "Please sign in to continue" should be instrumented (scorer returned 1.0)
    expect(greetingSrc).not.toContain('"Please sign in to continue"')
    expect(greetingSrc).toContain('Please sign in to continue')
  })

  // ─────────────────────────────────────────────────────────────────────
  // export default function: must be detected as a React component
  // ─────────────────────────────────────────────────────────────────────
  it('detects export default function as a component and uses useTranslation hook', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'TasksPage.tsx'),
      'import React from \'react\'\n\nexport default function TasksPage() {\n  return (\n    <div>\n      <h1>My Tasks</h1>\n      <p>You have no tasks left — enjoy your day!</p>\n    </div>\n  )\n}\n'
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'pages', 'TasksPage.tsx'), 'utf-8')

    // Should use the hook style t(), not i18next.t()
    expect(src).toContain('const { t } = useTranslation()')
    expect(src).toContain("t('")
    expect(src).not.toContain('i18next.t(')

    // Strings should still appear as default values
    expect(src).toContain('My Tasks')
    expect(src).toContain('enjoy your day')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Multi-byte characters: offsets must not drift
  // ─────────────────────────────────────────────────────────────────────
  it('handles files with emoji and non-ASCII characters correctly', async () => {
    // This file has emojis BEFORE the translatable strings, which would
    // cause progressive offset drift if byte offsets are used as char indices.
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'EmojiPage.tsx'),
      `import React from 'react'

const ICONS: Record<string, string> = {
  work: '💼',
  personal: '🌱',
  shopping: '🛒',
  health: '💪',
}

export function EmojiPage () {
  return (
    <div>
      <h1>Welcome to your task manager</h1>
      <p>You have no tasks left — enjoy your day!</p>
      <button>Add a new task</button>
      <input placeholder="Search your tasks…" />
    </div>
  )
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'EmojiPage.tsx'), 'utf-8')

    // The transformed output must be syntactically valid:
    // - No broken variable names or corrupted JSX
    // - useTranslation hook should be on its own line after the opening brace
    // - Translated strings should be properly wrapped

    // The original raw strings should no longer appear unwrapped
    expect(src).not.toContain('>Welcome to your task manager<')
    expect(src).not.toContain('>Add a new task<')

    // The translated strings should be wrapped in t() calls
    expect(src).toContain("t('")
    expect(src).toContain('Welcome to your task manager')
    expect(src).toContain('Add a new task')

    // useTranslation hook should be injected cleanly, not mid-line
    expect(src).toMatch(/const \{ t \} = useTranslation\(\)/)
    // The hook injection should NOT corrupt surrounding code
    expect(src).not.toMatch(/const \{ t \} = useTranslation\(\)\w/) // no trailing word char

    // The emoji constants must remain untouched
    expect(src).toContain("'💼'")
    expect(src).toContain("'🌱'")
    expect(src).toContain("'🛒'")
    expect(src).toContain("'💪'")

    // Verify the file can be parsed by SWC (valid syntax)
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('handles files with mixed multi-byte chars and JSX attributes', async () => {
    // Emojis as JSX text + translatable attributes + non-translatable attributes
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'MixedChars.tsx'),
      `import React from 'react'

export function MixedChars () {
  return (
    <div className="container">
      <span>⚙</span>
      <span>✦</span>
      <h2>Manage your preferences</h2>
      <p>Choose the display language for the interface.</p>
      <input type="text" placeholder="Enter your name here" />
      <button aria-label="Save your settings">Save</button>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M1 1L11 11M11 1L1 11" stroke="currentColor"/>
      </svg>
    </div>
  )
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'MixedChars.tsx'), 'utf-8')

    // Translatable strings should be wrapped
    expect(src).toContain('Manage your preferences')
    expect(src).toContain('Choose the display language for the interface.')
    expect(src).toContain('Enter your name here')
    expect(src).toContain('Save your settings')

    // SVG attributes must NOT be wrapped (viewBox, d, width, etc.)
    expect(src).not.toContain("t('001212")
    expect(src).not.toContain("t('m11l1111")

    // The file must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Ignore-comment directive: strings on the next line must not be instrumented
  // ───────────────────────────────────────────────────────────────────────────
  it('respects i18next-instrument-ignore-next-line comment directives', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'SeedData.tsx'),
      [
        "import React from 'react'",
        '',
        'interface Todo { id: number; text: string; completed: boolean }',
        '',
        '// i18next-instrument-ignore-next-line',
        'const LABEL_DESIGN = "Design the app mockup"',
        '/* i18next-instrument-ignore */',
        'const LABEL_SETUP = "Set up the Vite project"',
        '',
        'const INITIAL_TODOS: Todo[] = [',
        '  { id: 1, text: LABEL_DESIGN, completed: true },',
        '  { id: 2, text: LABEL_SETUP, completed: true },',
        ']',
        '',
        'export default function SeedPage() {',
        '  return (',
        '    <div>',
        '      <h1>My Todos</h1>',
        '      <p>Welcome back</p>',
        '    </div>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'SeedData.tsx'), 'utf-8')

    // The two ignored strings must NOT be wrapped
    expect(src).toContain('const LABEL_DESIGN = "Design the app mockup"')
    expect(src).toContain('const LABEL_SETUP = "Set up the Vite project"')

    // Non-ignored strings SHOULD be wrapped
    expect(src).toContain("t('myTodos', 'My Todos')")
    expect(src).toContain("t('welcomeBack', 'Welcome back')")

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Template-literal interpolation: `${count}-day streak` → t() with {{count}}
  // ───────────────────────────────────────────────────────────────────────────
  it('instruments template literals with interpolation using i18next {{}} syntax', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'StreakBadge.tsx'),
      [
        "import React from 'react'",
        '',
        'export function StreakBadge({ days, user }: { days: number; user: { name: string } }) {',
        '  return (',
        '    <div>',
        // eslint-disable-next-line no-template-curly-in-string
        '      <span title={`${days}-day streak`}>Fire</span>',
        // eslint-disable-next-line no-template-curly-in-string
        '      <p>{`Welcome back ${user.name}`}</p>',
        '    </div>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'StreakBadge.tsx'), 'utf-8')

    // Template literal `${days}-day streak` → t('...', '{{days}}-day streak', { days })
    expect(src).toContain('{{days}}-day streak')
    expect(src).toContain('{ days }')
    expect(src).not.toContain('`$' + '{days}-day streak`')

    // Template literal with member-expression `${user.name}` → uses property name
    expect(src).toContain('{{name}}')
    expect(src).toContain('name: user.name')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // JSX sibling merging: {greeting}, {name}! → single t() with interpolation
  // ───────────────────────────────────────────────────────────────────────────
  it('merges adjacent JSX text and expressions into a single t() call', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'GreetingBar.tsx'),
      [
        "import React from 'react'",
        '',
        'export function GreetingBar({ greeting, firstName }: { greeting: string; firstName: string }) {',
        '  return (',
        '    <header>',
        '      <p>{greeting}, {firstName}! Welcome back</p>',
        '      <h1>Dashboard overview</h1>',
        '    </header>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'GreetingBar.tsx'), 'utf-8')

    // The adjacent {greeting}, {firstName}! Welcome back should merge into one t() call
    expect(src).toContain('{{greeting}}')
    expect(src).toContain('{{firstName}}')
    expect(src).toContain('Welcome back')
    expect(src).toContain('{ greeting, firstName }')

    // The standalone JSX text should be instrumented normally
    expect(src).toContain("t('dashboardOverview', 'Dashboard overview')")

    // There should NOT be separate individual t() calls for ", " or "! Welcome back"
    // (those would be substrings of the merged text)
    // const tCallMatches = src.match(/\bt\(/g) || []
    // Expect exactly 2 t() calls: one merged greeting, one dashboard overview
    // (useTranslation destructuring also has `t` so match on `t('`)
    const tTranslationCalls = src.match(/\bt\('/g) || []
    expect(tTranslationCalls.length).toBe(2)

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Plural detection: ternary count patterns → t('key', { count }) with
  // _zero / _one / _other translation keys
  // ───────────────────────────────────────────────────────────────────────────
  it('detects ternary plural patterns and emits plural-form keys', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'TaskCounter.tsx'),
      [
        "import React from 'react'",
        '',
        'export function TaskCounter({ activeTasks }: { activeTasks: number }) {',
        '  return (',
        '    <div>',
        '      <p>',
        // eslint-disable-next-line no-template-curly-in-string
        "        {activeTasks === 0 ? 'You have no tasks left — enjoy your day!' : activeTasks === 1 ? 'You have 1 task left to complete.' : `You have ${activeTasks} tasks left to complete.`}",
        '      </p>',
        '    </div>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Write the translation JSON
    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'TaskCounter.tsx'), 'utf-8')

    // The entire ternary should be replaced by a single t() call with count and default values
    expect(src).toContain('count: activeTasks')
    expect(src).toContain("defaultValue_zero: 'You have no tasks left \u2014 enjoy your day!'")
    expect(src).toContain("defaultValue_one: 'You have 1 task left to complete.'")
    expect(src).toContain("defaultValue_other: 'You have {{count}} tasks left to complete.'")
    // Should NOT contain the original ternary expression
    expect(src).not.toContain('activeTasks === 0 ?')
    expect(src).not.toContain('activeTasks === 1 ?')

    // The translation JSON should contain plural-form keys
    const translationPath = join(tempDir, 'locales', 'en', 'translation.json')
    const translations = JSON.parse(await readFile(translationPath, 'utf-8'))

    // Find the plural key (it should have _zero, _one, _other suffixes)
    const pluralKeys = Object.keys(translations).filter(k => k.endsWith('_zero') || k.endsWith('_one') || k.endsWith('_other'))
    expect(pluralKeys.length).toBeGreaterThanOrEqual(3)

    // Verify the zero/one/other values
    const baseKey = pluralKeys.find(k => k.endsWith('_zero'))!.replace(/_zero$/, '')
    expect(translations[`${baseKey}_zero`]).toBe('You have no tasks left — enjoy your day!')
    expect(translations[`${baseKey}_one`]).toBe('You have 1 task left to complete.')
    expect(translations[`${baseKey}_other`]).toBe('You have {{count}} tasks left to complete.')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('detects 2-way plural pattern (one/other)', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'ItemCount.tsx'),
      [
        "import React from 'react'",
        '',
        'export function ItemCount({ n }: { n: number }) {',
        '  return (',
        '    <span>',
        // eslint-disable-next-line no-template-curly-in-string
        "      {n === 1 ? 'One item' : `${n} items`}",
        '    </span>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Write the translation JSON
    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'ItemCount.tsx'), 'utf-8')

    // Single t() call with count option and default values
    expect(src).toContain('count: n')
    expect(src).toContain("defaultValue_one: 'One item'")
    expect(src).toContain("defaultValue_other: '{{count}} items'")
    // Should NOT contain the original ternary expression
    expect(src).not.toContain('n === 1 ?')

    // Translation JSON should have _one and _other (but no _zero)
    const translationPath = join(tempDir, 'locales', 'en', 'translation.json')
    const translations = JSON.parse(await readFile(translationPath, 'utf-8'))

    const oneKeys = Object.keys(translations).filter(k => k.endsWith('_one'))
    const otherKeys = Object.keys(translations).filter(k => k.endsWith('_other'))
    expect(oneKeys.length).toBeGreaterThanOrEqual(1)
    expect(otherKeys.length).toBeGreaterThanOrEqual(1)

    const baseKey = oneKeys[0].replace(/_one$/, '')
    expect(translations[`${baseKey}_one`]).toBe('One item')
    expect(translations[`${baseKey}_other`]).toBe('{{count}} items')
    expect(translations[`${baseKey}_zero`]).toBeUndefined()

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // JSX description attribute and object-property label strings
  // ───────────────────────────────────────────────────────────────────────────
  it('instruments description JSX attributes and object-property label strings', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'Settings.tsx'),
      [
        "import React from 'react'",
        '',
        'function Toggle ({ label, description, checked, onChange, id }: any) {',
        '  return <div>{label} - {description}</div>',
        '}',
        '',
        'export function Settings () {',
        '  return (',
        '    <div>',
        '      <Toggle',
        '        id="notif-due-soon"',
        '        checked={true}',
        '        onChange={() => {}}',
        '        label="Due soon alerts"',
        '        description="Get reminded when tasks are due within 24 hours"',
        '      />',
        '    </div>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    await fs.writeFile(
      join(tempDir, 'src', 'components', 'FilterBar.tsx'),
      [
        "import React from 'react'",
        '',
        'const FILTER_OPTIONS: { key: string; label: string }[] = [',
        "  { key: 'all', label: 'All' },",
        "  { key: 'active', label: 'Active' },",
        "  { key: 'completed', label: 'Completed' },",
        ']',
        '',
        'export function FilterBar () {',
        '  return (',
        '    <ul>',
        '      {FILTER_OPTIONS.map(opt => <li key={opt.key}>{opt.label}</li>)}',
        '    </ul>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Check that description attribute was instrumented
    const settingsSrc = await readFile(join(tempDir, 'src', 'components', 'Settings.tsx'), 'utf-8')
    expect(settingsSrc).not.toContain('description="Get reminded')
    expect(settingsSrc).toContain('getRemindedWhenTasksAreDueWithin24Hours')

    // Check that label property strings inside object literals were instrumented
    const filterSrc = await readFile(join(tempDir, 'src', 'components', 'FilterBar.tsx'), 'utf-8')
    expect(filterSrc).toContain("t('all'")
    expect(filterSrc).toContain("t('active'")
    expect(filterSrc).toContain("t('completed'")

    // Both files must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(settingsSrc, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
    await expect(
      parse(filterSrc, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Warning for i18next.t() in React files
  // ───────────────────────────────────────────────────────────────────────────
  it('warns when i18next.t() is used outside a component in a .tsx file', async () => {
    // Module-level translatable strings in a .tsx file → will get i18next.t() instead of hook-based t()
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'OutsideModule.tsx'),
      [
        "import React from 'react'",
        '',
        'const navItems = [',
        "  { label: 'Dashboard Overview', path: '/dashboard' },",
        "  { label: 'Account Settings', path: '/settings' },",
        ']',
        '',
        'export function Nav () {',
        '  return (',
        '    <ul>',
        '      {navItems.map(item => <li key={item.path}><a href={item.path}>{item.label}</a></li>)}',
        '    </ul>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Find the result for our test file
    const fileResult = results.files.find(f => f.file.includes('OutsideModule.tsx'))
    expect(fileResult).toBeDefined()

    // At least one candidate should be outside a component (module-level)
    const outsideCandidates = fileResult!.candidates.filter(c => !c.insideComponent)
    expect(outsideCandidates.length).toBeGreaterThanOrEqual(1)

    // The transform result should contain a warning about i18next.t() in a React file
    expect(fileResult!.result.warnings.length).toBeGreaterThanOrEqual(1)
    expect(fileResult!.result.warnings[0]).toContain('i18next.t() was added outside of a React component')
    expect(fileResult!.result.warnings[0]).toContain('https://www.locize.com/blog/how-to-use-i18next-t-outside-react-components/')
  })

  it('does NOT warn when all strings are inside components in .tsx files', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'InsideOnly.tsx'),
      [
        "import React from 'react'",
        '',
        'export function Greeting () {',
        '  return <p>Welcome home</p>',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const fileResult = results.files.find(f => f.file.includes('InsideOnly.tsx'))
    expect(fileResult).toBeDefined()
    expect(fileResult!.result.warnings).toHaveLength(0)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Language change detection: injects i18n.changeLanguage()
  // ─────────────────────────────────────────────────────────────────────
  it('detects language-change patterns and injects i18n.changeLanguage() in components', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'SettingsPage.tsx'),
      `import React from 'react'

const languages = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' }
]

export function SettingsPage({ updateSettings }) {
  return (
    <div>
      <h2>Language settings</h2>
      <ul>
        {languages.map(lang => (
          <li key={lang.code}>
            <button onClick={() => updateSettings({ language: lang.code })}>
              {lang.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
`
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const settingsResult = results.files.find(f => f.file.includes('SettingsPage.tsx'))
    expect(settingsResult).toBeDefined()

    const settingsSrc = await readFile(join(tempDir, 'src', 'pages', 'SettingsPage.tsx'), 'utf-8')

    // Should have i18n.changeLanguage injected
    expect(settingsSrc).toContain('i18n.changeLanguage(lang.code)')
    // The original call should still be present
    expect(settingsSrc).toContain('updateSettings({ language: lang.code })')

    // Should destructure i18n (and t) from useTranslation
    expect(settingsSrc).toContain('useTranslation()')
    expect(settingsSrc).toContain('i18n')

    // Should import from react-i18next
    expect(settingsSrc).toContain('react-i18next')
  })

  it('detects direct setter pattern like setLanguage(code) and injects changeLanguage', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'LangSwitcher.tsx'),
      `import React from 'react'

export function LangSwitcher() {
  return (
    <div>
      <button onClick={() => setLanguage(selectedCode)}>
        Switch language
      </button>
    </div>
  )
}
`
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const switcherResult = results.files.find(f => f.file.includes('LangSwitcher.tsx'))
    expect(switcherResult).toBeDefined()

    const switcherSrc = await readFile(join(tempDir, 'src', 'pages', 'LangSwitcher.tsx'), 'utf-8')

    // Should have i18n.changeLanguage injected
    expect(switcherSrc).toContain('i18n.changeLanguage(selectedCode)')
    // Original call preserved
    expect(switcherSrc).toContain('setLanguage(selectedCode)')
  })

  it('does NOT detect static string language values as language-change sites', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'utils', 'i18nSetup.ts'),
      `export function initI18n() {
  configure({ language: 'en' })
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const setupSrc = await readFile(join(tempDir, 'src', 'utils', 'i18nSetup.ts'), 'utf-8')

    // Static string 'en' should NOT trigger language-change detection
    expect(setupSrc).not.toContain('changeLanguage')
  })

  it('does not double-transform already instrumented language-change code', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'AlreadyDone.tsx'),
      `import React from 'react'
import { useTranslation } from 'react-i18next'

export function AlreadyDone() {
  const { t, i18n } = useTranslation()
  return (
    <button onClick={() => { i18n.changeLanguage(code); updateSettings({ language: code }); }}>
      {t('switchLanguage')}
    </button>
  )
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'pages', 'AlreadyDone.tsx'), 'utf-8')

    // Should NOT have a second changeLanguage call
    const matches = src.match(/changeLanguage/g) || []
    expect(matches.length).toBe(1)
  })

  it('uses i18next.changeLanguage() outside of components', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'utils', 'langHelper.ts'),
      `export function switchLang(code: string) {
  api.updatePreferences({ locale: code })
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const helperSrc = await readFile(join(tempDir, 'src', 'utils', 'langHelper.ts'), 'utf-8')

    // Outside a component, should use i18next directly
    expect(helperSrc).toContain('i18next.changeLanguage(code)')
    expect(helperSrc).toContain("import i18next from 'i18next'")
    // Should NOT have useTranslation (not a component)
    expect(helperSrc).not.toContain('useTranslation')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Non-translatable JSX attribute skipping
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT instrument className attribute values (string, template, expression)', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'StyledBtn.tsx'),
      `import React from 'react'
import styles from './styles.module.css'

export function StyledBtn({ active }) {
  return (
    <div>
      <button
        className={\`\${styles.langBtn} \${active ? styles.langBtnActive : ''}\`}
        style={{ color: 'red' }}
        data-testid="lang-button"
      >
        Choose your preferred language
      </button>
    </div>
  )
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'StyledBtn.tsx'), 'utf-8')

    // The className template literal must NOT be wrapped in t()
    // eslint-disable-next-line no-template-curly-in-string
    expect(src).toContain('className={`${styles.langBtn}')
    expect(src).not.toMatch(/className=\{t\(/)

    // style and data-testid should NOT be wrapped either
    expect(src).toContain("style={{ color: 'red' }}")
    expect(src).toContain('data-testid="lang-button"')

    // But the button text content SHOULD be instrumented
    expect(src).toContain("t('")
    expect(src).toContain('Choose your preferred language')
  })

  it('does NOT instrument href, src, id, or type attribute values', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'NavLink.tsx'),
      `import React from 'react'

export function NavLink() {
  return (
    <a href="https://example.com" id="main-link" target="_blank" rel="noopener">
      Visit our website
    </a>
  )
}
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'NavLink.tsx'), 'utf-8')

    // href, id, target, rel should remain untouched
    expect(src).toContain('href="https://example.com"')
    expect(src).toContain('id="main-link"')
    expect(src).toContain('target="_blank"')
    expect(src).toContain('rel="noopener"')

    // But the anchor text SHOULD be instrumented
    expect(src).toContain("t('")
    expect(src).toContain('Visit our website')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Auto-import: injects `import './i18n'` into the entry file
  // ─────────────────────────────────────────────────────────────────────
  it('injects i18n import into src/main.tsx when it exists', async () => {
    // Create an entry file
    await fs.writeFile(
      join(tempDir, 'src', 'main.tsx'),
      `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const mainSrc = await readFile(join(tempDir, 'src', 'main.tsx'), 'utf-8')

    // The i18n import should have been injected
    expect(mainSrc).toContain("import './i18n'")

    // Original imports should still be there
    expect(mainSrc).toContain("import React from 'react'")
    expect(mainSrc).toContain("import ReactDOM from 'react-dom/client'")
  })

  it('injects i18n import into src/index.tsx if src/main.tsx does not exist', async () => {
    // Only create index.tsx (no main.tsx)
    await fs.writeFile(
      join(tempDir, 'src', 'index.tsx'),
      `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const indexSrc = await readFile(join(tempDir, 'src', 'index.tsx'), 'utf-8')
    expect(indexSrc).toContain("import './i18n'")
  })

  it('does not inject i18n import if it already exists in the entry file', async () => {
    // Entry file already imports i18n
    await fs.writeFile(
      join(tempDir, 'src', 'main.tsx'),
      `import React from 'react'
import './i18n'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const mainSrc = await readFile(join(tempDir, 'src', 'main.tsx'), 'utf-8')

    // Should NOT have duplicate imports — count occurrences
    const matches = mainSrc.match(/import ['"]\.\/i18n['"]/g)
    expect(matches).toHaveLength(1)
  })

  it('does not inject i18n import during dry-run', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'main.tsx'),
      `import React from 'react'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)

    const mainSrc = await readFile(join(tempDir, 'src', 'main.tsx'), 'utf-8')
    expect(mainSrc).not.toContain("import './i18n'")
  })

  it('injects i18n import after the last existing import line', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'main.tsx'),
      `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

const root = ReactDOM.createRoot(document.getElementById('root')!)
root.render(<App />)
`
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const mainSrc = await readFile(join(tempDir, 'src', 'main.tsx'), 'utf-8')

    // The import should be placed after "import App from './App'"
    const lines = mainSrc.split('\n')
    const i18nImportIdx = lines.findIndex(l => l.includes("import './i18n'"))
    const appImportIdx = lines.findIndex(l => l.includes('import App from'))
    expect(i18nImportIdx).toBeGreaterThan(appImportIdx)

    // And before the code
    const constIdx = lines.findIndex(l => l.includes('const root'))
    expect(i18nImportIdx).toBeLessThan(constIdx)
  })

  it('prepends i18n import when entry file has no existing imports', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'main.tsx'),
      `const root = document.getElementById('root')
console.log('Hello')
`
    )

    // Need a component file with a translatable string to trigger transformation
    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const mainSrc = await readFile(join(tempDir, 'src', 'main.tsx'), 'utf-8')
    expect(mainSrc).toContain("import './i18n'")
    // Should be the very first line
    expect(mainSrc.startsWith("import './i18n'")).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────
  // JSX sibling merging + plural ternary: merged into a single plural t()
  // ─────────────────────────────────────────────────────────────────────
  it('merges JSX siblings containing a plural ternary into a single plural t() call', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'TaskBadge.tsx'),
      [
        "import React from 'react'",
        '',
        'export function TaskBadge({ activeCount }: { activeCount: number }) {',
        '  return (',
        '    <span>',
        "      {activeCount} {activeCount === 1 ? 'task' : 'tasks'} remaining",
        '    </span>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    // Write the translation JSON
    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'TaskBadge.tsx'), 'utf-8')

    // The entire JSX sibling run should be replaced by a single t() with plural forms
    expect(src).toContain('count: activeCount')
    expect(src).toContain("defaultValue_one: '{{count}} task remaining'")
    expect(src).toContain("defaultValue_other: '{{count}} tasks remaining'")
    // Should NOT contain the original ternary or separate expressions
    expect(src).not.toContain("activeCount === 1 ? 'task' : 'tasks'")

    // The translation JSON should contain plural-form keys
    const translationPath = join(tempDir, 'locales', 'en', 'translation.json')
    const translations = JSON.parse(await readFile(translationPath, 'utf-8'))

    const oneKeys = Object.keys(translations).filter(k => k.endsWith('_one'))
    const otherKeys = Object.keys(translations).filter(k => k.endsWith('_other'))
    expect(oneKeys.length).toBeGreaterThanOrEqual(1)
    expect(otherKeys.length).toBeGreaterThanOrEqual(1)

    const baseKey = oneKeys[0].replace(/_one$/, '')
    expect(translations[`${baseKey}_one`]).toBe('{{count}} task remaining')
    expect(translations[`${baseKey}_other`]).toBe('{{count}} tasks remaining')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('merges JSX siblings with plural ternary and extra expressions', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'UserTasks.tsx'),
      [
        "import React from 'react'",
        '',
        'export function UserTasks({ userName, count }: { userName: string; count: number }) {',
        '  return (',
        '    <p>',
        "      {userName}, {count} {count === 1 ? 'item' : 'items'} left",
        '    </p>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'UserTasks.tsx'), 'utf-8')

    // Should have plural forms with both {{userName}} and {{count}}
    expect(src).toContain('count: count')
    expect(src).toContain('userName')
    expect(src).toContain('defaultValue_one:')
    expect(src).toContain('defaultValue_other:')
    // Should NOT contain the original ternary
    expect(src).not.toContain("count === 1 ? 'item' : 'items'")

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('merges JSX siblings with 3-way plural ternary (zero/one/other)', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'NotificationBadge.tsx'),
      [
        "import React from 'react'",
        '',
        'export function NotificationBadge({ n }: { n: number }) {',
        '  return (',
        '    <span>',
        // eslint-disable-next-line no-template-curly-in-string
        "      {n === 0 ? 'No' : n === 1 ? 'One' : `${n}`} notification{n === 1 ? '' : 's'} pending",
        '    </span>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'NotificationBadge.tsx'), 'utf-8')

    // Should contain a t() call with count
    expect(src).toContain('count: n')
    // Should NOT contain the original ternary chains
    expect(src).not.toContain('n === 0 ?')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Idempotency: second run must not double-instrument plural JSX patterns
  // ─────────────────────────────────────────────────────────────────────
  it('does not double-instrument merged JSX plural ternary on second run', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'IdempotentBadge.tsx'),
      [
        "import React from 'react'",
        '',
        'export function IdempotentBadge({ activeCount }: { activeCount: number }) {',
        '  return (',
        '    <span>',
        "      {activeCount} {activeCount === 1 ? 'task' : 'tasks'} remaining",
        '    </span>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()

    // First pass
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    const firstSrc = await readFile(join(tempDir, 'src', 'components', 'IdempotentBadge.tsx'), 'utf-8')
    expect(firstSrc).toContain('count: activeCount')
    expect(firstSrc).toContain('defaultValue_one:')
    expect(firstSrc).toContain('defaultValue_other:')

    // Second pass on the already-instrumented file
    const secondResults = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    const secondSrc = await readFile(join(tempDir, 'src', 'components', 'IdempotentBadge.tsx'), 'utf-8')

    // Content must be unchanged after the second run
    expect(secondSrc).toBe(firstSrc)
    // No nested t() calls inside defaultValue options
    expect(secondSrc).not.toContain('defaultValue_one: t(')
    expect(secondSrc).not.toContain('defaultValue_other: t(')

    // The second pass should not produce new transformations for this file
    const badgeResult = secondResults.files.find(f => f.file?.includes('IdempotentBadge'))
    if (badgeResult) {
      expect(badgeResult.result.transformCount).toBe(0)
    }
  })

  // ─────────────────────────────────────────────────────────────────────
  // Trans component: JSX siblings with inline HTML elements
  // ─────────────────────────────────────────────────────────────────────
  it('wraps mixed JSX text + elements with <Trans> and generates indexed-tag translation', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'Terms.tsx'),
      [
        "import React from 'react'",
        '',
        'export function Terms() {',
        '  return (',
        '    <p>',
        '      Click <a href="/terms">here</a> to accept our terms',
        '    </p>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'Terms.tsx'), 'utf-8')

    // Should contain a <Trans> wrapper
    expect(src).toContain('<Trans')
    expect(src).toContain('i18nKey=')
    // The original <a> element must still be inside the Trans children
    expect(src).toContain('<a href="/terms">here</a>')
    // Should NOT still have the unwrapped plain text siblings
    // (the entire children should be wrapped in a single <Trans>)

    // Should import Trans from react-i18next
    expect(src).toContain('Trans')
    expect(src).toContain("from 'react-i18next'")

    // The translation JSON should have the indexed-tag format
    const translationPath = join(tempDir, 'locales', 'en', 'translation.json')
    const translations = JSON.parse(await readFile(translationPath, 'utf-8'))
    const values = Object.values(translations) as string[]
    // Should contain a value like "Click <1>here</1> to accept our terms"
    const transValue = values.find(v => typeof v === 'string' && /<\d+>/.test(v))
    expect(transValue).toBeDefined()
    expect(transValue).toContain('here')
    expect(transValue).toContain('accept our terms')

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('wraps mixed JSX with expressions and elements using <Trans> with {{ }} syntax', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'ProfileLink.tsx'),
      [
        "import React from 'react'",
        '',
        'export function ProfileLink({ name }: { name: string }) {',
        '  return (',
        '    <p>',
        '      Hello {name}, visit <a href="/profile">your profile</a> page',
        '    </p>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const allCandidates = results.files.flatMap(f => f.candidates)
    await writeExtractedKeys(allCandidates, config, 'translation', silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'ProfileLink.tsx'), 'utf-8')

    // Should contain <Trans> with the original anchor element
    expect(src).toContain('<Trans')
    expect(src).toContain('<a href="/profile">your profile</a>')
    // The expression should be converted to {{ obj }} syntax for react-i18next
    expect(src).toContain('{{ name }}')
    // Should NOT have the raw {name} expression (it should be {{ name }})
    // (we can't easily test this without regex since {{ name }} contains {name})

    // Translation JSON should have both interpolation and indexed tags
    const translationPath = join(tempDir, 'locales', 'en', 'translation.json')
    const translations = JSON.parse(await readFile(translationPath, 'utf-8'))
    const values = Object.values(translations) as string[]
    const transValue = values.find(v => typeof v === 'string' && /\{\{name\}\}/.test(v) && /<\d+>/.test(v))
    expect(transValue).toBeDefined()

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })

  it('does not double-instrument <Trans> wrapped content on second run', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'TransIdempotent.tsx'),
      [
        "import React from 'react'",
        '',
        'export function TransIdempotent() {',
        '  return (',
        '    <p>',
        '      Click <a href="/terms">here</a> to accept our terms',
        '    </p>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()

    // First pass
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    const firstSrc = await readFile(join(tempDir, 'src', 'components', 'TransIdempotent.tsx'), 'utf-8')
    expect(firstSrc).toContain('<Trans')

    // Second pass
    const secondResults = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    const secondSrc = await readFile(join(tempDir, 'src', 'components', 'TransIdempotent.tsx'), 'utf-8')

    // Content must be identical after the second run
    expect(secondSrc).toBe(firstSrc)

    // The second pass should have 0 transformations for this file
    const transResult = secondResults.files.find(f => f.file?.includes('TransIdempotent'))
    if (transResult) {
      expect(transResult.result.transformCount).toBe(0)
    }
  })

  it('component with both t() and <Trans> gets useTranslation + Trans import', async () => {
    await fs.writeFile(
      join(tempDir, 'src', 'components', 'MixedUsage.tsx'),
      [
        "import React from 'react'",
        '',
        'export function MixedUsage() {',
        '  return (',
        '    <div>',
        '      <h1>Welcome to your personal dashboard</h1>',
        '      <p>Click <a href="/help">here</a> for help</p>',
        '    </div>',
        '  )',
        '}',
        ''
      ].join('\n')
    )

    const config = makeConfig()
    await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)

    const src = await readFile(join(tempDir, 'src', 'components', 'MixedUsage.tsx'), 'utf-8')

    // Should have both useTranslation (for the title) and Trans (for the mixed JSX)
    expect(src).toContain('useTranslation')
    expect(src).toContain('<Trans')
    // The import should include both
    expect(src).toMatch(/import\s*\{[^}]*useTranslation[^}]*Trans[^}]*\}|import\s*\{[^}]*Trans[^}]*useTranslation[^}]*\}/)

    // File must remain syntactically valid
    const { parse } = await import('@swc/core')
    await expect(
      parse(src, { syntax: 'typescript', tsx: true })
    ).resolves.toBeDefined()
  })
})
