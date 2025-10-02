import { TranslationResult, ExtractedKey, I18nextToolkitConfig } from '../../types'
import { resolve, basename, extname } from 'node:path'
import { glob } from 'glob'
import { getNestedValue, setNestedValue, getNestedKeys } from '../../utils/nested-object'
import { getOutputPath, loadTranslationFile } from '../../utils/file-utils'

/**
 * Converts a glob pattern to a regular expression for matching keys
 * @param glob - The glob pattern to convert
 * @returns A RegExp object that matches the glob pattern
 */
function globToRegex (glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexString = `^${escaped.replace(/\*/g, '.*')}$`
  return new RegExp(regexString)
}

/**
 * Recursively sorts the keys of an object.
 */
function sortObject (obj: any): any {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj
  }

  const sortedObj: Record<string, any> = {}
  const keys = Object.keys(obj).sort((a, b) => {
    // First, compare case-insensitively
    const caseInsensitiveComparison = a.localeCompare(b, undefined, { sensitivity: 'base' })

    // If they're equal case-insensitively, sort by case (lowercase first)
    if (caseInsensitiveComparison === 0) {
      return a.localeCompare(b, undefined, { sensitivity: 'case' })
    }

    return caseInsensitiveComparison
  })

  for (const key of keys) {
    sortedObj[key] = sortObject(obj[key])
  }

  return sortedObj
}

/**
 * A helper function to build a new translation object for a single namespace.
 * This centralizes the core logic of merging keys.
 */
function buildNewTranslationsForNs (
  nsKeys: ExtractedKey[],
  existingTranslations: Record<string, any>,
  config: I18nextToolkitConfig,
  locale: string,
  preservePatterns: RegExp[],
  objectKeys: Set<string>
): Record<string, any> {
  const {
    keySeparator = '.',
    sort = true,
    removeUnusedKeys = true,
    primaryLanguage,
    defaultValue: emptyDefaultValue = '',
  } = config.extract

  // If `removeUnusedKeys` is true, start with an empty object. Otherwise, start with a clone of the existing translations.
  let newTranslations: Record<string, any> = removeUnusedKeys
    ? {}
    : JSON.parse(JSON.stringify(existingTranslations))

  // Preserve keys that match the configured patterns
  const existingKeys = getNestedKeys(existingTranslations, keySeparator ?? '.')
  for (const existingKey of existingKeys) {
    if (preservePatterns.some(re => re.test(existingKey))) {
      const value = getNestedValue(existingTranslations, existingKey, keySeparator ?? '.')
      setNestedValue(newTranslations, existingKey, value, keySeparator ?? '.')
    }
  }

  // 1. Build the object first, without any sorting.
  for (const { key, defaultValue } of nsKeys) {
    const existingValue = getNestedValue(existingTranslations, key, keySeparator ?? '.')
    const isLeafInNewKeys = !nsKeys.some(otherKey => otherKey.key.startsWith(`${key}${keySeparator}`) && otherKey.key !== key)
    const isStaleObject = typeof existingValue === 'object' && existingValue !== null && isLeafInNewKeys && !objectKeys.has(key)

    const valueToSet = (existingValue === undefined || isStaleObject)
      ? (locale === primaryLanguage ? defaultValue : emptyDefaultValue)
      : existingValue

    setNestedValue(newTranslations, key, valueToSet, keySeparator ?? '.')
  }

  // 2. If sorting is enabled, recursively sort the entire object.
  // This correctly handles both top-level and nested keys.
  if (sort === true) {
    return sortObject(newTranslations)
  }
  // Custom sort function logic remains as a future enhancement if needed,
  // but for now, this robustly handles the most common `sort: true` case.
  if (typeof sort === 'function') {
    const sortedObject: Record<string, any> = {}
    const topLevelKeys = Object.keys(newTranslations)

    // Create a map of top-level keys to a representative ExtractedKey object.
    // This is needed for the custom sort function.
    const keyMap = new Map<string, ExtractedKey>()
    for (const ek of nsKeys) {
      const topLevelKey = keySeparator === false ? ek.key : ek.key.split(keySeparator as string)[0]
      if (!keyMap.has(topLevelKey)) {
        keyMap.set(topLevelKey, ek)
      }
    }

    topLevelKeys.sort((a, b) => {
      if (typeof sort === 'function') {
        const keyA = keyMap.get(a)
        const keyB = keyMap.get(b)
        // If we can find both original keys, use the custom comparator.
        if (keyA && keyB) {
          return sort(keyA, keyB)
        }
      }
      // Fallback to a case-insensitive alphabetical sort.
      return a.localeCompare(b, undefined, { sensitivity: 'base' })
    })

    // 3. Rebuild the object in the final sorted order.
    for (const key of topLevelKeys) {
      sortedObject[key] = newTranslations[key]
    }
    newTranslations = sortedObject
  }

  return newTranslations
}

/**
 * Processes extracted translation keys and generates translation files for all configured locales.
 *
 * This function:
 * 1. Groups keys by namespace
 * 2. For each locale and namespace combination:
 * - Reads existing translation files
 * - Preserves keys matching `preservePatterns` and those from `objectKeys`
 * - Merges in newly extracted keys
 * - Uses primary language defaults or empty strings for secondary languages
 * - Maintains key sorting based on configuration
 * 3. Determines if files need updating by comparing content
 *
 * @param keys - Map of extracted translation keys with metadata.
 * @param objectKeys - A set of base keys that were called with the `returnObjects: true` option.
 * @param config - The i18next toolkit configuration object.
 * @returns Promise resolving to array of translation results with update status.
 *
 * @example
 * ```typescript
 * const keys = new Map([
 * ['translation:welcome', { key: 'welcome', defaultValue: 'Welcome!', ns: 'translation' }],
 * ]);
 * const objectKeys = new Set(['countries']);
 *
 * const results = await getTranslations(keys, objectKeys, config);
 * // Results contain update status and new/existing translations for each locale.
 * ```
 */
export async function getTranslations (
  keys: Map<string, ExtractedKey>,
  objectKeys: Set<string>,
  config: I18nextToolkitConfig
): Promise<TranslationResult[]> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  const defaultNS = config.extract.defaultNS ?? 'translation'
  const patternsToPreserve = [...(config.extract.preservePatterns || [])]
  const indentation = config.extract.indentation ?? 2

  for (const key of objectKeys) {
    // Convert the object key to a glob pattern to preserve all its children
    patternsToPreserve.push(`${key}.*`)
  }
  const preservePatterns = patternsToPreserve.map(globToRegex)

  // Group keys by namespace
  const keysByNS = new Map<string, ExtractedKey[]>()
  for (const key of keys.values()) {
    const ns = key.ns || defaultNS
    if (!keysByNS.has(ns)) keysByNS.set(ns, [])
    keysByNS.get(ns)!.push(key)
  }

  const results: TranslationResult[] = []
  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  // Process each locale one by one
  for (const locale of config.locales) {
    const shouldMerge = config.extract.mergeNamespaces || !config.extract.output.includes('{{namespace}}')

    // LOGIC PATH 1: Merged Namespaces
    if (shouldMerge) {
      const newMergedTranslations: Record<string, any> = {}
      const outputPath = getOutputPath(config.extract.output, locale)
      const fullPath = resolve(process.cwd(), outputPath)
      const existingMergedFile = await loadTranslationFile(fullPath) || {}

      // The namespaces to process are from new keys AND the keys of the existing merged file
      const namespacesToProcess = new Set([...keysByNS.keys(), ...Object.keys(existingMergedFile)])

      for (const ns of namespacesToProcess) {
        const nsKeys = keysByNS.get(ns) || []
        const existingTranslations = existingMergedFile[ns] || {}
        newMergedTranslations[ns] = buildNewTranslationsForNs(nsKeys, existingTranslations, config, locale, preservePatterns, objectKeys)
      }

      const oldContent = JSON.stringify(existingMergedFile, null, indentation)
      const newContent = JSON.stringify(newMergedTranslations, null, indentation)
      // Push a single result for the merged file
      results.push({ path: fullPath, updated: newContent !== oldContent, newTranslations: newMergedTranslations, existingTranslations: existingMergedFile })

    // LOGIC PATH 2: Separate Namespace Files
    } else {
      // Find all namespaces that exist on disk for this locale
      const namespacesToProcess = new Set(keysByNS.keys())
      const existingNsPattern = getOutputPath(config.extract.output, locale, '*')
      const existingNsFiles = await glob(existingNsPattern, { ignore: userIgnore })
      for (const file of existingNsFiles) {
        namespacesToProcess.add(basename(file, extname(file)))
      }

      // Process each namespace individually and create a result for each one
      for (const ns of namespacesToProcess) {
        const nsKeys = keysByNS.get(ns) || []
        const outputPath = getOutputPath(config.extract.output, locale, ns)
        const fullPath = resolve(process.cwd(), outputPath)
        const existingTranslations = await loadTranslationFile(fullPath) || {}
        const newTranslations = buildNewTranslationsForNs(nsKeys, existingTranslations, config, locale, preservePatterns, objectKeys)

        const oldContent = JSON.stringify(existingTranslations, null, indentation)
        const newContent = JSON.stringify(newTranslations, null, indentation)
        // Push one result per namespace file
        results.push({ path: fullPath, updated: newContent !== oldContent, newTranslations, existingTranslations })
      }
    }
  }

  return results
}
