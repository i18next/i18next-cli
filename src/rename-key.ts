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

  const sourceFiles = await glob(normalizedPatterns, {
    ignore: [...defaultIgnore, ...userIgnore],
    cwd: process.cwd()
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
  // Use regex-based replacement which is more reliable than AST manipulation
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

  // Helper to determine which key form to use in replacement
  const getReplacementKey = (originalKey: string): string => {
    const hasNamespace = nsSeparator && originalKey.includes(String(nsSeparator))
    return hasNamespace ? newParts.fullKey : newParts.key
  }

  // Pattern 1: Function calls - respect configured functions
  const configuredFunctions = config.extract.functions || ['t', '*.t']
  const functionPatterns: Array<{ pattern: RegExp; original: string }> = []

  for (const fnPattern of configuredFunctions) {
    if (fnPattern.startsWith('*.')) {
      // Wildcard pattern like '*.t' - match any prefix
      const suffix = fnPattern.substring(1) // '.t'
      const escapedSuffix = escapeRegex(suffix)

      // Match: anyIdentifier.t('key')
      functionPatterns.push({
        pattern: new RegExp(`\\w+${escapedSuffix}\\((['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g'),
        original: oldParts.fullKey
      })
      functionPatterns.push({
        pattern: new RegExp(`\\w+${escapedSuffix}\\((['"\`])${escapeRegex(oldParts.key)}\\1`, 'g'),
        original: oldParts.key
      })
    } else {
      // Exact function name
      const escapedFn = escapeRegex(fnPattern)
      functionPatterns.push({
        pattern: new RegExp(`\\b${escapedFn}\\((['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g'),
        original: oldParts.fullKey
      })
      functionPatterns.push({
        pattern: new RegExp(`\\b${escapedFn}\\((['"\`])${escapeRegex(oldParts.key)}\\1`, 'g'),
        original: oldParts.key
      })
    }
  }

  for (const { pattern, original } of functionPatterns) {
    if (pattern.test(newCode)) {
      const replacement = getReplacementKey(original)
      newCode = newCode.replace(pattern, (match, quote) => {
        changes++
        // Preserve the function name part, only replace the key
        const functionNameMatch = match.match(/^(\w+(?:\.\w+)*)\(/)
        if (functionNameMatch) {
          return `${functionNameMatch[1]}(${quote}${replacement}${quote}`
        }
        return match
      })
    }
  }

  // Pattern 2: Selector API arrow functions (e.g. t(($) => $.old.key) or i18n.t($ => $.old.key))
  // Respect configured function names (including wildcard patterns)
  for (const fnPattern of configuredFunctions) {
    // Build a regex prefix for the function invocation (handles wildcard '*.t' -> '\w+\.t')
    let patternPrefix: string
    if (fnPattern.startsWith('*.')) {
      const suffix = fnPattern.substring(1) // '.t'
      patternPrefix = `\\w+${escapeRegex(suffix)}`
    } else {
      patternPrefix = escapeRegex(fnPattern)
    }

    // Try matching both the plain key and the ns-prefixed fullKey used in selector access
    for (const original of [oldParts.fullKey, oldParts.key]) {
      // Match forms like:
      // t(($) => $.old.key)
      // i18n.t($ => $.old.key.nested)
      const selectorRegex = new RegExp(
        `(\\b${patternPrefix}\\(\\s*\\(?\\s*([a-zA-Z_$][\\w$]*)\\s*\\)?\\s*=>\\s*)\\2\\.${escapeRegex(original)}(\\s*\\))`,
        'g'
      )

      if (selectorRegex.test(newCode)) {
        const replacementKey = getReplacementKey(original)
        newCode = newCode.replace(selectorRegex, (match, prefix, param, suffix) => {
          changes++
          // Rebuild the arrow function while replacing only the property chain
          return `${prefix}${param}.${replacementKey}${suffix}`
        })
      }
    }
  }

  // Pattern 3: JSX i18nKey attribute - respect configured transComponents
  // const transComponents = config.extract.transComponents || ['Trans']

  // Create a pattern that matches i18nKey on any of the configured components
  // This is a simplified approach - for more complex cases, consider AST-based replacement
  const i18nKeyPatterns = [
    { pattern: new RegExp(`i18nKey=(['"\`])${escapeRegex(oldParts.fullKey)}\\1`, 'g'), original: oldParts.fullKey },
    { pattern: new RegExp(`i18nKey=(['"\`])${escapeRegex(oldParts.key)}\\1`, 'g'), original: oldParts.key }
  ]

  for (const { pattern, original } of i18nKeyPatterns) {
    if (pattern.test(newCode)) {
      const replacement = getReplacementKey(original)
      newCode = newCode.replace(pattern, (match, quote) => {
        changes++
        return `i18nKey=${quote}${replacement}${quote}`
      })
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
  logger: Logger
): Promise<Array<{ path: string; updated: boolean }>> {
  const results: Array<{ path: string; updated: boolean }> = []
  const keySeparator = config.extract.keySeparator ?? '.'

  for (const locale of config.locales) {
    const outputPath = getOutputPath(config.extract.output, locale, oldParts.namespace)
    const fullPath = resolve(process.cwd(), outputPath)

    try {
      const translations = await loadTranslationFile(fullPath)
      if (!translations) continue

      const oldValue = getNestedValue(translations, oldParts.key, keySeparator)
      if (oldValue === undefined) continue

      // Remove old key
      deleteNestedValue(translations, oldParts.key, keySeparator)

      // Add new key with same value
      setNestedValue(translations, newParts.key, oldValue, keySeparator)

      if (!dryRun) {
        const content = serializeTranslationFile(
          translations,
          config.extract.outputFormat,
          config.extract.indentation
        )
        await writeFile(fullPath, content, 'utf-8')
      }

      results.push({ path: fullPath, updated: true })
      logger.info(`   ${dryRun ? '(dry-run) ' : ''}✓ ${fullPath}`)
    } catch (error) {
      // File doesn't exist or couldn't be processed
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
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) return
    current = current[keys[i]]
  }
  delete current[keys[keys.length - 1]]
}
