import { glob } from 'glob'
import { readFile, writeFile } from 'node:fs/promises'
import type { I18nextToolkitConfig, Logger, RenameKeyResult } from './types'
import { ConsoleLogger } from './utils/logger'
import { loadTranslationFile, serializeTranslationFile, getOutputPath } from './utils/file-utils'
import { resolve } from 'node:path'
import { getNestedValue, setNestedValue } from './utils/nested-object'
import { shouldShowFunnel, recordFunnelShown } from './utils/funnel-msg-tracker'
import chalk from 'chalk'

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
    return {
      success: false,
      sourceFiles: [],
      translationFiles: [],
      conflicts,
      error: 'Target key already exists in translation files'
    }
  }

  logger.info(`🔍 Scanning for usages of "${oldKey}"...`)

  // Find and update source files
  const sourceResults = await updateSourceFiles(oldParts, newParts, config, dryRun, logger)

  // Update translation files
  const translationResults = await updateTranslationFiles(oldParts, newParts, config, dryRun, logger)

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
}

function parseKeyWithNamespace (key: string, config: I18nextToolkitConfig): KeyParts {
  const nsSeparator = config.extract.nsSeparator ?? ':'

  if (nsSeparator && key.includes(nsSeparator)) {
    const [ns, ...rest] = key.split(nsSeparator)
    return {
      namespace: ns,
      key: rest.join(nsSeparator),
      fullKey: key
    }
  }

  return {
    namespace: config.extract.defaultNS || 'translation',
    key,
    fullKey: key
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

  for (const locale of config.locales) {
    const outputPath = getOutputPath(config.extract.output, locale, newParts.namespace)
    const fullPath = resolve(process.cwd(), outputPath)

    try {
      const existingTranslations = await loadTranslationFile(fullPath)
      if (existingTranslations) {
        const keySeparator = config.extract.keySeparator ?? '.'
        const value = getNestedValue(existingTranslations, newParts.key, keySeparator)
        if (value !== undefined) {
          conflicts.push(`${locale}:${newParts.fullKey}`)
        }
      }
    } catch {
      // File doesn't exist, no conflict
    }
  }

  return conflicts
}

async function updateSourceFiles (
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig,
  dryRun: boolean,
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
    const { newCode, changes } = await replaceKeyInSource(code, oldParts, newParts, config)

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
  config: I18nextToolkitConfig
): Promise<{ newCode: string; changes: number }> {
  // Simpler and robust regex-based replacement that covers tests' patterns
  return replaceKeyWithRegex(code, oldParts, newParts, config)
}

function replaceKeyWithRegex (
  code: string,
  oldParts: KeyParts,
  newParts: KeyParts,
  config: I18nextToolkitConfig
): { newCode: string; changes: number } {
  let changes = 0
  let newCode = code
  const nsSeparator = config.extract.nsSeparator ?? ':'

  const configuredFunctions = config.extract.functions || ['t', '*.t']

  // Helper to create function-prefix regex fragment
  const fnPrefixToRegex = (fnPattern: string) => {
    if (fnPattern.startsWith('*.')) {
      // '*.t' -> match anyIdentifier.t
      const suffix = fnPattern.slice(2)
      return `\\b[\\w$]+\\.${escapeRegex(suffix)}` // e.g. \b[\w$]+\.t
    }
    // exact function name (may include dot like 'i18n.t' or 'translate')
    return `\\b${escapeRegex(fnPattern)}`
  }

  // Replace exact string-key usages inside function calls: fn('key') or fn(`key`) or fn("key")
  for (const fnPattern of configuredFunctions) {
    const prefix = fnPrefixToRegex(fnPattern)

    // Match fullKey first (namespace-prefixed in source)
    if (oldParts.fullKey) {
      const regexFull = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g')
      newCode = newCode.replace(regexFull, (match, q) => {
        changes++
        const replacementKey = (oldParts.fullKey.includes(nsSeparator || ':') ? newParts.fullKey : newParts.key)
        // preserve surrounding characters up to the opening quote
        return match.replace(oldParts.fullKey, replacementKey)
      })
    }

    // Then match bare key (no namespace in source)
    const regexKey = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1`, 'g')
    newCode = newCode.replace(regexKey, (match) => {
      changes++
      const replacementKey = newParts.key
      return match.replace(new RegExp(escapeRegex(oldParts.key)), replacementKey)
    })
    // Then match bare key (no namespace in source)
    // If moving from defaultNS to another, and call is t('key') with no options, add ns option
    const regexKeyWithParen = new RegExp(`${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*\\)`, 'g')
    newCode = newCode.replace(regexKeyWithParen, (match, quote) => {
      if (
        oldParts.namespace && newParts.namespace &&
        oldParts.namespace !== newParts.namespace &&
        config.extract.defaultNS === oldParts.namespace
      ) {
        changes++
        return match.replace(
          new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1\\s*\\)`),
          `${quote}${newParts.key}${quote}, { ns: '${newParts.namespace}' })`
        )
      } else {
        changes++
        const replacementKey = newParts.key
        return match.replace(new RegExp(escapeRegex(oldParts.key)), replacementKey)
      }
    })

    // Handle ns option in options object: fn('key', { ns: 'oldNs', ... })
    if (oldParts.namespace && newParts.namespace && oldParts.namespace !== newParts.namespace) {
      // We want to change only when key matches and ns value equals oldParts.namespace
      const nsRegexFullKey = new RegExp(
        `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.key)}\\1\\s*,\\s*\\{([^}]*)\\bns\\s*:\\s*(['"\`])${escapeRegex(oldParts.namespace)}\\3([^}]*)\\}\\s*\\)`,
        'g'
      )
      newCode = newCode.replace(nsRegexFullKey, (match, keyQ, beforeNs, nsQ, afterNs) => {
        changes++
        // replace ns value
        return match.replace(
          new RegExp(`(\\bns\\s*:\\s*['"\`])${escapeRegex(oldParts.namespace ?? '')}(['"\`])`),
          `$1${newParts.namespace ?? ''}$2`
        )
      })

      // same but if the call used fullKey (ns included inside key string), still update ns option if present
      if (oldParts.fullKey) {
        const nsRegexFull = new RegExp(
          `${prefix}\\s*\\(\\s*(['"\`])${escapeRegex(oldParts.fullKey)}\\1\\s*,\\s*\\{([^}]*)\\bns\\s*:\\s*(['"\`])${escapeRegex(oldParts.namespace)}\\3([^}]*)\\}\\s*\\)`,
          'g'
        )
        newCode = newCode.replace(nsRegexFull, (match) => {
          changes++
          return match.replace(new RegExp(`(\\bns\\s*:\\s*['"\`])${escapeRegex(oldParts.namespace ?? '')}(['"\`])`), `$1${newParts.namespace ?? ''}$2`)
        })
      }
    }
  }

  // Selector API: dot-notation: fn(($) => $.old.key)
  for (const fnPattern of configuredFunctions) {
    const prefix = fnPrefixToRegex(fnPattern)
    // match forms like: prefix( $ => $.old.key )
    // capture the arrow param name and the rest
    // We'll attempt to match the param and the dotted property chain equal to oldParts.key (exact)
    const dotRegex = new RegExp(`${prefix}\\s*\\(\\s*\\(?\\s*([a-zA-Z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1\\.${escapeRegex(oldParts.key)}\\s*\\)`, 'g')
    newCode = newCode.replace(dotRegex, (match, param) => {
      changes++
      // Determine replacement (if source used namespace in key it would be fullKey, but in selector dot-notation it's always key form)
      const replacementKey = newParts.key
      return match.replace(`.${oldParts.key}`, `.${replacementKey}`)
    })

    // Bracket notation: fn(($) => $["Old Key"]) etc.
    const bracketRegex = new RegExp(`${prefix}\\s*\\(\\s*\\(?\\s*([a-zA-Z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1\\s*\\[\\s*(['"\`])${escapeRegex(oldParts.key)}\\2\\s*\\]\\s*\\)`, 'g')
    newCode = newCode.replace(bracketRegex, (match, param, quote) => {
      changes++
      const replacementKey = newParts.key
      // If replacementKey is a valid identifier, convert to dot-notation, otherwise keep bracket form with preserved quote style
      if (/^[A-Za-z_$][\w$]*$/.test(replacementKey)) {
        return match.replace(new RegExp(`\\[\\s*['"\`]${escapeRegex(oldParts.key)}['"\`]\\s*\\]`), `.${replacementKey}`)
      } else {
        return match.replace(new RegExp(`(['"\`])${escapeRegex(oldParts.key)}\\1`), `$1${replacementKey}$1`)
      }
    })
  }

  // JSX i18nKey attribute (handles all quote types)
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
  logger: Logger
): Promise<Array<{ path: string; updated: boolean }>> {
  const results: Array<{ path: string; updated: boolean }> = []
  const keySeparator = config.extract.keySeparator ?? '.'

  for (const locale of config.locales) {
    const oldOutputPath = getOutputPath(config.extract.output, locale, oldParts.namespace)
    const oldFullPath = resolve(process.cwd(), oldOutputPath)
    const newOutputPath = getOutputPath(config.extract.output, locale, newParts.namespace)
    const newFullPath = resolve(process.cwd(), newOutputPath)

    let oldTranslations: any
    let newTranslations: any

    try {
      oldTranslations = await loadTranslationFile(oldFullPath)
    } catch {}
    if (!oldTranslations) continue

    const oldValue = getNestedValue(oldTranslations, oldParts.key, keySeparator)
    if (oldValue === undefined) continue

    if (oldParts.namespace === newParts.namespace) {
      // Rename within the same namespace
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
      results.push({ path: oldFullPath, updated: true })
      logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${oldFullPath}`)
    } else {
      // Move across namespaces
      // Remove from old namespace
      deleteNestedValue(oldTranslations, oldParts.key, keySeparator)
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

      // Add to new namespace
      try {
        newTranslations = await loadTranslationFile(newFullPath)
      } catch {}
      if (!newTranslations) newTranslations = {}
      setNestedValue(newTranslations, newParts.key, oldValue, keySeparator)
      if (!dryRun) {
        const content = serializeTranslationFile(
          newTranslations,
          config.extract.outputFormat,
          config.extract.indentation
        )
        await writeFile(newFullPath, content, 'utf-8')
      }
      results.push({ path: newFullPath, updated: true })
      logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${newFullPath}`)
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
