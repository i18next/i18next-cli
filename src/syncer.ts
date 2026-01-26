import chalk from 'chalk'
import { glob } from 'glob'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createSpinnerLike } from './utils/wrap-ora'
import { ConsoleLogger } from './utils/logger'
import type { I18nextToolkitConfig, Logger } from './types'
import { resolveDefaultValue } from './utils/default-value'
import { getOutputPath, loadTranslationFile, serializeTranslationFile, loadRawJson5Content } from './utils/file-utils'
import { recordFunnelShown, shouldShowFunnel } from './utils/funnel-msg-tracker'
import { getNestedKeys, getNestedValue, setNestedValue } from './utils/nested-object'

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

    // 2. Loop through each primary namespace file
    for (const primaryPath of primaryNsFiles) {
      const ns = basename(primaryPath).split('.')[0]
      const primaryTranslations = await loadTranslationFile(primaryPath)

      if (!primaryTranslations) {
        logMessages.push(`  ${chalk.yellow('-')} Could not read primary file: ${primaryPath}`)
        continue
      }

      const primaryKeys = getNestedKeys(primaryTranslations, keySeparator ?? '.')

      // 3. For each secondary language, sync the current namespace
      for (const lang of secondaryLanguages) {
        const secondaryPath = getOutputPath(output, lang, ns)
        const fullSecondaryPath = resolve(process.cwd(), secondaryPath)
        const existingSecondaryTranslations = await loadTranslationFile(fullSecondaryPath) || {}
        const newSecondaryTranslations: Record<string, any> = {}

        for (const key of primaryKeys) {
          const primaryValue = getNestedValue(primaryTranslations, key, keySeparator ?? '.')
          const existingValue = getNestedValue(existingSecondaryTranslations, key, keySeparator ?? '.')

          // Use the resolved default value if no existing value
          const valueToSet = existingValue ?? resolveDefaultValue(defaultValue, key, ns, lang, primaryValue)
          setNestedValue(newSecondaryTranslations, key, valueToSet, keySeparator ?? '.')
        }

        // Use JSON.stringify for a reliable object comparison, regardless of format
        const oldContent = JSON.stringify(existingSecondaryTranslations)
        const newContent = JSON.stringify(newSecondaryTranslations)

        if (newContent !== oldContent) {
          wasAnythingSynced = true
          const perFileFormat = config.extract.outputFormat ?? (fullSecondaryPath.endsWith('.json5') ? 'json5' : outputFormat)
          const raw = perFileFormat === 'json5' ? (await loadRawJson5Content(fullSecondaryPath)) ?? undefined : undefined
          const serializedContent = serializeTranslationFile(newSecondaryTranslations, perFileFormat, indentation, raw)
          await mkdir(dirname(fullSecondaryPath), { recursive: true })
          await writeFile(fullSecondaryPath, serializedContent)
          logMessages.push(`  ${chalk.green('✓')} Synchronized: ${secondaryPath}`)
        } else {
          logMessages.push(`  ${chalk.gray('-')} Already in sync: ${secondaryPath}`)
        }
      }
    }

    spinner.succeed(chalk.bold('Synchronization complete!'))
    logMessages.forEach(msg => internalLogger.info ? internalLogger.info(msg) : console.log(msg))

    if (wasAnythingSynced) {
      await printLocizeFunnel()
    } else {
      if (typeof internalLogger.info === 'function') internalLogger.info(chalk.green.bold('\n✅ All locales are already in sync.'))
      else console.log(chalk.green.bold('\n✅ All locales are already in sync.'))
    }
  } catch (error) {
    spinner.fail(chalk.red('Synchronization failed.'))
    if (typeof internalLogger.error === 'function') internalLogger.error(error)
    else console.error(error)
  }
}

async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('syncer'))) return

  console.log(chalk.green.bold('\n✅ Sync complete.'))
  console.log(chalk.yellow('🚀 Ready to collaborate with translators? Move your files to the cloud.'))
  console.log(`   Get started with the official TMS for i18next: ${chalk.cyan('npx i18next-cli locize-migrate')}`)

  return recordFunnelShown('syncer')
}
