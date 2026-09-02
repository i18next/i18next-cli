import { styleText } from 'node:util'
import ora from 'ora'
import { resolve } from 'node:path'
import { findKeys, runExtractor } from './extractor.js'
import { getNestedValue, getNestedKeys } from './utils/nested-object.js'
import type { I18nextToolkitConfig, ExtractedKey, TranslationResult } from './types.js'
import { getOutputPath, loadTranslationFile } from './utils/file-utils.js'
import { safePluralRules } from './utils/plural-rules.js'
import { isContextVariantOfAcceptingKey } from './utils/context-variants.js'
import { parseNestedReferences } from './utils/nesting.js'
import { shouldShowFunnel, recordFunnelShown } from './utils/funnel-msg-tracker.js'
import { printUntranslatedFunnel } from './utils/locize-funnel.js'

const LOCIZE_SIGNUP_URL = 'https://www.locize.app/register?from=i18next_cli__status'

function globToRegex (glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

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
type TranslationState = 'translated' | 'empty' | 'absent' | 'optional'

function classifyValue (value: any): TranslationState {
  if (value === undefined || value === null) return 'absent'
  if (value === '') return 'empty'
  return 'translated'
}

/**
 * Representative counts used to decide which CLDR plural categories a locale can
 * actually reach in normal usage: small integers (the common case), a handful
 * of larger integers, and common decimals (so categories that only fire for
 * fractional display values — e.g. Polish/Russian `other` — stay required).
 *
 * Any category NOT produced by these counts is treated as "optional". The prime
 * example is French `many`, which `Intl.PluralRules` only selects for values
 * ≥ 1,000,000 — the i18next runtime can technically request it, but real apps
 * almost never hit those values (and the runtime falls back to the base key
 * when the variant is missing), so a missing `_many` should be a soft note
 * rather than a hard "missing key" failure.
 */
const REPRESENTATIVE_COUNTS: number[] = (() => {
  const counts: number[] = []
  for (let n = 0; n <= 20; n++) counts.push(n)
  counts.push(100, 101, 1000, 1001, 10000)
  counts.push(0.5, 1.1, 1.5, 2.5, 3.5)
  return counts
})()

const optionalCategoriesCache = new Map<string, Set<string>>()

/**
 * Returns the CLDR plural categories for a locale that are NOT reachable by any
 * representative count (see {@link REPRESENTATIVE_COUNTS}). These are reported
 * by `status` as optional: a missing variant is a soft note instead of a hard
 * absence, mirroring how the i18next runtime resolves such forms.
 */
function getOptionalPluralCategories (locale: string, isOrdinal: boolean): Set<string> {
  const type = isOrdinal ? 'ordinal' : 'cardinal'
  const cacheKey = `${locale}|${type}`
  const cached = optionalCategoriesCache.get(cacheKey)
  if (cached) return cached

  let optional: Set<string>
  try {
    const rules = safePluralRules(locale, { type })
    const all = rules.resolvedOptions().pluralCategories
    const reachable = new Set(REPRESENTATIVE_COUNTS.map(n => rules.select(n)))
    optional = new Set(all.filter(c => !reachable.has(c)))
  } catch {
    optional = new Set()
  }
  optionalCategoriesCache.set(cacheKey, optional)
  return optional
}

/**
 * Translation status data for a single locale.
 */
interface LocaleStatus {
  /** Total number of extracted keys per locale */
  totalKeys: number;
  /** Total number of translated (non-empty) keys for this locale */
  totalTranslated: number;
  /** Keys present in the file but with an empty-string value */
  totalEmpty: number;
  /** Keys entirely absent from the translation file */
  totalAbsent: number;
  /**
   * Optional plural variants missing from the file (e.g. French `_many`).
   * These are reported for visibility but excluded from totals so they never
   * affect completion percentages or the command's pass/fail result.
   */
  totalOptional: number;
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
    /** Optional plural variants missing from the file in this namespace */
    optionalKeys: number;
    /** Detailed status for each key in this namespace */
    keyDetails: Array<{ key: string; state: TranslationState }>;
  }>;
}

/**
 * Structured report containing all translation status data.
 */
interface StatusReport {
  /** Total number of extracted keys across all namespaces */
  totalBaseKeys: number;
  /** Map of namespace names to their extracted keys */
  keysByNs: Map<string, ExtractedKey[]>;
  /**
   * Status of the primary language itself. Unlike secondary languages, an
   * empty-string value here is treated as present (it is a deliberate
   * placeholder written by `extract`); only genuinely absent keys — used in
   * code but missing from the primary translation file — are flagged.
   */
  primary?: LocaleStatus;
  /** Map of secondary locale codes to their translation status data */
  locales: Map<string, LocaleStatus>;
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

    // When a specific locale is requested (`status <locale>`), the pass/fail
    // result must reflect THAT locale only — otherwise the displayed summary
    // (which is scoped to the requested locale) can contradict the exit code
    // by failing on an unrelated secondary language. See issue #271.
    const scopedLocale = options.detail && config.locales.includes(options.detail)
      ? options.detail
      : undefined

    let hasMissing = false
    if (scopedLocale) {
      if (scopedLocale === config.extract.primaryLanguage) {
        // The primary language fails only on absent keys (used in code but
        // missing from the file); empty placeholders are deliberate.
        hasMissing = !!report.primary && report.primary.totalAbsent > 0
      } else {
        const localeData = report.locales.get(scopedLocale)
        hasMissing = !!localeData && localeData.totalTranslated < localeData.totalKeys
      }
    } else {
      for (const [, localeData] of report.locales.entries()) {
        if (localeData.totalTranslated < localeData.totalKeys) {
          hasMissing = true
          break
        }
      }
      // The primary language fails the check only on absent keys (used in code but
      // missing from the translation file); empty placeholders are tolerated.
      if (!hasMissing && report.primary && report.primary.totalAbsent > 0) {
        hasMissing = true
      }
    }
    if (hasMissing) {
      // Name the locale when the check is scoped so the failure reason is clear
      // (the displayed summary already explains what is missing for it).
      spinner.fail(scopedLocale
        ? `Error: Incomplete translations detected for "${scopedLocale}".`
        : 'Error: Incomplete translations detected.')
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
  const { secondaryLanguages, keySeparator = '.', defaultNS = 'translation', mergeNamespaces = false, pluralSeparator = '_', contextSeparator = '_', fallbackNS } = config.extract
  const primaryLanguage = config.extract.primaryLanguage || config.locales[0] || 'en'
  // Normalize fallbackNS like the i18next runtime: string | string[] -> string[]
  const fallbackNamespaces = !fallbackNS
    ? []
    : (Array.isArray(fallbackNS) ? fallbackNS : [fallbackNS]).filter((ns): ns is string => typeof ns === 'string' && ns.length > 0)

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

  // Filter out ignored keys (`status.ignoreKeys`, glob, optional `ns:` prefix)
  const nsSep: string | false = config.extract.nsSeparator ?? ':'
  const ignoreKeyMatchers = (config.status?.ignoreKeys ?? []).map((pattern) => {
    const sepAt = nsSep ? pattern.indexOf(nsSep) : -1
    const ns = sepAt > 0 ? pattern.slice(0, sepAt) : undefined
    const re = globToRegex(sepAt > 0 && nsSep ? pattern.slice(sepAt + nsSep.length) : pattern)
    return (k: ExtractedKey, keyNs: string) => (ns === undefined || ns === keyNs) && re.test(k.key)
  })
  if (ignoreKeyMatchers.length > 0) {
    for (const [ns, keys] of keysByNs) {
      const kept = keys.filter(k => !ignoreKeyMatchers.some(m => m(k, ns)))
      if (kept.length === 0) keysByNs.delete(ns)
      else keysByNs.set(ns, kept)
    }
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

  // Build per-namespace "virtual" key lists for translation entries that the
  // AST-based extractor cannot see on its own. Both inputs come from the
  // primary translation file:
  //
  //  1. Context variants of an accepting-context key (see issue #243).
  //     `t('exportType', { context: dynamic })` only registers the base key;
  //     the concrete `exportType_gas` / `exportType_water` variants live in
  //     the primary file.
  //
  //  2. Keys reachable only via `$t(...)` nested references from inside an
  //     existing translation value (see follow-up to issue #241).
  //     `"girlsAndBoys": "... $t(boys, {\"count\": x}) ..."` doesn't appear
  //     in source code, yet the referenced keys (`boys`, plus per-locale
  //     plural forms) must be checked in every secondary locale.
  //
  // Both scans need the primary translation file per namespace, so the load
  // is shared.
  const keysAcceptingContext = new Set<string>()
  for (const keys of keysByNs.values()) {
    for (const k of keys) {
      if (k.keyAcceptingContext) keysAcceptingContext.add(k.keyAcceptingContext)
    }
  }

  const contextVariantsByNs = new Map<string, string[]>()
  const nestedReferenceKeysByNs = new Map<string, ExtractedKey[]>()

  // Absolute path of the merged translation file for a locale. A function
  // `output` is called WITHOUT a namespace — the same way `extract` resolves
  // the merged file it writes — so hybrid layouts (one merged file plus a few
  // split-out namespace files) resolve correctly (#287). String templates keep
  // the historical defaultNS substitution for the {{namespace}} placeholder.
  const getMergedPath = (locale: string): string => resolve(
    process.cwd(),
    typeof config.extract.output === 'function'
      ? getOutputPath(config.extract.output, locale)
      : getOutputPath(
        config.extract.output,
        locale,
        (defaultNS === false ? 'translation' : (defaultNS || 'translation'))
      )
  )

  const primaryMergedForScan = mergeNamespaces
    ? ((await loadTranslationFile(getMergedPath(primaryLanguage))) || {})
    : null

  const collectNestedRefsFromValue = (value: unknown, refNs: string, bucket: ExtractedKey[], seen: Set<string>): void => {
    if (typeof value === 'string') {
      if (seen.has(value)) return
      seen.add(value)
      const refs = parseNestedReferences(value, {
        nestingPrefix: config.extract.nestingPrefix,
        nestingSuffix: config.extract.nestingSuffix,
        nestingOptionsSeparator: config.extract.nestingOptionsSeparator,
        nsSeparator: config.extract.nsSeparator,
        defaultNS: config.extract.defaultNS
      })
      for (const ref of refs) {
        // References with an explicit namespace that differs from the current
        // bucket are ignored — they belong to another namespace's scan.
        const normalizedRefNs = ref.ns === undefined || ref.ns === null
          ? (config.extract.defaultNS ?? 'translation')
          : ref.ns
        if (normalizedRefNs !== refNs) continue

        if (ref.context !== undefined) {
          const ctxKey = `${ref.key}${contextSeparator}${ref.context}`
          if (ref.hasCount) {
            // Treat `key_ctx` as a base plural key; the per-locale loop
            // expands it into the correct CLDR forms for each target locale.
            bucket.push({ key: ctxKey, hasCount: true })
          } else {
            bucket.push({ key: ref.key })
            bucket.push({ key: ctxKey })
          }
        } else if (ref.hasCount) {
          bucket.push({ key: ref.key, hasCount: true })
        } else {
          bucket.push({ key: ref.key })
        }
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const v of Object.values(value as Record<string, unknown>)) {
        collectNestedRefsFromValue(v, refNs, bucket, seen)
      }
    }
  }

  for (const ns of keysByNs.keys()) {
    const primaryNsTranslations = mergeNamespaces
      ? (primaryMergedForScan?.[ns] ?? primaryMergedForScan ?? {})
      : ((await loadTranslationFile(
          resolve(process.cwd(), getOutputPath(config.extract.output, primaryLanguage, ns))
        )) || {})

    if (keysAcceptingContext.size > 0) {
      const primaryKeys = getNestedKeys(primaryNsTranslations, keySeparator ?? '.')
      const variants: string[] = []
      for (const primaryKey of primaryKeys) {
        if (isContextVariantOfAcceptingKey(primaryKey, keysAcceptingContext, pluralSeparator, contextSeparator)) {
          variants.push(primaryKey)
        }
      }
      if (variants.length > 0) contextVariantsByNs.set(ns, variants)
    }

    const nestedRefKeys: ExtractedKey[] = []
    collectNestedRefsFromValue(primaryNsTranslations, ns, nestedRefKeys, new Set<string>())
    if (nestedRefKeys.length > 0) nestedReferenceKeysByNs.set(ns, nestedRefKeys)
  }

  // The primary language is checked first so that keys used in code but absent
  // from the primary translation file (e.g. a typo, or `extract` never run) are
  // surfaced as well. For the primary, an empty value is a deliberate
  // placeholder and counts as present — only truly absent keys are flagged.
  const localesToCheck = [primaryLanguage, ...secondaryLanguages.filter((l: string) => l !== primaryLanguage)]

  for (const locale of localesToCheck) {
    const isPrimary = locale === primaryLanguage
    let totalTranslatedForLocale = 0
    let totalEmptyForLocale = 0
    let totalAbsentForLocale = 0
    let totalOptionalForLocale = 0
    let totalKeysForLocale = 0
    const namespaces = new Map<string, any>()

    const mergedTranslations = mergeNamespaces
      // When merging namespaces we need to load the combined translation file.
      ? await loadTranslationFile(getMergedPath(locale)) || {}
      : null

    // Load fallbackNS catalogs once per locale (looked up in order, like the
    // i18next runtime). The per-namespace loop below skips a namespace's own
    // entry.
    const fallbackCatalogs = new Map<string, any>()
    for (const fallbackNs of fallbackNamespaces) {
      if (mergeNamespaces) {
        // In merged mode the fallback keys normally live in the merged file
        // under the fallback namespace.
        let catalog = mergedTranslations?.[fallbackNs]
        if (catalog === undefined) {
          // The fallback namespace may live in its own file outside the merged
          // one (split out and hidden via `ignoreNamespaces`, #287). Only
          // reachable when `output` resolves it to a separate path.
          const nsPath = resolve(process.cwd(), getOutputPath(config.extract.output, locale, fallbackNs))
          if (nsPath !== getMergedPath(locale)) {
            catalog = (await loadTranslationFile(nsPath)) ?? undefined
          }
        }
        if (catalog === undefined && isPrimary && ignoreNamespaces.has(fallbackNs)) {
          console.warn(`⚠️  fallbackNS "${fallbackNs}" is listed in ignoreNamespaces, but no translations for it were found — keys resolving through it will be reported as absent. If the namespace lives in its own file, use an \`output\` function that maps it to that path.`)
        }
        // If it's still not found, fall back to the top level of the merged
        // file (flat, non-namespaced merged files).
        fallbackCatalogs.set(fallbackNs, catalog ?? mergedTranslations ?? {})
      } else {
        const nsPath = resolve(process.cwd(), getOutputPath(config.extract.output, locale, fallbackNs))
        const catalog = await loadTranslationFile(nsPath)
        if (!catalog && isPrimary && ignoreNamespaces.has(fallbackNs)) {
          console.warn(`⚠️  fallbackNS "${fallbackNs}" is listed in ignoreNamespaces, but no translations for it were found at "${nsPath}" — keys resolving through it will be reported as absent.`)
        }
        fallbackCatalogs.set(fallbackNs, catalog || {})
      }
    }

    for (const [ns, keysInNs] of keysByNs.entries()) {
      const translationsForNs = mergeNamespaces
        // If mergedTranslations is a flat object (no nested namespace) prefer the root object
        // when mergedTranslations[ns] is missing.
        ? (mergedTranslations?.[ns] ?? mergedTranslations ?? {})
        : await loadTranslationFile(resolve(process.cwd(), getOutputPath(config.extract.output, locale, ns))) || {}

      const fallbackTranslationsList: any[] = []
      for (const fallbackNs of fallbackNamespaces) {
        if (ns === fallbackNs) continue
        fallbackTranslationsList.push(fallbackCatalogs.get(fallbackNs))
      }

      let translatedInNs = 0
      let emptyInNs = 0
      let absentInNs = 0
      let optionalInNs = 0
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
        let state = primaryState
        if (primaryState === 'absent') {
          for (const fallbackTranslations of fallbackTranslationsList) {
            const fallbackState = classifyValue(getNestedValue(fallbackTranslations, key, sep))
            if (fallbackState !== 'absent') {
              state = fallbackState
              break
            }
          }
        }

        // For the primary language the file itself is the source of values, so an
        // empty placeholder still means the key is present. Only a truly absent
        // key (used in code, missing from the file) is a problem here.
        if (isPrimary && state === 'empty') return 'translated'

        return state
      }

      const processedKeys = new Set<string>()

      // Combine AST-extracted keys with nested-reference keys discovered in
      // the primary translation file (see follow-up on issue #241). Both go
      // through the same plural-expansion logic; processedKeys dedupes.
      const nestedRefKeys = nestedReferenceKeysByNs.get(ns) || []
      const combinedKeysInNs = nestedRefKeys.length > 0
        ? [...keysInNs, ...nestedRefKeys]
        : keysInNs

      for (const { key: baseKey, hasCount, isOrdinal, isExpandedPlural } of combinedKeysInNs) {
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
            if (localePluralCategories.includes(category) && !processedKeys.has(baseKey)) {
              processedKeys.add(baseKey)
              const state = resolveAndClassify(baseKey)
              const optionalCategories = getOptionalPluralCategories(locale, isOrdinalVariant)
              // An optional category (e.g. French `_many`) is a soft note whenever
              // it isn't translated — whether absent or an empty placeholder that
              // `extract` wrote. It is never a hard failure. See #270 and
              // getOptionalPluralCategories.
              if (state !== 'translated' && optionalCategories.has(category)) {
                optionalInNs++
                keyDetails.push({ key: baseKey, state: 'optional' })
              } else {
                totalInNs++
                if (state === 'translated') translatedInNs++
                else if (state === 'empty') emptyInNs++
                else absentInNs++
                keyDetails.push({ key: baseKey, state })
              }
            }
          } else {
            // This is a base plural key without expanded variants. Mirror the
            // i18next runtime, where t(key, { count }) resolves `key + suffix`
            // and falls back to the bare `key`. A family is therefore satisfied
            // either by its plural variants OR by a bare key (the convention
            // used when `disablePlurals` is enabled and no variants are written).
            const localePluralCategories = getLocalePluralCategories(locale, isOrdinal || false)
            const optionalCategories = getOptionalPluralCategories(locale, isOrdinal || false)

            const variants = localePluralCategories.map(category => ({
              category,
              pluralKey: isOrdinal
                ? `${baseKey}${pluralSeparator}ordinal${pluralSeparator}${category}`
                : `${baseKey}${pluralSeparator}${category}`,
            }))

            const anyVariantPresent = variants.some(({ pluralKey }) => resolveAndClassify(pluralKey) !== 'absent')
            const bareState = resolveAndClassify(baseKey)

            if (!anyVariantPresent && bareState !== 'absent' && !processedKeys.has(baseKey)) {
              // Convention (a): only the bare key exists (typical under
              // disablePlurals, or single-"other" languages). The runtime
              // resolves count via the bare key, so it satisfies the family on
              // its own — don't demand plural variants that were never written.
              processedKeys.add(baseKey)
              totalInNs++
              if (bareState === 'translated') translatedInNs++
              else if (bareState === 'empty') emptyInNs++
              else absentInNs++
              keyDetails.push({ key: baseKey, state: bareState })
            } else {
              // Convention (b): plural variants exist (or the family is missing
              // entirely). Evaluate each CLDR category — a missing variant is a
              // hard absence only when the category is required for this locale;
              // optional categories (e.g. French `_many`) downgrade to a soft note.
              for (const { category, pluralKey } of variants) {
                if (processedKeys.has(pluralKey)) continue
                processedKeys.add(pluralKey)
                const state = resolveAndClassify(pluralKey)
                // An optional category (e.g. French `_many`) is a soft note
                // whenever it isn't translated — never a hard failure. See #270.
                if (state !== 'translated' && optionalCategories.has(category)) {
                  optionalInNs++
                  keyDetails.push({ key: pluralKey, state: 'optional' })
                  continue
                }
                totalInNs++
                if (state === 'translated') translatedInNs++
                else if (state === 'empty') emptyInNs++
                else absentInNs++
                keyDetails.push({ key: pluralKey, state })
              }
            }
          }
        } else {
          if (!processedKeys.has(baseKey)) {
            processedKeys.add(baseKey)
            totalInNs++
            const state = resolveAndClassify(baseKey)
            if (state === 'translated') translatedInNs++
            else if (state === 'empty') emptyInNs++
            else absentInNs++
            keyDetails.push({ key: baseKey, state })
          }
        }
      }

      // Additionally check context variants discovered in the primary file
      // (see issue #243). Skip variants already counted via extracted keys.
      const contextVariants = contextVariantsByNs.get(ns) || []
      for (const variantKey of contextVariants) {
        if (processedKeys.has(variantKey)) continue
        processedKeys.add(variantKey)
        totalInNs++
        const state = resolveAndClassify(variantKey)
        if (state === 'translated') translatedInNs++
        else if (state === 'empty') emptyInNs++
        else absentInNs++
        keyDetails.push({ key: variantKey, state })
      }

      namespaces.set(ns, { totalKeys: totalInNs, translatedKeys: translatedInNs, emptyKeys: emptyInNs, absentKeys: absentInNs, optionalKeys: optionalInNs, keyDetails })
      totalTranslatedForLocale += translatedInNs
      totalEmptyForLocale += emptyInNs
      totalAbsentForLocale += absentInNs
      totalOptionalForLocale += optionalInNs
      totalKeysForLocale += totalInNs
    }
    const localeStatus: LocaleStatus = {
      totalKeys: totalKeysForLocale,
      totalTranslated: totalTranslatedForLocale,
      totalEmpty: totalEmptyForLocale,
      totalAbsent: totalAbsentForLocale,
      totalOptional: totalOptionalForLocale,
      namespaces,
    }
    if (isPrimary) {
      report.primary = localeStatus
    } else {
      report.locales.set(locale, localeStatus)
    }
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
  if (!config.locales.includes(locale)) {
    console.error(styleText('red', `Error: Locale "${locale}" is not defined in your configuration.`))
    return
  }

  const isPrimary = locale === config.extract.primaryLanguage
  const localeData = isPrimary ? report.primary : report.locales.get(locale)

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
      } else if (state === 'optional') {
        console.log(`  ${styleText('gray', '○')} ${key}  ${styleText('gray', '(optional plural form)')}`)
      } else {
        console.log(`  ${styleText('red', '✗')} ${key}  ${styleText('red', '(absent)')}`)
      }
    })
  }

  const missingCount = totalKeysForLocale - localeData.totalTranslated
  if (missingCount > 0) {
    if (isPrimary) {
      console.log(styleText(['red', 'bold'], `\nSummary: Found ${missingCount} key(s) used in code but absent from the "${locale}" translation files. Run "i18next-cli extract" to add them.`))
    } else {
      const summaryBreakdown = buildBreakdown(localeData.totalEmpty, localeData.totalAbsent)
      console.log(styleText(['yellow', 'bold'], `\nSummary: Found ${missingCount} incomplete translations for "${locale}" — ${summaryBreakdown}.`))
    }
  } else if (isPrimary) {
    console.log(styleText(['green', 'bold'], `\nSummary: 🎉 All keys used in code are present in the "${locale}" translation files.`))
  } else {
    console.log(styleText(['green', 'bold'], `\nSummary: 🎉 All keys are translated for "${locale}".`))
  }

  // Untranslated keys in a secondary locale are the gap Locize fills; absent
  // keys in the primary language are an `extract` problem (handled above).
  const nsData = namespaceFilter ? localeData.namespaces.get(namespaceFilter) : undefined
  const untranslated = nsData ? nsData.totalKeys - nsData.translatedKeys : missingCount
  await printUntranslatedFunnel('status', isPrimary ? [] : [{ locale, untranslated }], LOCIZE_SIGNUP_URL)
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

  const primaryNsData = report.primary?.namespaces.get(namespace)
  if (primaryNsData && primaryNsData.absentKeys > 0) {
    const { primaryLanguage } = config.extract
    console.log(styleText(['red', 'bold'], `\n⚠ Primary language "${primaryLanguage}" is missing ${primaryNsData.absentKeys} key(s) that are used in code.`))
  }

  const gaps = Array.from(report.locales, ([locale, localeData]) => {
    const nsLocaleData = localeData.namespaces.get(namespace)
    return { locale, untranslated: nsLocaleData ? nsLocaleData.totalKeys - nsLocaleData.translatedKeys : 0 }
  })
  await printUntranslatedFunnel('status', gaps, LOCIZE_SIGNUP_URL)
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

  if (report.primary && report.primary.totalAbsent > 0) {
    console.log(styleText(['red', 'bold'], `\n⚠ Primary language "${primaryLanguage}" is missing ${report.primary.totalAbsent} key(s) that are used in code.`))
    console.log(styleText('red', `  Run "i18next-cli status ${primaryLanguage}" for details, or "i18next-cli extract" to add them.`))
  }

  const gaps = Array.from(report.locales, ([locale, localeData]) => ({ locale, untranslated: localeData.totalKeys - localeData.totalTranslated }))
  await printUntranslatedFunnel('status', gaps, LOCIZE_SIGNUP_URL)
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

/**
 * Options for the unused-keys report.
 */
interface UnusedOptions {
  /** Restrict the report to a single locale */
  locale?: string;
  /** Restrict the report to a single namespace */
  namespace?: string;
}

/**
 * Reports translation keys that exist in the translation files but are no
 * longer used in the source code (see issue #281).
 *
 * "Unused" is defined as "what `extract` with `removeUnusedKeys` would delete":
 * the report runs the extractor in dry-run mode and diffs the existing key set
 * against the pruned result. This inherits all of extract's edge-case handling
 * (plural variants, context variants, `preservePatterns`, `ignoreNamespaces`)
 * instead of re-implementing usedness detection that could drift from it.
 *
 * The command never writes any files and exits with a non-zero status code
 * when unused keys are found, so it can serve as a dedicated CI check
 * alongside `status <locale>` (missing translations).
 */
export async function runUnusedReport (config: I18nextToolkitConfig, options: UnusedOptions = {}) {
  if (options.locale && !config.locales.includes(options.locale)) {
    console.error(styleText('red', `Error: Locale "${options.locale}" is not defined in your configuration.`))
    process.exit(1)
    return
  }

  // Work on a copy with `removeUnusedKeys` forced on: the dry-run diff below
  // derives "unused" from what extract would prune, which requires pruning to
  // be active regardless of the user's config. The caller's config object
  // stays untouched.
  const cfg: I18nextToolkitConfig = { ...config, extract: { ...config.extract, removeUnusedKeys: true } }

  const spinner = ora('Analyzing project for unused translation keys...\n').start()
  let extraction: { results: TranslationResult[]; hasErrors: boolean }
  try {
    extraction = await runExtractor(cfg, { isDryRun: true, quiet: true })
    spinner.succeed('Analysis complete.')
  } catch (error) {
    spinner.fail('Failed to analyze unused translation keys.')
    console.error(error)
    process.exit(1)
    return
  }
  const { results, hasErrors } = extraction

  const rawSep = cfg.extract.keySeparator
  const keySeparator: string | false = rawSep === false ? false : (rawSep ?? '.')

  let totalUnused = 0
  for (const result of results) {
    if (options.locale && result.locale !== options.locale) continue
    if (options.namespace && result.namespace && result.namespace !== options.namespace) continue

    const keptKeys = new Set(getNestedKeys(result.newTranslations || {}, keySeparator))
    const unusedKeys = getNestedKeys(result.existingTranslations || {}, keySeparator)
      .filter(key => !keptKeys.has(key))
      .sort()
    if (unusedKeys.length === 0) continue

    totalUnused += unusedKeys.length
    const label = result.namespace ? `${result.locale}/${result.namespace}` : result.locale
    console.log(styleText(['cyan', 'bold'], `\n[${label}] ${result.path}`))
    for (const key of unusedKeys) {
      console.log(`  ${styleText('red', '✗')} ${key}`)
    }
  }

  if (hasErrors) {
    console.log(styleText(['yellow', 'bold'], '\n⚠ Some source files could not be parsed — keys used only in those files may be falsely reported as unused.'))
  }

  if (totalUnused > 0) {
    console.log(styleText(['yellow', 'bold'], `\nSummary: Found ${totalUnused} unused key(s)${options.locale ? ` for "${options.locale}"` : ''}. No files were modified.`))
    console.log(`Run ${styleText('cyan', 'npx i18next-cli extract')} to remove them.`)
  } else {
    console.log(styleText(['green', 'bold'], '\nSummary: 🎉 No unused keys found.'))
  }

  // Static analysis has an inherent blind spot for dynamically constructed
  // keys, so this link doubles as an accuracy disclaimer. Gated like the other
  // funnel messages (never in CI/non-TTY, 24h cooldown).
  if (await shouldShowFunnel('status-unused')) {
    console.log(styleText('gray', "\nℹ Static analysis cannot detect dynamically constructed keys (e.g. t('error.' + code))."))
    console.log(styleText('gray', '  To find keys that are truly unused at runtime, see https://www.locize.com/docs/guides/find-unused-translations'))
    await recordFunnelShown('status-unused')
  }

  if (totalUnused > 0 || hasErrors) {
    process.exit(1)
  }
}
