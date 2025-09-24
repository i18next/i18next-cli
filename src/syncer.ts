import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'path'
import chalk from 'chalk'
import ora from 'ora'
import type { I18nextToolkitConfig } from './types'
import { getNestedKeys, getNestedValue, setNestedValue } from './utils/nested-object'
import { getOutputPath } from './utils/file-utils'

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

  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  const { primaryLanguage } = config.extract
  const secondaryLanguages = config.locales.filter(l => l !== primaryLanguage)
  const keySeparator = config.extract.keySeparator ?? '.'

  const logMessages: string[] = []
  let wasAnythingSynced = false

  // Assume sync operates on the default namespace for simplicity
  const defaultNS = config.extract.defaultNS ?? 'translation'

  // 1. Get all keys from the primary language file
  const primaryPath = getOutputPath(config.extract.output, primaryLanguage, defaultNS)

  const fullPrimaryPath = resolve(process.cwd(), primaryPath)

  let primaryTranslations: Record<string, any>
  try {
    const primaryContent = await readFile(fullPrimaryPath, 'utf-8')
    primaryTranslations = JSON.parse(primaryContent)
  } catch (e) {
    console.error(`Primary language file not found at ${primaryPath}. Cannot sync.`)
    return
  }

  const primaryKeys = getNestedKeys(primaryTranslations, keySeparator)

  // 2. Iterate through secondary languages and sync them
  for (const lang of secondaryLanguages) {
    const secondaryPath = getOutputPath(config.extract.output, lang, defaultNS)
    const fullSecondaryPath = resolve(process.cwd(), secondaryPath)

    let secondaryTranslations: Record<string, any> = {}
    let oldContent = ''
    try {
      oldContent = await readFile(fullSecondaryPath, 'utf-8')
      secondaryTranslations = JSON.parse(oldContent)
    } catch (e) { /* File doesn't exist, will be created */ }

    const newSecondaryTranslations: Record<string, any> = {}

    // Rebuild the secondary file based on the primary file's keys
    for (const key of primaryKeys) {
      const existingValue = getNestedValue(secondaryTranslations, key, keySeparator)
      // If value exists in old file, keep it. Otherwise, add as empty string.
      const valueToSet = existingValue ?? (config.extract?.defaultValue || '')
      setNestedValue(newSecondaryTranslations, key, valueToSet, keySeparator)
    }

    const indentation = config.extract.indentation ?? 2
    const newContent = JSON.stringify(newSecondaryTranslations, null, indentation)

    if (newContent !== oldContent) {
      wasAnythingSynced = true
      await mkdir(dirname(fullSecondaryPath), { recursive: true })
      await writeFile(fullSecondaryPath, newContent)
      logMessages.push(`  ${chalk.green('✓')} Synchronized: ${secondaryPath}`)
    } else {
      logMessages.push(`  ${chalk.gray('-')} Already in sync: ${secondaryPath}`)
    }
  }

  spinner.succeed(chalk.bold('Synchronization complete!'))
  logMessages.forEach(msg => console.log(msg))

  if (wasAnythingSynced) {
    console.log(chalk.green.bold('\n✅ Sync complete.'))
    console.log(chalk.yellow('🚀 Ready to collaborate with translators? Move your files to the cloud.'))
    console.log(`   Get started with the official TMS for i18next: ${chalk.cyan('npx i18next-toolkit locize-migrate')}`)
  } else {
    console.log(chalk.green.bold('\n✅ All locales are already in sync.'))
  }
}
