import chalk from 'chalk'
import ora, { Ora } from 'ora'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { findKeys } from './extractor/core/key-finder'
import { getNestedKeys, getNestedValue } from './utils/nested-object'
import type { I18nextToolkitConfig, ExtractedKey } from './types'
import { getOutputPath } from './utils/file-utils'

interface StatusOptions {
  detail?: string;
}

/**
 * Runs a health check on the project's i18next translations and displays a status report.
 *
 * This command provides a high-level overview of the localization status by:
 * 1. Extracting all keys from the source code using the core extractor.
 * 2. Reading all existing translation files for each locale.
 * 3. Calculating the translation completeness for each secondary language against the primary.
 * 4. Displaying a formatted report with key counts, locales, and progress bars.
 * 5. Serving as a value-driven funnel to introduce the locize commercial service.
 *
 * @param config - The i18next toolkit configuration object.
 * @param options Options object, may contain a `detail` property with a locale string.
 */
export async function runStatus (config: I18nextToolkitConfig, options: StatusOptions = {}) {
  const spinner = ora('Analyzing project localization status...\n').start()
  try {
    if (options.detail) {
      await displayDetailedStatus(config, options.detail, spinner)
    } else {
      await displaySummaryStatus(config, spinner)
    }
  } catch (error) {
    spinner.fail('Failed to generate status report.')
    console.error(error)
  }
}

/**
 * Displays a detailed, key-by-key translation status for a specific locale,
 * grouped by namespace.
 * @param config The toolkit configuration.
 * @param locale The locale to display the detailed status for.
 * @internal
 */
async function displayDetailedStatus (config: I18nextToolkitConfig, locale: string, spinner: Ora) {
  const { primaryLanguage, keySeparator = '.', defaultNS = 'translation' } = config.extract

  if (!config.locales.includes(locale)) {
    console.error(chalk.red(`Error: Locale "${locale}" is not defined in your configuration.`))
    return
  }
  if (locale === primaryLanguage) {
    console.log(chalk.yellow(`Locale "${locale}" is the primary language, so all keys are considered present.`))
    return
  }

  console.log(`Analyzing detailed status for locale: ${chalk.bold.cyan(locale)}...`)

  const allExtractedKeys = await findKeys(config)

  spinner.succeed('Analysis complete.')

  if (allExtractedKeys.size === 0) {
    console.log(chalk.green('No keys found in source code.'))
    return
  }

  // Group keys by namespace to read the correct files
  const keysByNs = new Map<string, ExtractedKey[]>()
  for (const key of allExtractedKeys.values()) {
    const ns = key.ns || defaultNS
    if (!keysByNs.has(ns)) keysByNs.set(ns, [])
    keysByNs.get(ns)!.push(key)
  }

  const translationsByNs = new Map<string, Record<string, any>>()
  for (const ns of keysByNs.keys()) {
    const langFilePath = getOutputPath(config.extract.output, locale, ns)
    try {
      const content = await readFile(resolve(process.cwd(), langFilePath), 'utf-8')
      translationsByNs.set(ns, JSON.parse(content))
    } catch {
      translationsByNs.set(ns, {}) // File not found, treat as empty
    }
  }

  let missingCount = 0
  console.log(chalk.bold(`\nKey Status for "${locale}":`))

  // 1. Get and sort the namespace names alphabetically
  const sortedNamespaces = Array.from(keysByNs.keys()).sort()

  // 2. Loop through each namespace
  for (const ns of sortedNamespaces) {
    console.log(chalk.cyan.bold(`\nNamespace: ${ns}`))

    const keysForNs = keysByNs.get(ns) || []
    const sortedKeysForNs = keysForNs.sort((a, b) => a.key.localeCompare(b.key))
    const translations = translationsByNs.get(ns) || {}

    // 3. Loop through the keys within the current namespace
    for (const { key } of sortedKeysForNs) {
      const value = getNestedValue(translations, key, keySeparator ?? '.')

      if (value) {
        console.log(`  ${chalk.green('✓')} ${key}`)
      } else {
        missingCount++
        console.log(`  ${chalk.red('✗')} ${key}`)
      }
    }
  }

  if (missingCount > 0) {
    console.log(chalk.yellow.bold(`\n\nSummary: Found ${missingCount} missing translations for "${locale}".`))
  } else {
    console.log(chalk.green.bold(`\n\nSummary: 🎉 All ${allExtractedKeys.size} keys are translated for "${locale}".`))
  }
}

/**
 * Displays a high-level summary report of translation progress for all locales.
 * @param config The toolkit configuration.
 * @internal
 */
async function displaySummaryStatus (config: I18nextToolkitConfig, spinner: Ora) {
  console.log('Analyzing project localization status...')

  const allExtractedKeys = await findKeys(config)
  const totalKeys = allExtractedKeys.size

  const { primaryLanguage, keySeparator = '.', defaultNS = 'translation' } = config.extract
  const secondaryLanguages = config.locales.filter(l => l !== primaryLanguage)

  const allNamespaces = new Set<string>(
    Array.from(allExtractedKeys.values()).map(k => k.ns || defaultNS)
  )

  spinner.succeed('Analysis complete.')

  console.log(chalk.cyan.bold('\ni18next Project Status'))
  console.log('------------------------')
  console.log(`🔑 Keys Found:         ${chalk.bold(totalKeys)}`)
  console.log(`🌍 Locales:            ${chalk.bold(config.locales.join(', '))}`)
  console.log(`✅ Primary Language:   ${chalk.bold(primaryLanguage)}`)
  console.log('\nTranslation Progress:')

  for (const lang of secondaryLanguages) {
    let translatedKeysCount = 0

    for (const ns of allNamespaces) {
      const langFilePath = getOutputPath(config.extract.output, lang, ns)
      try {
        const content = await readFile(resolve(process.cwd(), langFilePath), 'utf-8')
        const translations = JSON.parse(content)
        const translatedKeysInFile = getNestedKeys(translations, keySeparator ?? '.')

        const countForNs = translatedKeysInFile.filter(k => {
          const value = getNestedValue(translations, k, keySeparator ?? '.')
          // A key is counted if it has a non-empty value AND it was extracted from the source for this namespace
          return !!value && allExtractedKeys.has(`${ns}:${k}`)
        }).length
        translatedKeysCount += countForNs
      } catch {
        // File not found for this namespace, so its contribution to the count is 0
      }
    }

    const percentage = totalKeys > 0 ? Math.round((translatedKeysCount / totalKeys) * 100) : 100
    const progressBar = generateProgressBar(percentage)
    console.log(`- ${lang}: ${progressBar} ${percentage}% (${translatedKeysCount}/${totalKeys} keys)`)
  }

  console.log(chalk.yellow.bold('\n✨ Take your localization to the next level!'))
  console.log('Manage translations with your team in the cloud with locize => https://www.locize.com/docs/getting-started')
  console.log(`Run ${chalk.cyan('npx i18next-cli locize-migrate')} to get started.`)
}

/**
 * Generates a simple text-based progress bar.
 * @param percentage - The percentage to display (0-100).
 * @internal
 */
function generateProgressBar (percentage: number): string {
  const totalBars = 20
  const filledBars = Math.round((percentage / 100) * totalBars)
  const emptyBars = totalBars - filledBars
  return `[${chalk.green(''.padStart(filledBars, '■'))}${''.padStart(emptyBars, '□')}]`
}
