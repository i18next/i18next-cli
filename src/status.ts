import { styleText } from 'node:util'
import ora from 'ora'
import { resolve } from 'node:path'
import { findKeys } from './extractor.js'
import { getNestedValue } from './utils/nested-object.js'
import type { I18nextToolkitConfig, ExtractedKey } from './types.js'
import { getOutputPath, loadTranslationFile } from './utils/file-utils.js'
import { safePluralRules } from './utils/plural-rules.js'
import { shouldShowFunnel, recordFunnelShown } from './utils/funnel-msg-tracker.js'

/**
 * Options for configuring the status report display.
 */
interface StatusOptions {
  /** Locale code to display detailed information for a specific language */
  detail?: string;
  /** Namespace to filter the report by */
  namespace?: string;
  /** When true, only untranslated keys are shown in the detailed view */
  hideTranslated?: boolean;
}

/**
 * Three-state classification for a translation value.
 *
 * - `translated`: key exists in the file and has a non-empty value
 * - `empty`:      key exists in the file but the value is an empty string
 *                 (written by `extract` as a placeholder — needs a translator)
 * - `absent`:     key is not present in the file at all
 *                 (structural problem — `extract` or `sync` may not have run)
 */
type TranslationState = 'translated' | 'empty' | 'absent'

function classifyValue (value: any): TranslationState {
  if (value === undefined || value === null) return 'absent'
  if (value === '') return 'empty'
  return 'translated'
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
    /** Total number of translated (non-empty) keys for this locale */
    totalTranslated: number;
    /** Keys present in the file but with an empty-string value */
    totalEmpty: number;
    /** Keys entirely absent from the translation file */
    totalAbsent: number;
    /** Map of namespace names to their translation details for this locale */
    namespaces: Map<string, {
      /** Total number of keys in this namespace */
      totalKeys: number;
      /** Number of translated keys in this namespace */
      translatedKeys: number;
      /** Keys present but empty in this namespace */
      emptyKeys: number;
      /** Keys absent from the file in this namespace */
      absentKeys: number;
      /** Detailed status for each key in this namespace */
      keyDetails: Array<{ key: string; state: TranslationState }>;
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
 * Exit behaviour (unchanged): exits 1 when any key is either empty or absent.
 * The output now distinguishes between the two states so developers can tell
 * whether they have a structural problem (absent) or simply pending translation
 * work (empty).
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
    let hasMissing = false
    for (const [, localeData] of report.locales.entries()) {
      if (localeData.totalTranslated < localeData.totalKeys) {
        hasMissing = true
        break
      }
    }
    if (hasMissing) {
      spinner.fail('Error: Incomplete translations detected.')
      process.exit(1)
    }
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
  const { secondaryLanguages, keySeparator = '.', defaultNS = 'translation', mergeNamespaces = false, pluralSeparator = '_', fallbackNS } = config.extract

  const keysByNs = new Map<string, ExtractedKey[]>()
  for (const key of allExtractedKeys.values()) {
    const ns = key.ns || defaultNS || 'translation'
    if (!keysByNs.has(ns)) keysByNs.set(ns, [])
    keysByNs.get(ns)!.push(key)
  }

  // Filter out ignored namespaces
  const ignoreNamespaces = new Set(config.extract.ignoreNamespaces ?? [])
  for (const ns of ignoreNamespaces) {
    keysByNs.delete(ns)
  }

  // Count total keys after filtering
  let filteredKeyCount = 0
  for (const keys of keysByNs.values()) {
    filteredKeyCount += keys.length
  }

  const report: StatusReport = {
    totalBaseKeys: filteredKeyCount,
    keysByNs,
    locales: new Map(),
  }

  for (const locale of secondaryLanguages) {
    let totalTranslatedForLocale = 0
    let totalEmptyForLocale = 0
    let totalAbsentForLocale = 0
    let totalKeysForLocale = 0
    const namespaces = new Map<string, any>()

    const mergedTranslations = mergeNamespaces
      // When merging namespaces we need to load the combined translation file.
      // The combined file lives under the regular output pattern and must include a namespace.
      // If defaultNS is explicitly false, fall back to the conventional "translation" file name.
      ? await loadTranslationFile(
        resolve(
          process.cwd(),
          getOutputPath(
            config.extract.output,
            locale,
            (defaultNS === false ? 'translation' : (defaultNS || 'translation'))
          )
        )
      ) || {}
      : null

    for (const [ns, keysInNs] of keysByNs.entries()) {
      const translationsForNs = mergeNamespaces
        // If mergedTranslations is a flat object (no nested namespace) prefer the root object
        // when mergedTranslations[ns] is missing.
        ? (mergedTranslations?.[ns] ?? mergedTranslations ?? {})
        : await loadTranslationFile(resolve(process.cwd(), getOutputPath(config.extract.output, locale, ns))) || {}

      // Load fallbackNS translations if configured
      let fallbackTranslations: any
      if (fallbackNS && ns !== fallbackNS) {
        if (mergeNamespaces) {
          // In merged mode, fallbackNS keys are in mergedTranslations under fallbackNS
          fallbackTranslations = mergedTranslations?.[fallbackNS] ?? mergedTranslations ?? {}
        } else {
          fallbackTranslations = await loadTranslationFile(
            resolve(process.cwd(), getOutputPath(config.extract.output, locale, fallbackNS))
          ) || {}
        }
      }

      let translatedInNs = 0
      let emptyInNs = 0
      let absentInNs = 0
      let totalInNs = 0
      const keyDetails: Array<{ key: string; state: TranslationState }> = []

      // Get the plural categories for THIS specific locale
      const getLocalePluralCategories = (locale: string, isOrdinal: boolean): string[] => {
        try {
          const type = isOrdinal ? 'ordinal' : 'cardinal'
          const pluralRules = safePluralRules(locale, { type })
          return pluralRules.resolvedOptions().pluralCategories
        } catch (e) {
          // Fallback to English if locale is invalid
          const fallbackRules = safePluralRules('en', { type: isOrdinal ? 'ordinal' : 'cardinal' })
          return fallbackRules.resolvedOptions().pluralCategories
        }
      }

      /**
       * Resolves the value for a single key, applying the fallback namespace when
       * configured, and classifies it as translated / empty / absent.
       *
       * The fallback is only consulted when the primary value is absent — an empty
       * string is a deliberate placeholder written by `extract` and should not be
       * silently replaced by a fallback value.
       */
      const resolveAndClassify = (key: string): TranslationState => {
        const sep = keySeparator ?? '.'
        const primaryValue = getNestedValue(translationsForNs, key, sep)
        const primaryState = classifyValue(primaryValue)

        // Only fall back when the key is genuinely absent from the primary file.
        // An empty string is intentional (placeholder from extract) — don't hide it.
        if (primaryState === 'absent' && fallbackTranslations) {
          const fallbackValue = getNestedValue(fallbackTranslations, key, sep)
          return classifyValue(fallbackValue)
        }

        return primaryState
      }

      for (const { key: baseKey, hasCount, isOrdinal, isExpandedPlural } of keysInNs) {
        if (hasCount) {
          if (isExpandedPlural) {
            // This is an already-expanded plural variant key (e.g., key_one, key_other)
            // Check if this specific variant is needed for the target locale
            const keyParts = baseKey.split(pluralSeparator)
            const lastPart = keyParts[keyParts.length - 1]

            // Determine if this is an ordinal or cardinal plural
            const isOrdinalVariant = keyParts.length >= 2 && keyParts[keyParts.length - 2] === 'ordinal'
            const category = isOrdinalVariant ? keyParts[keyParts.length - 1] : lastPart

            // Get the plural categories for this locale
            const localePluralCategories = getLocalePluralCategories(locale, isOrdinalVariant)

            // Only count this key if it's a plural form used by this locale
            if (localePluralCategories.includes(category)) {
              totalInNs++
              const state = resolveAndClassify(baseKey)
              if (state === 'translated') translatedInNs++
              else if (state === 'empty') emptyInNs++
              else absentInNs++
              keyDetails.push({ key: baseKey, state })
            }
          } else {
            // This is a base plural key without expanded variants
            // Expand it according to THIS locale's plural rules
            const localePluralCategories = getLocalePluralCategories(locale, isOrdinal || false)

            for (const category of localePluralCategories) {
              totalInNs++
              const pluralKey = isOrdinal
                ? `${baseKey}${pluralSeparator}ordinal${pluralSeparator}${category}`
                : `${baseKey}${pluralSeparator}${category}`
              const state = resolveAndClassify(pluralKey)
              if (state === 'translated') translatedInNs++
              else if (state === 'empty') emptyInNs++
              else absentInNs++
              keyDetails.push({ key: pluralKey, state })
            }
          }
        } else {
          totalInNs++
          const state = resolveAndClassify(baseKey)
          if (state === 'translated') translatedInNs++
          else if (state === 'empty') emptyInNs++
          else absentInNs++
          keyDetails.push({ key: baseKey, state })
        }
      }

      namespaces.set(ns, { totalKeys: totalInNs, translatedKeys: translatedInNs, emptyKeys: emptyInNs, absentKeys: absentInNs, keyDetails })
      totalTranslatedForLocale += translatedInNs
      totalEmptyForLocale += emptyInNs
      totalAbsentForLocale += absentInNs
      totalKeysForLocale += totalInNs
    }
    report.locales.set(locale, {
      totalKeys: totalKeysForLocale,
      totalTranslated: totalTranslatedForLocale,
      totalEmpty: totalEmptyForLocale,
      totalAbsent: totalAbsentForLocale,
      namespaces,
    })
  }
  return report
}

/**
 * Builds a compact breakdown string like "3 untranslated, 2 absent" for use in
 * summary lines. Returns an empty string when there is nothing to report.
 */
function buildBreakdown (emptyCount: number, absentCount: number): string {
  const parts: string[] = []
  if (emptyCount > 0) parts.push(styleText('yellow', `${emptyCount} untranslated`))
  if (absentCount > 0) parts.push(styleText('red', `${absentCount} absent`))
  return parts.join(', ')
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
    await displayDetailedLocaleReport(report, config, options.detail, options.namespace, options.hideTranslated)
  } else if (options.namespace) {
    await displayNamespaceSummaryReport(report, config, options.namespace)
  } else {
    await displayOverallSummaryReport(report, config)
  }
}

/**
 * Displays the detailed, grouped report for a single locale.
 *
 * Key status icons:
 *   ✓  green  — translated
 *   ~  yellow — present in file but empty (needs translation)
 *   ✗  red    — absent from file entirely (structural problem)
 */
async function displayDetailedLocaleReport (report: StatusReport, config: I18nextToolkitConfig, locale: string, namespaceFilter?: string, hideTranslated?: boolean) {
  if (locale === config.extract.primaryLanguage) {
    console.log(styleText('yellow', `Locale "${locale}" is the primary language. All keys are considered present.`))
    return
  }
  if (!config.locales.includes(locale)) {
    console.error(styleText('red', `Error: Locale "${locale}" is not defined in your configuration.`))
    return
  }

  const localeData = report.locales.get(locale)

  if (!localeData) {
    console.error(styleText('red', `Error: Locale "${locale}" is not a valid secondary language.`))
    return
  }

  console.log(styleText('bold', `\nKey Status for "${styleText('cyan', locale)}":`))

  const totalKeysForLocale = localeData.totalKeys
  printProgressBar('Overall', localeData.totalTranslated, totalKeysForLocale)

  const breakdown = buildBreakdown(localeData.totalEmpty, localeData.totalAbsent)
  if (breakdown) console.log(`         ${breakdown}`)

  const namespacesToDisplay = namespaceFilter ? [namespaceFilter] : Array.from(localeData.namespaces.keys()).sort()

  for (const ns of namespacesToDisplay) {
    const nsData = localeData.namespaces.get(ns)
    if (!nsData) continue

    console.log(styleText(['cyan', 'bold'], `\nNamespace: ${ns}`))
    printProgressBar('Namespace Progress', nsData.translatedKeys, nsData.totalKeys)

    const nsBreakdown = buildBreakdown(nsData.emptyKeys, nsData.absentKeys)
    if (nsBreakdown) console.log(`                   ${nsBreakdown}`)

    const keysToDisplay = hideTranslated
      ? nsData.keyDetails.filter(({ state }) => state !== 'translated')
      : nsData.keyDetails

    keysToDisplay.forEach(({ key, state }) => {
      if (state === 'translated') {
        console.log(`  ${styleText('green', '✓')} ${key}`)
      } else if (state === 'empty') {
        console.log(`  ${styleText('yellow', '~')} ${key}  ${styleText('yellow', '(untranslated)')}`)
      } else {
        console.log(`  ${styleText('red', '✗')} ${key}  ${styleText('red', '(absent)')}`)
      }
    })
  }

  const missingCount = totalKeysForLocale - localeData.totalTranslated
  if (missingCount > 0) {
    const summaryBreakdown = buildBreakdown(localeData.totalEmpty, localeData.totalAbsent)
    console.log(styleText(['yellow', 'bold'], `\nSummary: Found ${missingCount} incomplete translations for "${locale}" — ${summaryBreakdown}.`))
  } else {
    console.log(styleText(['green', 'bold'], `\nSummary: 🎉 All keys are translated for "${locale}".`))
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
    console.error(styleText('red', `Error: Namespace "${namespace}" was not found in your source code.`))
    return
  }

  console.log(styleText(['cyan', 'bold'], `\nStatus for Namespace: "${namespace}"`))
  console.log('------------------------')

  for (const [locale, localeData] of report.locales.entries()) {
    const nsLocaleData = localeData.namespaces.get(namespace)
    if (nsLocaleData) {
      const percentage = nsLocaleData.totalKeys > 0 ? Math.round((nsLocaleData.translatedKeys / nsLocaleData.totalKeys) * 100) : 100
      const bar = generateProgressBarText(percentage)
      const breakdown = buildBreakdown(nsLocaleData.emptyKeys, nsLocaleData.absentKeys)
      const suffix = breakdown ? `  — ${breakdown}` : ''
      console.log(`- ${locale}: ${bar} ${percentage}% (${nsLocaleData.translatedKeys}/${nsLocaleData.totalKeys} keys)${suffix}`)
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

  console.log(styleText(['cyan', 'bold'], '\ni18next Project Status'))
  console.log('------------------------')
  console.log(`🔑 Keys Found:         ${styleText('bold', `${report.totalBaseKeys}`)}`)
  console.log(`📚 Namespaces Found:   ${styleText('bold', `${report.keysByNs.size}`)}`)
  console.log(`🌍 Locales:            ${styleText('bold', config.locales.join(', '))}`)
  if (primaryLanguage) console.log(`✅ Primary Language:   ${styleText('bold', primaryLanguage)}`)
  console.log('\nTranslation Progress:')

  for (const [locale, localeData] of report.locales.entries()) {
    const percentage = localeData.totalKeys > 0 ? Math.round((localeData.totalTranslated / localeData.totalKeys) * 100) : 100
    const bar = generateProgressBarText(percentage)
    const breakdown = buildBreakdown(localeData.totalEmpty, localeData.totalAbsent)
    const suffix = breakdown ? `  — ${breakdown}` : ''
    console.log(`- ${locale}: ${bar} ${percentage}% (${localeData.totalTranslated}/${localeData.totalKeys} keys)${suffix}`)
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
  console.log(`${styleText('bold', label)}: ${bar} ${percentage}% (${current}/${total})`)
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
  return `[${styleText('green', ''.padStart(filledBars, '■'))}${''.padStart(emptyBars, '□')}]`
}

async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('status'))) return

  console.log(styleText(['yellow', 'bold'], '\n✨ Take your localization to the next level!'))
  console.log('Manage translations with your team in the cloud with Locize => https://www.locize.com/docs/getting-started')
  console.log(`Run ${styleText('cyan', 'npx i18next-cli locize-migrate')} to get started.`)

  return recordFunnelShown('status')
}
