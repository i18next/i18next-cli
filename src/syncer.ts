import chalk from 'chalk'
import { glob } from 'glob'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import ora from 'ora'
import type { I18nextToolkitConfig } from './types'
import { resolveDefaultValue } from './utils/default-value'
import { getOutputPath, loadTranslationFile, serializeTranslationFile } from './utils/file-utils'
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
export async function runSyncer (config: I18nextToolkitConfig) {
  const spinner = ora('Running i18next locale synchronizer...\n').start()
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
    const primaryNsPattern = getOutputPath(output, primaryLanguage, '*')
    const primaryNsFiles = await glob(primaryNsPattern)

    if (primaryNsFiles.length === 0) {
      spinner.warn(`No translation files found for primary language "${primaryLanguage}". Nothing to sync.`)
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
          const serializedContent = serializeTranslationFile(newSecondaryTranslations, outputFormat, indentation)
          await mkdir(dirname(fullSecondaryPath), { recursive: true })
          await writeFile(fullSecondaryPath, serializedContent)
          logMessages.push(`  ${chalk.green('✓')} Synchronized: ${secondaryPath}`)
        } else {
          logMessages.push(`  ${chalk.gray('-')} Already in sync: ${secondaryPath}`)
        }
      }
    }

    spinner.succeed(chalk.bold('Synchronization complete!'))
    logMessages.forEach(msg => console.log(msg))

    if (wasAnythingSynced) {
      await printLocizeFunnel()
    } else {
      console.log(chalk.green.bold('\n✅ All locales are already in sync.'))
    }
  } catch (error) {
    spinner.fail(chalk.red('Synchronization failed.'))
    console.error(error)
  }
}

async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('syncer'))) return

  console.log(chalk.green.bold('\n✅ Sync complete.'))
  console.log(chalk.yellow('🚀 Ready to collaborate with translators? Move your files to the cloud.'))
  console.log(`   Get started with the official TMS for i18next: ${chalk.cyan('npx i18next-cli locize-migrate')}`)

  return recordFunnelShown('syncer')
}
