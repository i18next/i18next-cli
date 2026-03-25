import { styleText } from 'node:util'
import { glob } from 'glob'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createSpinnerLike } from './utils/wrap-ora.js'
import { ConsoleLogger } from './utils/logger.js'
import type { I18nextToolkitConfig, Logger } from './types.js'
import { resolveDefaultValue } from './utils/default-value.js'
import { getOutputPath, loadTranslationFile, serializeTranslationFile, loadRawJson5Content, inferFormatFromPath } from './utils/file-utils.js'
import { recordFunnelShown, shouldShowFunnel } from './utils/funnel-msg-tracker.js'
import { getNestedKeys, getNestedValue, setNestedValue } from './utils/nested-object.js'
import { safePluralRules } from './utils/plural-rules.js'

/**
 * Synchronizes translation files across different locales by ensuring all secondary
 * language files contain the same keys as the primary language file.
 *
 * This function:
 * 1. Reads the primary language translation file
 * 2. Extracts all translation keys from the primary file
 * 3. For each secondary language:
 *    - Preserves existing translations
 *    - Adds missing keys with empty values or configured default
 *    - Removes keys that no longer exist in primary
 * 4. Only writes files that have changes
 *
 * @param config - The i18next toolkit configuration object
 *
 * @example
 * ```typescript
 * // Configuration
 * const config = {
 *   locales: ['en', 'de', 'fr'],
 *   extract: {
 *     output: 'locales/{{language}}/{{namespace}}.json',
 *     defaultNS: 'translation'
 *     defaultValue: '[MISSING]'
 *   }
 * }
 *
 * await runSyncer(config)
 * ```
 */
export async function runSyncer (
  config: I18nextToolkitConfig,
  options: { quiet?: boolean, logger?: Logger } = {}
) {
  const internalLogger = options.logger ?? new ConsoleLogger()
  const spinner = createSpinnerLike('Running i18next locale synchronizer...\n', { quiet: !!options.quiet, logger: options.logger })
  try {
    const primaryLanguage = config.extract.primaryLanguage || config.locales[0] || 'en'
    const secondaryLanguages = config.locales.filter((l) => l !== primaryLanguage)
    const {
      output,
      keySeparator = '.',
      outputFormat = 'json',
      indentation = 2,
      defaultValue = '',
    } = config.extract

    const logMessages: string[] = []
    let wasAnythingSynced = false

    // 1. Find all namespace files for the primary language
    const primaryNsPatternRaw = getOutputPath(output, primaryLanguage, '*')
    // Ensure glob receives POSIX-style separators so pattern matching works cross-platform (Windows -> backslashes)
    const primaryNsPattern = primaryNsPatternRaw.replace(/\\/g, '/')
    const primaryNsFiles = await glob(primaryNsPattern)

    if (primaryNsFiles.length === 0) {
      const noFilesMsg = `No translation files found for primary language "${primaryLanguage}". Nothing to sync.`
      spinner.warn(noFilesMsg)
      // Always emit the message to the provided logger (if any) so tests / CI can observe it
      if (typeof internalLogger.warn === 'function') internalLogger.warn(noFilesMsg)
      else console.warn(noFilesMsg)
      return
    }

    // Filter out ignored namespaces
    const ignoreNamespaces = new Set(config.extract.ignoreNamespaces ?? [])

    // 2. Loop through each primary namespace file
    for (const primaryPath of primaryNsFiles) {
      const ns = basename(primaryPath).split('.')[0]
      // Skip ignored namespaces
      if (ignoreNamespaces.has(ns)) continue
      const primaryTranslations = await loadTranslationFile(primaryPath)

      if (!primaryTranslations) {
        logMessages.push(`  ${styleText('yellow', '-')} Could not read primary file: ${primaryPath}`)
        continue
      }

      const primaryKeys = getNestedKeys(primaryTranslations, keySeparator ?? '.')
      const primaryKeySet = new Set(primaryKeys)

      // 3. For each secondary language, sync the current namespace
      for (const lang of secondaryLanguages) {
        const secondaryPath = getOutputPath(output, lang, ns)
        const fullSecondaryPath = resolve(process.cwd(), secondaryPath)
        const existingSecondaryTranslations = await loadTranslationFile(fullSecondaryPath) || {}
        const newSecondaryTranslations: Record<string, any> = {}

        // Determine CLDR plural categories for this specific secondary locale so
        // we can recognise locale-specific plural suffixes (e.g. `_many` for fr/es)
        // that are not present in the primary language and must not be discarded.
        const sep = config.extract.pluralSeparator ?? '_'
        const localeCardinalCategories: Set<string> = (() => {
          try {
            return new Set(safePluralRules(lang, { type: 'cardinal' }).resolvedOptions().pluralCategories)
          } catch {
            return new Set(['one', 'other'])
          }
        })()
        const localeOrdinalCategories: Set<string> = (() => {
          try {
            return new Set(safePluralRules(lang, { type: 'ordinal' }).resolvedOptions().pluralCategories)
          } catch {
            return new Set(['one', 'other', 'two', 'few'])
          }
        })()

        /**
         * Returns true when `key` is a plural variant that is:
         *  1. Valid for this locale's CLDR rules (cardinal or ordinal), AND
         *  2. Derived from a base key that exists in the primary locale.
         *
         * This handles both cardinal (`title_many`) and ordinal
         * (`place_ordinal_few`) suffixes so neither gets erased during sync.
         */
        const isLocaleSpecificPluralExtension = (key: string): boolean => {
          // Cardinal: key ends with `{sep}{category}` and base key is in primary
          for (const cat of localeCardinalCategories) {
            const suffix = `${sep}${cat}`
            if (key.endsWith(suffix)) {
              const base = key.slice(0, -suffix.length)
              // The base itself, or any primary key that starts with `{base}{sep}`,
              // confirms this is a plural family rooted in the primary locale.
              if (primaryKeySet.has(base) || primaryKeys.some(pk => pk.startsWith(`${base}${sep}`))) {
                return true
              }
            }
          }
          // Ordinal: key ends with `{sep}ordinal{sep}{category}`
          for (const cat of localeOrdinalCategories) {
            const suffix = `${sep}ordinal${sep}${cat}`
            if (key.endsWith(suffix)) {
              const base = key.slice(0, -suffix.length)
              if (primaryKeySet.has(base) || primaryKeys.some(pk => pk.startsWith(`${base}${sep}`))) {
                return true
              }
            }
          }
          return false
        }

        // Build newSecondaryTranslations in a single, order-preserving pass so
        // that the syncer and the extractor produce byte-identical files after
        // the first extract run (issue #216).
        //
        // Strategy:
        //  1. Walk every key in the *existing* secondary file in its current
        //     order.  Keep it if it belongs to the primary key set, or if it is
        //     a valid locale-specific plural extension with a non-empty value.
        //     Obsolete keys (neither primary nor a locale extension) are dropped.
        //  2. Append any primary keys that are genuinely new (not present in the
        //     existing secondary file at all) so they get picked up on first sync.
        //
        // This means that once `extract` has written the secondary file in its
        // canonical order, a subsequent `sync` will read that order and reproduce
        // it exactly — the pipeline becomes idempotent.
        const existingSecondaryKeys = getNestedKeys(existingSecondaryTranslations, keySeparator ?? '.')
        const handledKeys = new Set<string>()

        // Pass 1: existing keys in their current order (preserves extract's ordering)
        for (const key of existingSecondaryKeys) {
          if (primaryKeySet.has(key)) {
            const primaryValue = getNestedValue(primaryTranslations, key, keySeparator ?? '.')
            const existingValue = getNestedValue(existingSecondaryTranslations, key, keySeparator ?? '.')
            const valueToSet = existingValue ?? resolveDefaultValue(defaultValue, key, ns, lang, primaryValue)
            setNestedValue(newSecondaryTranslations, key, valueToSet, keySeparator ?? '.')
            handledKeys.add(key)
          } else if (isLocaleSpecificPluralExtension(key)) {
            const existingValue = getNestedValue(existingSecondaryTranslations, key, keySeparator ?? '.')
            // Only preserve non-empty values; an empty string was likely a
            // placeholder left by a previous (buggy) sync run and should not
            // be perpetuated.
            if (existingValue !== '' && existingValue != null) {
              setNestedValue(newSecondaryTranslations, key, existingValue, keySeparator ?? '.')
              handledKeys.add(key)
            }
          }
          // else: obsolete key — omit it from the output
        }

        // Pass 2: new primary keys not yet in the secondary file
        for (const key of primaryKeys) {
          if (!handledKeys.has(key)) {
            const primaryValue = getNestedValue(primaryTranslations, key, keySeparator ?? '.')
            const valueToSet = resolveDefaultValue(defaultValue, key, ns, lang, primaryValue)
            setNestedValue(newSecondaryTranslations, key, valueToSet, keySeparator ?? '.')
          }
        }

        // Use JSON.stringify for a reliable object comparison, regardless of format
        const oldContent = JSON.stringify(existingSecondaryTranslations)
        const newContent = JSON.stringify(newSecondaryTranslations)

        if (newContent !== oldContent) {
          wasAnythingSynced = true
          const perFileFormat = config.extract.outputFormat ?? inferFormatFromPath(fullSecondaryPath, outputFormat)
          const raw = perFileFormat === 'json5' ? (await loadRawJson5Content(fullSecondaryPath)) ?? undefined : undefined
          const serializedContent = serializeTranslationFile(newSecondaryTranslations, perFileFormat, indentation, raw)
          await mkdir(dirname(fullSecondaryPath), { recursive: true })
          await writeFile(fullSecondaryPath, serializedContent)
          logMessages.push(`  ${styleText('green', '✓')} Synchronized: ${secondaryPath}`)
        } else {
          logMessages.push(`  ${styleText('gray', '-')} Already in sync: ${secondaryPath}`)
        }
      }
    }

    spinner.succeed(styleText('bold', 'Synchronization complete!'))
    logMessages.forEach(msg => internalLogger.info ? internalLogger.info(msg) : console.log(msg))

    if (wasAnythingSynced && !options.quiet) {
      await printLocizeFunnel()
    } else if (!wasAnythingSynced) {
      if (typeof internalLogger.info === 'function') internalLogger.info(styleText(['green', 'bold'], '\n✅ All locales are already in sync.'))
      else console.log(styleText(['green', 'bold'], '\n✅ All locales are already in sync.'))
    }
  } catch (error) {
    spinner.fail(styleText('red', 'Synchronization failed.'))
    if (typeof internalLogger.error === 'function') internalLogger.error(error)
    else console.error(error)
  }
}

async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('syncer'))) return

  console.log(styleText(['green', 'bold'], '\n✅ Sync complete.'))
  console.log(styleText('yellow', '🚀 Ready to collaborate with translators? Move your files to the cloud.'))
  console.log(`   Get started with the official TMS for i18next: ${styleText('cyan', 'npx i18next-cli locize-migrate')}`)

  return recordFunnelShown('syncer')
}
