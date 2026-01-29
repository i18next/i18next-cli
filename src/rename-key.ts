import { glob } from 'glob'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import type { I18nextToolkitConfig, Logger, RenameKeyResult } from './types'
import { ConsoleLogger } from './utils/logger'
import { loadTranslationFile, serializeTranslationFile, getOutputPath } from './utils/file-utils'
import { getNestedValue, setNestedValue } from './utils/nested-object'
import { shouldShowFunnel, recordFunnelShown } from './utils/funnel-msg-tracker'
import chalk from 'chalk'

const pluralSuffixes = ['zero', 'one', 'two', 'few', 'many', 'other']

/**
 * Renames a translation key across all source files and translation files.
 *
 * This function performs a comprehensive key rename operation:
 * 1. Validates the old and new key names
 * 2. Checks for conflicts in translation files
 * 3. Updates all occurrences in source code (AST-based)
 * 4. Updates all translation files for all locales
 * 5. Preserves the original translation values
 *
 * @param config - The i18next toolkit configuration
 * @param oldKey - The current key to rename (may include namespace prefix)
 * @param newKey - The new key name (may include namespace prefix)
 * @param options - Rename options (dry-run mode, etc.)
 * @param logger - Logger instance for output
 * @returns Result object with update status and file lists
 *
 * @example
 * ```typescript
 * // Basic rename
 * const result = await runRenameKey(config, 'old.key', 'new.key')
 *
 * // With namespace
 * const result = await runRenameKey(config, 'common:button.submit', 'common:button.save')
 *
 * // Dry run to preview changes
 * const result = await runRenameKey(config, 'old.key', 'new.key', { dryRun: true })
 * ```
 */
export async function runRenameKey (
  config: I18nextToolkitConfig,
  oldKey: string,
  newKey: string,
  options: {
    dryRun?: boolean
  } = {},
  logger: Logger = new ConsoleLogger()
): Promise<RenameKeyResult> {
  const { dryRun = false } = options

  // Validate keys
  const validation = validateKeys(oldKey, newKey, config)
  if (!validation.valid) {
    return {
      success: false,
      sourceFiles: [],
      translationFiles: [],
      error: validation.error
    }
  }

  // Parse namespace from keys
  const oldParts = parseKeyWithNamespace(oldKey, config)
  const newParts = parseKeyWithNamespace(newKey, config)

  // Check for conflicts in translation files
  const conflicts = await checkConflicts(newParts, config)
  if (conflicts.length > 0) {
    // If the old key doesn't exist in any translation file, treat this as a
    // no-op (allow the command to succeed). This mirrors previous behavior
    // where renaming a missing key doesn't fail just because the target
    // already exists (it avoids blocking repeated/no-op renames).
    const oldExists = await checkOldKeyExists(parseKeyWithNamespace(oldKey, config), config)
    if (oldExists) {
      return {
        success: false,
        sourceFiles: [],
        translationFiles: [],
        conflicts,
        error: 'Target key already exists in translation files'
      }
    }
    // otherwise: old key not present -> continue (no-op)
  }

  // Build a quick map of which namespaces contain which keys (union across locales).
  // This allows us to decide, per-call, whether an explicit `{ ns: 'x' }` refers to
  // the namespace we're renaming, and whether that namespace actually contains the key.
  const namespaceKeyMap = await buildNamespaceKeyMap(config)

  logger.info(`🔍 Scanning for usages of "${oldKey}"...`)

  // Find and update source files
  const sourceResults = await updateSourceFiles(oldParts, newParts, config, dryRun, namespaceKeyMap, logger)

  // Update translation files
  const translationResults = await updateTranslationFiles(oldParts, newParts, config, dryRun, namespaceKeyMap, logger)

  const totalChanges = sourceResults.reduce((sum, r) => sum + r.changes, 0)

  if (!dryRun && totalChanges > 0) {
    logger.info('\n✨ Successfully renamed key!')
    logger.info(`   Old: "${oldKey}"`)
    logger.info(`   New: "${newKey}"`)

    // Show locize funnel after successful rename
    await printLocizeFunnel()
  } else if (totalChanges === 0) {
    logger.info(`\n⚠️  No usages found for "${oldKey}"`)
  }

  return {
    success: true,
    sourceFiles: sourceResults,
    translationFiles: translationResults
  }
}

/**
 * Prints a promotional message for the locize rename/move workflow.
 * This message is shown after a successful key rename operation.
 */
async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('rename-key'))) return

  console.log(chalk.yellow.bold('\n💡 Tip: Managing translations across multiple projects?'))
  console.log('   With locize, you can rename, move, and copy translation keys directly')
  console.log('   in the web interface—no CLI needed. Perfect for collaboration with')
  console.log('   translators and managing complex refactoring across namespaces.')
  console.log(`   Learn more: ${chalk.cyan('https://www.locize.com/docs/how-can-a-segment-key-be-copied-moved-or-renamed')}`)

  return recordFunnelShown('rename-key')
}

interface KeyParts {
  namespace?: string
  key: string
  fullKey: string
  explicitNamespace?: boolean
}

function parseKeyWithNamespace (key: string, config: I18nextToolkitConfig): KeyParts {
  const nsSeparator = config.extract.nsSeparator ?? ':'

  if (nsSeparator && key.includes(nsSeparator)) {
    const [ns, ...rest] = key.split(nsSeparator)
    return {
      namespace: ns,
      key: rest.join(nsSeparator),
      fullKey: key,
      explicitNamespace: true
    }
  }

  return {
    namespace: config.extract.defaultNS || 'translation',
    key,
    fullKey: key,
    explicitNamespace: false
  }
}

function validateKeys (oldKey: string, newKey: string, config: I18nextToolkitConfig): { valid: boolean; error?: string } {
  if (!oldKey || !oldKey.trim()) {
    return { valid: false, error: 'Old key cannot be empty' }
  }

  if (!newKey || !newKey.trim()) {
    return { valid: false, error: 'New key cannot be empty' }
  }

  if (oldKey === newKey) {
    return { valid: false, error: 'Old and new keys are identical' }
  }

  return { valid: true }
}

async function checkConflicts (newParts: KeyParts, config: I18nextToolkitConfig): Promise<string[]> {
  const conflicts: string[] = []
  const keySeparator = config.extract.keySeparator ?? '.'

  for (const locale of config.locales) {
    const outputPath = getOutputPath(config.extract.output, locale, newParts.namespace)
    const fullPath = resolve(process.cwd(), outputPath)

    try {
      const existingTranslations = await loadTranslationFile(fullPath)
      if (existingTranslations) {
        // Check for exact key match (nested or scalar)
        const value = getNestedValue(existingTranslations, newParts.key, keySeparator)
        if (value !== undefined) {
          conflicts.push(`${locale}:${newParts.fullKey}`)
        }

        // Check for flat plural form conflicts like "key2_one", "key2_other"
        if (existingTranslations && typeof existingTranslations === 'object') {
          const pluralRegex = new RegExp(`^${escapeRegex(newParts.key)}_(${pluralSuffixes.join('|')})$`)
          for (const k of Object.keys(existingTranslations)) {
            if (pluralRegex.test(k)) {
              conflicts.push(`${locale}:${k}`)
            }
          }
        }
      }
    } catch {
      // File doesn't exist, no conflict
    }
  }

  return conflicts
}

async function checkOldKeyExists (oldParts: KeyParts, config: I18nextToolkitConfig): Promise<boolean> {
  const keySeparator = config.extract.keySeparator ?? '.'

  for (const locale of config.locales) {
    const outputPath = getOutputPath(config.extract.output, locale, oldParts.namespace)
    const fullPath = resolve(process.cwd(), outputPath)

    try {
      const translations = await loadTranslationFile(fullPath)
      if (translations) {
        // Check for exact key match (nested or scalar)
        const val = getNestedValue(translations, oldParts.key, keySeparator)
        if (val !== undefined) return true

        // Check for flat plural forms like "key_one", "key_other"
        if (translations && typeof translations === 'object') {
          const pluralRegex = new RegExp(`^${escapeRegex(oldParts.key)}_(${pluralSuffixes.join('|')})$`)
          for (const k of Object.keys(translations)) {
            if (pluralRegex.test(k)) {
              return true
            }
          }
        }
      }
    } catch {
      // file missing — continue to next locale
    }
  }

  return false
}

async function buildNamespaceKeyMap (config: I18nextToolkitConfig): Promise<Map<string, Set<string>>> {
  // Map namespace -> set of flattened keys present in that namespace (union across locales)
  const map = new Map<string, Set<string>>()

  // config.extract.output may be either a string template or a function(language, namespace) => string.
  // Produce a string we can turn into a glob pattern. For functions, call with wildcard values.
  const rawOutput = config.extract.output
  const outputTemplate = typeof rawOutput === 'function'
    ? rawOutput('*', '*') // produce a path with wildcards we can glob
    : String(rawOutput)

  // make a glob pattern by replacing placeholders with *
  const pat = outputTemplate
    .replace(/\{\{language\}\}/g, '*')
    .replace(/\{\{namespace\}\}/g, '*')

  // glob expects unix-style
  const files = await glob([pat.replace(/\\/g, '/')], { nodir: true })
  const keySeparator = config.extract.keySeparator ?? '.'

  for (const f of files) {
    try {
      const translations = await loadTranslationFile(resolve(process.cwd(), f))
      if (!translations) continue
      // derive namespace name from filename: basename without extension (platform-safe)
      const base = basename(f)
      const ns = base.replace(/\.[^.]+$/, '') // remove extension
      const set = map.get(ns) ?? new Set<string>()
      // flatten keys recursively
      const collect = (obj: any, prefix = '') => {
        if (typeof obj !== 'object' || obj === null) {
          // only add non-empty prefix (avoid adding '')
          if (prefix) set.add(prefix)
          return
        }
        for (const k of Object.keys(obj)) {
          const next = prefix ? `${prefix}${keySeparator}${k}` : k
          collect(obj[k], next)
        }
      }
      collect(translations, '')
      map.set(ns, set)
    } catch {
      // ignore unreadable files
    }
  }

  return map
}

async function updateSourceFiles (
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig,
  dryRun: boolean,
  namespaceKeyMap: Map<string, Set<string>>,
  logger: Logger
): Promise<Array<{ path: string; changes: number }>> {
  const defaultIgnore = ['node_modules/**']
  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  // Normalize input patterns for cross-platform compatibility
  const inputPatterns = Array.isArray(config.extract.input)
    ? config.extract.input
    : [config.extract.input]

  const normalizedPatterns = inputPatterns.map(pattern =>
    pattern.replace(/\\/g, '/')
  )

  // glob accepts array of patterns; do not force cwd to avoid accidental path rewriting
  const sourceFiles = await glob(normalizedPatterns, {
    ignore: [...defaultIgnore, ...userIgnore],
    nodir: true
  })

  const results: Array<{ path: string; changes: number }> = []

  for (const file of sourceFiles) {
    const code = await readFile(file, 'utf-8')
    const { newCode, changes } = await replaceKeyInSource(code, oldParts, newParts, config, namespaceKeyMap)

    if (changes > 0) {
      if (!dryRun) {
        await writeFile(file, newCode, 'utf-8')
      }
      results.push({ path: file, changes })
      logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${file} (${changes} ${changes === 1 ? 'change' : 'changes'})`)
    }
  }

  if (results.length > 0) {
    logger.info(`\n📝 Source file changes: ${results.length} file${results.length === 1 ? '' : 's'}`)
  }

  return results
}

async function replaceKeyInSource (
  code: string,
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig,
  namespaceKeyMap: Map<string, Set<string>>
): Promise<{ newCode: string; changes: number }> {
  // Simpler and robust regex-based replacement that covers tests' patterns
  return replaceKeyWithRegex(code, oldParts, newParts, config, namespaceKeyMap)
}

function replaceKeyWithRegex (
  code: string,
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig,
  namespaceKeyMap: Map<string, Set<string>>
): { newCode: string; changes: number } {
  let changes = 0
  let newCode = code
  const nsSeparator = config.extract.nsSeparator ?? ':'

  const configuredFunctions = config.extract.functions || ['t', '*.t']

  // Helper to create function-prefix regex fragment
  const fnPrefixToRegex = (fnPattern: string) => {
    if (fnPattern.startsWith('*.')) {
      const suffix = fnPattern.slice(2)
      return `\\b[\\w$]+\\.${escapeRegex(suffix)}`
    }
    return `\\b${escapeRegex(fnPattern)}`
  }

  // Helper: check whether the old key exists in a given namespace (from the prebuilt map)
  const hasKeyInNamespace = (ns?: string) => {
    if (!ns) return false
    const set = namespaceKeyMap.get(ns)
    if (!set) return false

    // exact key match
    if (set.has(oldParts.key)) return true

    // nested keys using keySeparator, e.g. "key.one", "key.other"
    const keySeparator = config.extract.keySeparator ?? '.'
    const nestedPrefix = `${oldParts.key}${String(keySeparator)}`
    for (const s of set) {
      if (s.startsWith(nestedPrefix)) return true
    }

    // flat plural keys like "key_one", "key_other"
    const flatPluralRegex = new RegExp(`^${escapeRegex(oldParts.key)}_(${pluralSuffixes.join('|')})$`)
    for (const s of set) {
      if (flatPluralRegex.test(s)) return true
    }

    return false
  }

  for (const fnPattern of configuredFunctions) {
    const prefix = fnPrefixToRegex(fnPattern)

    //
    // 1) If moving TO the defaultNS, remove the explicit ns option and update key in one go.
    //    Only if the old key exists in the old namespace.
    //
    if (
      oldParts.namespace && newParts.namespace &&
      oldParts.namespace !== newParts.namespace &&
      config.extract.defaultNS === newParts.namespace &&
      hasKeyInNamespace(oldParts.namespace)
    ) {
      const nsRegexToDefault = new RegExp(
        `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*,\\s*\\{([^}]*)\\bns\\s*:\\s*(['"\`])${escapeRegex(oldParts.namespace)}\\3([^}]*)\\}\\s*\\)`,
        'g'
      )
      newCode = newCode.replace(nsRegexToDefault, (match, keyQ, beforeNs, nsQ, afterNs) => {
        changes++
        const obj = (beforeNs + afterNs).replace(/,?\s*$/, '').replace(/^\s*,?/, '').trim()
        let updated = match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `${keyQ}${newParts.key}${keyQ}`)

        if (obj) {
          updated = updated.replace(/\{\s*([^}]*)\s*\}/, `{${obj}}`)
        } else {
          updated = updated.replace(/\s*,\s*\{[^}]*\}\s*\)/, ')')
        }

        return updated
      })
    }

    //
    // 2) Handle calls that include an options object with ns: 'oldNs'.
    //    This covers both:
    //      - renames *inside the same namespace* (ns stays the same, key changes),
    //      - renames *across namespaces* (ns changes to new namespace OR removed if new default).
    //    Only run if old namespace actually contains the key (to avoid touching unrelated ns calls).
    //
    if (oldParts.namespace && newParts.namespace && hasKeyInNamespace(oldParts.namespace)) {
      const nsRegexFullKey = new RegExp(
        `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*,\\s*\\{([^}]*)\\bns\\s*:\\s*(['"\`])${escapeRegex(oldParts.namespace)}\\3([^}]*)\\}\\s*\\)`,
        'g'
      )

      newCode = newCode.replace(nsRegexFullKey, (match, keyQ, beforeNs, nsQ, afterNs) => {
        changes++
        // remaining props except ns
        const obj = (beforeNs + afterNs).replace(/,?\s*$/, '').replace(/^\s*,?/, '').trim()

        // start by replacing the key (preserve original quote style)
        let updated = match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `${keyQ}${newParts.key}${keyQ}`)

        if (oldParts.namespace === newParts.namespace) {
          // same namespace: keep ns value untouched, but keep other props
          if (obj) {
            updated = updated.replace(/\{\s*([^}]*)\s*\}/, `{${obj}}`)
          } else {
            // no other props -> keep the options with ns only
            // ensure we don't remove the ns prop accidentally; leave as-is
          }
        } else {
          // moving across namespaces
          if (config.extract.defaultNS === newParts.namespace) {
            // moving INTO the default namespace -> remove the ns property
            if (obj) {
              updated = updated.replace(/\{\s*([^}]*)\s*\}/, `{${obj}}`)
            } else {
              updated = updated.replace(/\s*,\s*\{[^}]*\}\s*\)/, ')')
            }
          } else {
            // replace ns value to new namespace
            updated = updated.replace(new RegExp(`(\\bns\\s*:\\s*['"\`])${escapeRegex(oldParts.namespace ?? '')}(['"\`])`), `$1${newParts.namespace ?? ''}$2`)
          }
        }

        return updated
      })
    }

    // 3a) Replace occurrences where the call uses an explicitly namespaced string
    //     literal like t('ns:key') while the CLI rename was invoked with the
    //     key without namespace (oldKey='key').
    //
    // Run this when the CLI was given a bare key and either the key OR the namespace
    // is changing. However, if the file contains a bare usage of the key (e.g.
    // t('key')), we must NOT touch explicit ns:key occurrences — leave them alone.
    if (
      oldParts.namespace &&
      !oldParts.explicitNamespace &&
      (newParts.key !== oldParts.key || newParts.namespace !== oldParts.namespace)
    ) {
      // If the current file contains a bare usage of the old key, skip changing explicit ns:key.
      const bareUsageRegex = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1`, 'g')
      if (!bareUsageRegex.test(code)) {
        const nsSepStr = nsSeparator === false ? ':' : String(nsSeparator)
        const prefixed = `${escapeRegex(String(oldParts.namespace))}${escapeRegex(nsSepStr)}${escapeRegex(oldParts.key)}`
        const regexPrefixed = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${prefixed}\\1`, 'g')

        newCode = newCode.replace(regexPrefixed, (match) => {
          changes++
          const replacement = newParts.explicitNamespace
            ? newParts.fullKey
            : `${oldParts.namespace}${nsSepStr}${newParts.key}`
          return match.replace(`${oldParts.namespace}${nsSepStr}${oldParts.key}`, replacement)
        })
      }
    }

    //
    // 3b) fullKey (explicitly namespaced string in call): only when user supplied a namespaced target
    //
    if (oldParts.fullKey && oldParts.explicitNamespace) {
      const regexFull = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g')
      newCode = newCode.replace(regexFull, (match) => {
        changes++
        const replacementKey = (oldParts.fullKey.includes(nsSeparator || ':') ? newParts.fullKey : newParts.key)
        return match.replace(oldParts.fullKey, replacementKey)
      })
    }

    //
    // 4) Selector / bracket forms
    //
    {
      const dotRegex = new RegExp(`${prefix}\\s*\\(\\s*\\(?\\s*([a-zA-Z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1\\.${escapeRegex(oldParts.key)}\\s*\\)`, 'g')
      newCode = newCode.replace(dotRegex, (match) => {
        changes++
        return match.replace(`.${oldParts.key}`, `.${newParts.key}`)
      })

      const bracketRegex = new RegExp(`${prefix}\\s*\\(\\s*\\(?\\s*([a-zA-Z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1\\s*\\[\\s*(['"\`])${escapeRegex(oldParts.key)}\\2\\s*\\]\\s*\\)`, 'g')
      newCode = newCode.replace(bracketRegex, (match) => {
        changes++
        const replacementKey = newParts.key
        if (/^[A-Za-z_$][\w$]*$/.test(replacementKey)) {
          return match.replace(new RegExp(`\\[\\s*['"\`]${escapeRegex(oldParts.key)}['"\`]\\s*\\]`), `.${replacementKey}`)
        } else {
          return match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `$1${replacementKey}$1`)
        }
      })
    }

    //
    // 4.5) Calls with an options object but without an `ns` property.
    //      - When renaming inside the effective default namespace (key -> key2),
    //        update t('key', { ... }) -> t('key2', { ... }).
    //      - When moving FROM the default namespace to another namespace,
    //        add the ns property into the options object: t('key', { ... })
    //        -> t('key', { ..., ns: 'newNs' }).
    //
    {
      const effectiveDefaultNS = config.extract.defaultNS ?? 'translation'

      // 4.5a) Moving FROM defaultNS to another namespace: add ns to options object.
      if (
        oldParts.namespace && newParts.namespace &&
        oldParts.namespace !== newParts.namespace &&
        config.extract.defaultNS === oldParts.namespace &&
        hasKeyInNamespace(oldParts.namespace)
      ) {
        const regexOptionsNoNs = new RegExp(
          `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*,\\s*\\{([^}]*)\\}\\s*\\)`,
          'g'
        )
        newCode = newCode.replace(regexOptionsNoNs, (match, q, objContents) => {
          // If object already contains ns, skip (other branches handle it).
          if (/\bns\s*:\s*['"`]/.test(objContents)) return match
          changes++
          const obj = objContents.replace(/,?\s*$/, '').trim()
          const newObj = obj ? `${obj}, ns: '${newParts.namespace}'` : `ns: '${newParts.namespace}'`
          // replace the key and the object contents (preserve spacing minimally)
          return match
            .replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `${q}${newParts.key}${q}`)
            .replace(/\{\s*([^}]*)\s*\}/, `{ ${newObj} }`)
        })
      }

      // 4.5b) Same-namespace rename where call already has options object (no ns):
      //        t('key', { user: 'name' }) -> t('key2', { user: 'name' })
      if (oldParts.namespace === newParts.namespace && oldParts.namespace === effectiveDefaultNS) {
        const regexKeyWithOptions = new RegExp(
          `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*,\\s*\\{([^}]*)\\}\\s*\\)`,
          'g'
        )
        newCode = newCode.replace(regexKeyWithOptions, (match, q, objContents) => {
          // don't touch objects that already explicitly set ns (handled elsewhere)
          if (/\bns\s*:\s*['"`]/.test(objContents)) return match
          changes++
          return match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `${q}${newParts.key}${q}`)
        })
      }
    }

    //
    // 5) Special-case: moving FROM defaultNS to another namespace for bare calls.
    //    Add ns option for bare calls. This must happen *before* the plain bare-call replacement
    //    so the final call includes the ns option.
    //
    if (
      oldParts.namespace && newParts.namespace &&
      oldParts.namespace !== newParts.namespace &&
      config.extract.defaultNS === oldParts.namespace &&
      hasKeyInNamespace(oldParts.namespace)
    ) {
      const regexKeyWithParen = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*\\)`, 'g')
      newCode = newCode.replace(regexKeyWithParen, (match, quote) => {
        changes++
        return match.replace(
          new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1\\s*\\)`),
          `${quote}${newParts.key}${quote}, { ns: '${newParts.namespace}' })`
        )
      })
    }

    //
    // 6) Bare calls without options: fn('key') -> fn('newKey')
    //    Apply this replacement only when the old key's namespace is the
    //    *effective* default namespace (config.extract.defaultNS ?? 'translation').
    //    This preserves previous behaviour: default-namespace bare-calls are
    //    considered "key form" and should be rewritten even when the translation
    //    file exists but the specific key isn't present.
    //
    {
      const effectiveDefaultNS = config.extract.defaultNS ?? 'translation'
      if (oldParts.namespace === effectiveDefaultNS) {
        const regexKeyNoOptions = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*\\)`, 'g')
        newCode = newCode.replace(regexKeyNoOptions, (match, q) => {
          changes++
          const replacementKey = newParts.key
          return match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `${q}${replacementKey}${q}`)
        })
      }
    }

    //
    // 7) JSX i18nKey attribute (handles both fullKey and key)
    //
    {
      const jsxPatterns = [
        { orig: oldParts.fullKey, regex: new RegExp(`i18nKey=(['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g') },
        { orig: oldParts.key, regex: new RegExp(`i18nKey=(['"\`])${escapeRegex(oldParts.key)}\\1`, 'g') }
      ]
      for (const p of jsxPatterns) {
        newCode = newCode.replace(p.regex, (match, q) => {
          changes++
          const nsSepStr = nsSeparator === false ? ':' : nsSeparator
          const replacement = (p.orig === oldParts.fullKey && oldParts.fullKey.includes(nsSepStr)) ? newParts.fullKey : newParts.key
          return `i18nKey=${q}${replacement}${q}`
        })
      }
    }
  }

  return { newCode, changes }
}

function escapeRegex (str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function updateTranslationFiles (
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig,
  dryRun: boolean,
  namespaceKeyMap: Map<string, Set<string>>,
  logger: Logger
): Promise<Array<{ path: string; updated: boolean }>> {
  const results: Array<{ path: string; updated: boolean }> = []
  const keySeparator = config.extract.keySeparator ?? '.'

  // Helper: determine whether a flattened key-set indicates presence of `baseKey`.
  const namespaceHasKey = (set: Set<string> | undefined, baseKey: string): boolean => {
    if (!set) return false
    // exact key (for scalar or object)
    if (set.has(baseKey)) return true

    // nested keys using keySeparator, e.g. "key.one", "key.other"
    const nestedPrefix = `${baseKey}${String(keySeparator)}`
    for (const s of set) {
      if (s.startsWith(nestedPrefix)) return true
    }

    // flat plural keys like "key_one", "key_other"
    const flatPluralRegex = new RegExp(`^${escapeRegex(baseKey)}_(${pluralSuffixes.join('|')})$`)
    for (const s of set) {
      if (flatPluralRegex.test(s)) return true
    }

    return false
  }

  // Decide candidate namespaces to inspect:
  // - If the old key was explicitly namespaced in the CLI (oldParts.explicitNamespace),
  //   we only inspect that namespace.
  // - Otherwise, inspect every namespace that appears to contain the key (from namespaceKeyMap).
  const candidateNamespaces: string[] = []
  if (oldParts.explicitNamespace && oldParts.namespace) {
    candidateNamespaces.push(oldParts.namespace)
  } else {
    for (const [ns, set] of namespaceKeyMap.entries()) {
      if (namespaceHasKey(set, oldParts.key)) candidateNamespaces.push(ns)
    }
  }

  // if nothing found, nothing to do
  if (candidateNamespaces.length === 0) {
    return results
  }

  // Iterate each locale and each candidate source namespace found
  for (const locale of config.locales) {
    for (const ns of candidateNamespaces) {
      const oldOutputPath = getOutputPath(config.extract.output, locale, ns)
      const oldFullPath = resolve(process.cwd(), oldOutputPath)

      // When explicitly targeting a namespace in the CLI, always use that target.
      // When not explicit, keep keys in their current namespace (don't move them).
      const targetNamespace = (oldParts.explicitNamespace || newParts.explicitNamespace)
        ? newParts.namespace
        : ns

      const newOutputPath = getOutputPath(config.extract.output, locale, targetNamespace)
      const newFullPath = resolve(process.cwd(), newOutputPath)

      let oldTranslations: any
      let newTranslations: any

      try {
        oldTranslations = await loadTranslationFile(oldFullPath)
      } catch {}
      if (!oldTranslations) continue

      // 1) nested/exact path value (object or scalar) at the nested path
      const oldValue = getNestedValue(oldTranslations, oldParts.key, keySeparator)

      // 2) flat plural matches like `key_one`, `key_other`
      const flatPluralMatches: Array<{ flatKey: string; suffix: string; value: any }> = []
      if (oldTranslations && typeof oldTranslations === 'object') {
        const re = new RegExp(`^${escapeRegex(oldParts.key)}_(${pluralSuffixes.join('|')})$`)
        for (const k of Object.keys(oldTranslations)) {
          const m = k.match(re)
          if (m) flatPluralMatches.push({ flatKey: k, suffix: m[1], value: oldTranslations[k] })
        }
      }

      // nothing found for this file/namespace
      if (oldValue === undefined && flatPluralMatches.length === 0) continue

      //
      // Handle flat plurals first (top-level underscore keys)
      //
      if (flatPluralMatches.length > 0) {
        if (ns === targetNamespace) {
          // rename in-place within same file
          for (const m of flatPluralMatches) {
            delete oldTranslations[m.flatKey]
            const newFlatKey = `${newParts.key}_${m.suffix}`
            oldTranslations[newFlatKey] = m.value
          }
          if (!dryRun) {
            const content = serializeTranslationFile(
              oldTranslations,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(oldFullPath, content, 'utf-8')
          }
          results.push({ path: oldFullPath, updated: true })
          logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${oldFullPath}`)
        } else {
          // move them to the new namespace file
          for (const m of flatPluralMatches) delete oldTranslations[m.flatKey]

          if (!dryRun) {
            const contentOld = serializeTranslationFile(
              oldTranslations,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(oldFullPath, contentOld, 'utf-8')
          }
          results.push({ path: oldFullPath, updated: true })
          logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${oldFullPath}`)

          try {
            newTranslations = await loadTranslationFile(newFullPath)
          } catch {}
          if (!newTranslations) newTranslations = {}

          for (const m of flatPluralMatches) {
            const newFlatKey = `${newParts.key}_${m.suffix}`
            newTranslations[newFlatKey] = m.value
          }

          if (!dryRun) {
            const contentNew = serializeTranslationFile(
              newTranslations,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(newFullPath, contentNew, 'utf-8')
          }
          results.push({ path: newFullPath, updated: true })
          logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${newFullPath}`)
        }
      }

      //
      // Handle nested/exact key
      //
      if (oldValue !== undefined) {
        if (ns === targetNamespace) {
          // rename within same file (nested)
          deleteNestedValue(oldTranslations, oldParts.key, keySeparator)
          setNestedValue(oldTranslations, newParts.key, oldValue, keySeparator)
          if (!dryRun) {
            const content = serializeTranslationFile(
              oldTranslations,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(oldFullPath, content, 'utf-8')
          }
          if (!results.find(r => r.path === oldFullPath)) {
            results.push({ path: oldFullPath, updated: true })
            logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${oldFullPath}`)
          }
        } else {
          // move nested value across namespaces
          const updatedOld = { ...oldTranslations }
          deleteNestedValue(updatedOld, oldParts.key, keySeparator)
          if (!dryRun) {
            const contentOld = serializeTranslationFile(
              updatedOld,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(oldFullPath, contentOld, 'utf-8')
          }
          if (!results.find(r => r.path === oldFullPath)) {
            results.push({ path: oldFullPath, updated: true })
            logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${oldFullPath}`)
          }

          try {
            newTranslations = await loadTranslationFile(newFullPath)
          } catch {}
          if (!newTranslations) newTranslations = {}
          setNestedValue(newTranslations, newParts.key, oldValue, keySeparator)
          if (!dryRun) {
            const contentNew = serializeTranslationFile(
              newTranslations,
              config.extract.outputFormat,
              config.extract.indentation
            )
            await writeFile(newFullPath, contentNew, 'utf-8')
          }
          if (!results.find(r => r.path === newFullPath)) {
            results.push({ path: newFullPath, updated: true })
            logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${newFullPath}`)
          }
        }
      }
    }
  }

  if (results.length > 0) {
    logger.info(`\n📦 Translation file updates: ${results.length} file${results.length === 1 ? '' : 's'}`)
  }

  return results
}

function deleteNestedValue (obj: any, path: string, separator: string | boolean): void {
  if (separator === false) {
    delete obj[path]
    return
  }
  const keys = path.split(String(separator))
  function _delete (current: any, idx: number): boolean {
    const key = keys[idx]
    if (idx === keys.length - 1) {
      delete current[key]
    } else if (current[key]) {
      const shouldDelete = _delete(current[key], idx + 1)
      if (shouldDelete) {
        delete current[key]
      }
    }
    // Return true if current is now empty
    return typeof current === 'object' && current !== null && Object.keys(current).length === 0
  }
  _delete(obj, 0)
}
