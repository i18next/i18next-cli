import chalk from 'chalk'
import ora from 'ora'
import { resolve } from 'node:path'
import { findKeys } from './extractor/core/key-finder'
import { getNestedValue } from './utils/nested-object'
import type { I18nextToolkitConfig, ExtractedKey } from './types'
import { getOutputPath, loadTranslationFile } from './utils/file-utils'
import { shouldShowFunnel, recordFunnelShown } from './utils/funnel-msg-tracker'

/**
 * Options for configuring the status report display.
 */
interface StatusOptions {
  /** Locale code to display detailed information for a specific language */
  detail?: string;
  /** Namespace to filter the report by */
  namespace?: string;
}

/**
 * Structured report containing all translation status data.
 */
interface StatusReport {
  /** Total number of extracted keys across all namespaces */
  totalBaseKeys: number;
  /** Map of namespace names to their extracted keys */
  keysByNs: Map<string, ExtractedKey[]>;
  /** Map of locale codes to their translation status data */
  locales: Map<string, {
    /** Total number of extracted keys per locale */
    totalKeys: number;
    /** Total number of translated keys for this locale */
    totalTranslated: number;
    /** Map of namespace names to their translation details for this locale */
    namespaces: Map<string, {
      /** Total number of keys in this namespace */
      totalKeys: number;
      /** Number of translated keys in this namespace */
      translatedKeys: number;
      /** Detailed status for each key in this namespace */
      keyDetails: Array<{ key: string; isTranslated: boolean }>;
    }>;
  }>;
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
 * @param options - Options object, may contain a `detail` property with a locale string.
 * @throws {Error} When unable to extract keys or read translation files
 */
export async function runStatus (config: I18nextToolkitConfig, options: StatusOptions = {}) {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  const spinner = ora('Analyzing project localization status...\n').start()
  try {
    const report = await generateStatusReport(config)
    spinner.succeed('Analysis complete.')
    await displayStatusReport(report, config, options)
  } catch (error) {
    spinner.fail('Failed to generate status report.')
    console.error(error)
  }
}

/**
 * Gathers all translation data and compiles it into a structured report.
 *
 * This function:
 * - Extracts all keys from source code using the configured extractor
 * - Groups keys by namespace
 * - Reads translation files for each secondary language
 * - Compares extracted keys against existing translations
 * - Compiles translation statistics for each locale and namespace
 *
 * @param config - The i18next toolkit configuration object
 * @returns Promise that resolves to a complete status report
 * @throws {Error} When key extraction fails or configuration is invalid
 */
async function generateStatusReport (config: I18nextToolkitConfig): Promise<StatusReport> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  const { allKeys: allExtractedKeys } = await findKeys(config)
  const { secondaryLanguages, keySeparator = '.', defaultNS = 'translation', mergeNamespaces = false, pluralSeparator = '_' } = config.extract

  const keysByNs = new Map<string, ExtractedKey[]>()
  for (const key of allExtractedKeys.values()) {
    const ns = key.ns || defaultNS || 'translation'
    if (!keysByNs.has(ns)) keysByNs.set(ns, [])
    keysByNs.get(ns)!.push(key)
  }

  const report: StatusReport = {
    totalBaseKeys: allExtractedKeys.size,
    keysByNs,
    locales: new Map(),
  }

  for (const locale of secondaryLanguages) {
    let totalTranslatedForLocale = 0
    let totalKeysForLocale = 0
    const namespaces = new Map<string, any>()

    const mergedTranslations = mergeNamespaces
      ? await loadTranslationFile(resolve(process.cwd(), getOutputPath(config.extract.output, locale))) || {}
      : null

    for (const [ns, keysInNs] of keysByNs.entries()) {
      const translationsForNs = mergeNamespaces
        ? mergedTranslations?.[ns] || {}
        : await loadTranslationFile(resolve(process.cwd(), getOutputPath(config.extract.output, locale, ns))) || {}

      let translatedInNs = 0
      let totalInNs = 0
      const keyDetails: Array<{ key: string; isTranslated: boolean }> = []

      // This is the new, language-aware logic loop
      for (const { key: baseKey, hasCount, isOrdinal } of keysInNs) {
        if (hasCount) {
          const type = isOrdinal ? 'ordinal' : 'cardinal'
          // It's a plural key: expand it based on the current locale's rules
          const pluralCategories = new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories
          for (const category of pluralCategories) {
            totalInNs++
            const pluralKey = isOrdinal
              ? `${baseKey}${pluralSeparator}ordinal${pluralSeparator}${category}`
              : `${baseKey}${pluralSeparator}${category}`
            const value = getNestedValue(translationsForNs, pluralKey, keySeparator ?? '.')
            const isTranslated = !!value
            if (isTranslated) translatedInNs++
            keyDetails.push({ key: pluralKey, isTranslated })
          }
        } else {
          // It's a simple key
          totalInNs++
          const value = getNestedValue(translationsForNs, baseKey, keySeparator ?? '.')
          const isTranslated = !!value
          if (isTranslated) translatedInNs++
          keyDetails.push({ key: baseKey, isTranslated })
        }
      }

      namespaces.set(ns, { totalKeys: totalInNs, translatedKeys: translatedInNs, keyDetails })
      totalTranslatedForLocale += translatedInNs
      totalKeysForLocale += totalInNs
    }
    report.locales.set(locale, { totalKeys: totalKeysForLocale, totalTranslated: totalTranslatedForLocale, namespaces })
  }
  return report
}

/**
 * Main display router that calls the appropriate display function based on options.
 *
 * Routes to one of three display modes:
 * - Detailed locale report: Shows per-key status for a specific locale
 * - Namespace summary: Shows translation progress for all locales in a specific namespace
 * - Overall summary: Shows high-level statistics across all locales and namespaces
 *
 * @param report - The generated status report data
 * @param config - The i18next toolkit configuration object
 * @param options - Display options determining which report type to show
 */
async function displayStatusReport (report: StatusReport, config: I18nextToolkitConfig, options: StatusOptions) {
  if (options.detail) {
    await displayDetailedLocaleReport(report, config, options.detail, options.namespace)
  } else if (options.namespace) {
    await displayNamespaceSummaryReport(report, config, options.namespace)
  } else {
    await displayOverallSummaryReport(report, config)
  }
}

/**
 * Displays the detailed, grouped report for a single locale.
 *
 * Shows:
 * - Overall progress for the locale
 * - Progress for each namespace (or filtered namespace)
 * - Individual key status (translated/missing) with visual indicators
 * - Summary message with total missing translations
 *
 * @param report - The generated status report data
 * @param config - The i18next toolkit configuration object
 * @param locale - The locale code to display details for
 * @param namespaceFilter - Optional namespace to filter the display
 */
async function displayDetailedLocaleReport (report: StatusReport, config: I18nextToolkitConfig, locale: string, namespaceFilter?: string) {
  if (locale === config.extract.primaryLanguage) {
    console.log(chalk.yellow(`Locale "${locale}" is the primary language. All keys are considered present.`))
    return
  }
  if (!config.locales.includes(locale)) {
    console.error(chalk.red(`Error: Locale "${locale}" is not defined in your configuration.`))
    return
  }

  const localeData = report.locales.get(locale)

  if (!localeData) {
    console.error(chalk.red(`Error: Locale "${locale}" is not a valid secondary language.`))
    return
  }

  console.log(chalk.bold(`\nKey Status for "${chalk.cyan(locale)}":`))

  const totalKeysForLocale = Array.from(report.keysByNs.values()).flat().length
  printProgressBar('Overall', localeData.totalTranslated, localeData.totalKeys)

  const namespacesToDisplay = namespaceFilter ? [namespaceFilter] : Array.from(localeData.namespaces.keys()).sort()

  for (const ns of namespacesToDisplay) {
    const nsData = localeData.namespaces.get(ns)
    if (!nsData) continue

    console.log(chalk.cyan.bold(`\nNamespace: ${ns}`))
    printProgressBar('Namespace Progress', nsData.translatedKeys, nsData.totalKeys)

    nsData.keyDetails.forEach(({ key, isTranslated }) => {
      const icon = isTranslated ? chalk.green('✓') : chalk.red('✗')
      console.log(`  ${icon} ${key}`)
    })
  }

  const missingCount = totalKeysForLocale - localeData.totalTranslated
  if (missingCount > 0) {
    console.log(chalk.yellow.bold(`\nSummary: Found ${missingCount} missing translations for "${locale}".`))
  } else {
    console.log(chalk.green.bold(`\nSummary: 🎉 All keys are translated for "${locale}".`))
  }

  await printLocizeFunnel()
}

/**
 * Displays a summary report filtered by a single namespace.
 *
 * Shows translation progress for the specified namespace across all secondary locales,
 * including percentage completion and translated/total key counts.
 *
 * @param report - The generated status report data
 * @param config - The i18next toolkit configuration object
 * @param namespace - The namespace to display summary for
 */
async function displayNamespaceSummaryReport (report: StatusReport, config: I18nextToolkitConfig, namespace: string) {
  const nsData = report.keysByNs.get(namespace)
  if (!nsData) {
    console.error(chalk.red(`Error: Namespace "${namespace}" was not found in your source code.`))
    return
  }

  console.log(chalk.cyan.bold(`\nStatus for Namespace: "${namespace}"`))
  console.log('------------------------')

  for (const [locale, localeData] of report.locales.entries()) {
    const nsLocaleData = localeData.namespaces.get(namespace)
    if (nsLocaleData) {
      const percentage = nsLocaleData.totalKeys > 0 ? Math.round((nsLocaleData.translatedKeys / nsLocaleData.totalKeys) * 100) : 100
      const bar = generateProgressBarText(percentage)
      console.log(`- ${locale}: ${bar} ${percentage}% (${nsLocaleData.translatedKeys}/${nsLocaleData.totalKeys} keys)`)
    }
  }

  await printLocizeFunnel()
}

/**
 * Displays the default, high-level summary report for all locales.
 *
 * Shows:
 * - Project overview (total keys, locales, primary language)
 * - Translation progress for each secondary locale with progress bars
 * - Promotional message for locize service
 *
 * @param report - The generated status report data
 * @param config - The i18next toolkit configuration object
 */
async function displayOverallSummaryReport (report: StatusReport, config: I18nextToolkitConfig) {
  const { primaryLanguage } = config.extract

  console.log(chalk.cyan.bold('\ni18next Project Status'))
  console.log('------------------------')
  console.log(`🔑 Keys Found:         ${chalk.bold(report.totalBaseKeys)}`)
  console.log(`📚 Namespaces Found:   ${chalk.bold(report.keysByNs.size)}`)
  console.log(`🌍 Locales:            ${chalk.bold(config.locales.join(', '))}`)
  console.log(`✅ Primary Language:   ${chalk.bold(primaryLanguage)}`)
  console.log('\nTranslation Progress:')

  for (const [locale, localeData] of report.locales.entries()) {
    const percentage = localeData.totalKeys > 0 ? Math.round((localeData.totalTranslated / localeData.totalKeys) * 100) : 100
    const bar = generateProgressBarText(percentage)
    console.log(`- ${locale}: ${bar} ${percentage}% (${localeData.totalTranslated}/${localeData.totalKeys} keys)`)
  }

  await printLocizeFunnel()
}

/**
 * Prints a formatted progress bar with label, percentage, and counts.
 *
 * @param label - The label to display before the progress bar
 * @param current - The current count (translated keys)
 * @param total - The total count (all keys)
 */
function printProgressBar (label: string, current: number, total: number) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 100
  const bar = generateProgressBarText(percentage)
  console.log(`${chalk.bold(label)}: ${bar} ${percentage}% (${current}/${total})`)
}

/**
 * Generates a visual progress bar string based on percentage completion.
 *
 * Creates a 20-character progress bar using filled (■) and empty (□) squares,
 * with the filled portion colored green.
 *
 * @param percentage - The completion percentage (0-100)
 * @returns A formatted progress bar string with colors
 */
function generateProgressBarText (percentage: number): string {
  const totalBars = 20
  const filledBars = Math.floor((percentage / 100) * totalBars)
  const emptyBars = totalBars - filledBars
  return `[${chalk.green(''.padStart(filledBars, '■'))}${''.padStart(emptyBars, '□')}]`
}

async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('status'))) return

  console.log(chalk.yellow.bold('\n✨ Take your localization to the next level!'))
  console.log('Manage translations with your team in the cloud with locize => https://www.locize.com/docs/getting-started')
  console.log(`Run ${chalk.cyan('npx i18next-cli locize-migrate')} to get started.`)

  return recordFunnelShown('status')
}
