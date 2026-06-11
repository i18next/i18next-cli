import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser'

/**
 * The plugin that teaches inlang tools (Sherlock, Fink, Paraglide) to read and
 * write i18next JSON resource files directly.
 *
 * Pinned to an exact version on purpose: 6.2.0 is the first release with
 * verified round-trip support for plurals, context, `_zero` and ordinal keys,
 * and jsDelivr serves floating range URLs (`@6`) from edge caches that can
 * lag releases by days. Bump deliberately when newer verified versions ship.
 */
const INLANG_PLUGIN_MODULE = 'https://cdn.jsdelivr.net/npm/@inlang/plugin-i18next@6.2.0/dist/index.js'

/** VS Code marketplace id of the inlang Sherlock extension. */
const SHERLOCK_EXTENSION_ID = 'inlang.vs-code-extension'

export interface InlangScaffoldOptions {
  /** All project locales (the first one is used as `baseLocale` unless `primaryLanguage` is set). */
  locales: string[]
  /** The base/source locale. Defaults to the first entry of `locales`. */
  primaryLanguage?: string
  /** The `extract.output` template, e.g. `public/locales/{{language}}/{{namespace}}.json`. */
  output: string | ((language: string, namespace?: string) => string)
  /** Default namespace used as fallback when no resource files exist yet (default: 'translation'). */
  defaultNS?: string | false
}

/**
 * Scaffolds an inlang project (`project.inlang/settings.json`) next to the
 * i18next configuration so that inlang tooling (Sherlock VS Code extension,
 * Fink editor, Paraglide compiler) operates on the EXISTING i18next JSON
 * files. The i18next files remain the single source of truth — the scaffold
 * is just the adapter.
 *
 * Behavior:
 * - Derives `plugin.inlang.i18next.pathPattern` from the `extract.output`
 *   template: the namespaced object form when the template contains a
 *   `{{namespace}}` placeholder (namespaces are discovered from the files of
 *   the primary language), the plain string form otherwise.
 * - Never overwrites an existing `project.inlang/settings.json`.
 * - Adds the Sherlock extension to `.vscode/extensions.json` recommendations
 *   (creating or comment-preservingly merging the file).
 */
export async function scaffoldInlangProject (options: InlangScaffoldOptions): Promise<void> {
  const { locales, output } = options
  const baseLocale = options.primaryLanguage || locales[0] || 'en'

  if (typeof output !== 'string') {
    console.log('⚠️  Skipping inlang setup: extract.output is a function, so the file layout cannot be derived automatically. Create project.inlang/settings.json manually (see https://inlang.com/m/3i8bor92/plugin-inlang-i18next).')
    return
  }

  // {{lng}} is a supported alias for {{language}}
  const template = output.replace(/\{\{lng\}\}/g, '{{language}}')

  if (!template.endsWith('.json')) {
    console.log('⚠️  Skipping inlang setup: the inlang i18next plugin supports JSON resource files only, but extract.output points to non-JSON files.')
    return
  }

  const settingsDir = resolve(process.cwd(), 'project.inlang')
  const settingsPath = resolve(settingsDir, 'settings.json')

  if (await fileExists(settingsPath)) {
    console.log('ℹ️  project.inlang/settings.json already exists — leaving it untouched.')
  } else {
    const pathPattern = template.includes('{{namespace}}')
      ? await deriveNamespacedPathPattern(template, baseLocale, options.defaultNS)
      : toInlangPattern(template)

    const settings = {
      $schema: 'https://inlang.com/schema/project-settings',
      baseLocale,
      locales,
      modules: [INLANG_PLUGIN_MODULE],
      'plugin.inlang.i18next': { pathPattern },
    }

    await mkdir(settingsDir, { recursive: true })
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')

    console.log(`✅ inlang project created at: ${settingsPath}`)
    console.log('   Your i18next JSON files stay the single source of truth — inlang tools read and write them directly.')
    console.log(`   • Sherlock (VS Code): install the recommended "${SHERLOCK_EXTENSION_ID}" extension`)
    console.log('   • Fink (web editor for translators): https://fink.inlang.com')
    console.log('   • Paraglide (compiled i18n): npx @inlang/paraglide-js compile --project ./project.inlang')
  }

  await recommendSherlockExtension()
}

/**
 * Converts an i18next-cli output template into an inlang `pathPattern`:
 * `{{language}}` becomes `{locale}` and the path is made explicitly relative,
 * as required by the plugin's settings schema.
 */
function toInlangPattern (template: string): string {
  const pattern = template.replace(/\{\{language\}\}/g, '{locale}')
  if (pattern.startsWith('./') || pattern.startsWith('../') || pattern.startsWith('/')) {
    return pattern
  }
  return `./${pattern}`
}

/**
 * Builds the namespaced (object) form of `pathPattern` by discovering the
 * project's namespaces from the existing resource files of the primary
 * language. Falls back to the default namespace when no files exist yet
 * (e.g. `init` ran before the first `extract`).
 */
async function deriveNamespacedPathPattern (
  template: string,
  baseLocale: string,
  defaultNS?: string | false
): Promise<Record<string, string>> {
  const namespaces = await discoverNamespaces(template, baseLocale)
  if (namespaces.length === 0) {
    namespaces.push(typeof defaultNS === 'string' ? defaultNS : 'translation')
  }

  const pathPattern: Record<string, string> = {}
  for (const ns of namespaces.sort()) {
    pathPattern[ns] = toInlangPattern(template.replace(/\{\{namespace\}\}/g, ns))
  }
  return pathPattern
}

/**
 * Discovers namespace names by listing the directory entries that match the
 * `{{namespace}}` segment of the output template, resolved for the primary
 * language. Works for namespaces in the file name
 * (`locales/en/{{namespace}}.json`) as well as in a directory segment
 * (`locales/{{namespace}}/en.json`).
 */
async function discoverNamespaces (template: string, baseLocale: string): Promise<string[]> {
  const resolved = template.replace(/\{\{language\}\}/g, baseLocale)
  const segments = resolved.split('/')
  const nsIndex = segments.findIndex(segment => segment.includes('{{namespace}}'))
  if (nsIndex === -1) return []

  const baseDir = resolve(process.cwd(), segments.slice(0, nsIndex).join('/'))
  const [prefix, suffix = ''] = segments[nsIndex].split('{{namespace}}')

  try {
    const entries = await readdir(baseDir)
    return entries
      .filter(entry =>
        entry.startsWith(prefix) &&
        entry.endsWith(suffix) &&
        entry.length > prefix.length + suffix.length)
      .map(entry => entry.slice(prefix.length, entry.length - suffix.length))
  } catch {
    return []
  }
}

/**
 * Adds the Sherlock VS Code extension to `.vscode/extensions.json`
 * recommendations. Creates the file when missing; otherwise merges into the
 * existing one while preserving comments and formatting (JSONC-aware). Bails
 * gracefully — with a notice, never an error — when the existing file cannot
 * be parsed.
 */
async function recommendSherlockExtension (): Promise<void> {
  const extensionsPath = resolve(process.cwd(), '.vscode', 'extensions.json')

  let text: string | undefined
  try {
    text = await readFile(extensionsPath, 'utf-8')
  } catch {
    // File doesn't exist yet — create it.
  }

  if (text === undefined || text.trim() === '') {
    await mkdir(dirname(extensionsPath), { recursive: true })
    await writeFile(extensionsPath, JSON.stringify({ recommendations: [SHERLOCK_EXTENSION_ID] }, null, 2) + '\n')
    console.log('✅ Added the Sherlock extension to .vscode/extensions.json recommendations.')
    return
  }

  const errors: ParseError[] = []
  const current = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof current !== 'object' || current === null || Array.isArray(current)) {
    console.log('⚠️  Could not parse .vscode/extensions.json — please add "inlang.vs-code-extension" to its recommendations manually.')
    return
  }

  const recommendations: unknown[] = Array.isArray(current.recommendations) ? current.recommendations : []
  const alreadyRecommended = recommendations.some(
    entry => typeof entry === 'string' && entry.toLowerCase() === SHERLOCK_EXTENSION_ID
  )
  if (alreadyRecommended) return

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' }
  const edits = Array.isArray(current.recommendations)
    // Append to the existing array (preserves comments and formatting).
    ? modify(text, ['recommendations', recommendations.length], SHERLOCK_EXTENSION_ID, { isArrayInsertion: true, formattingOptions })
    // No recommendations key yet — add one.
    : modify(text, ['recommendations'], [SHERLOCK_EXTENSION_ID], { formattingOptions })

  await writeFile(extensionsPath, applyEdits(text, edits))
  console.log('✅ Added the Sherlock extension to .vscode/extensions.json recommendations.')
}

async function fileExists (path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
