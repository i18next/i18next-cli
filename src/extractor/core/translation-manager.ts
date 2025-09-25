import { TranslationResult, ExtractedKey, I18nextToolkitConfig } from '../../types'
import { resolve } from 'node:path'
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
 * Processes extracted translation keys and generates translation files for all configured locales.
 *
 * This function:
 * 1. Groups keys by namespace
 * 2. For each locale and namespace combination:
 *    - Reads existing translation files
 *    - Preserves keys matching `preservePatterns`
 *    - Merges in newly extracted keys
 *    - Uses primary language defaults or empty strings for secondary languages
 *    - Maintains key sorting based on configuration
 * 3. Determines if files need updating by comparing content
 *
 * @param keys - Map of extracted translation keys with metadata
 * @param config - The i18next toolkit configuration object
 * @returns Promise resolving to array of translation results with update status
 *
 * @example
 * ```typescript
 * const keys = new Map([
 *   ['translation:welcome', { key: 'welcome', defaultValue: 'Welcome!', ns: 'translation' }],
 *   ['common:button.save', { key: 'button.save', defaultValue: 'Save', ns: 'common' }]
 * ])
 *
 * const results = await getTranslations(keys, config)
 * // Results contain update status and new/existing translations for each locale
 * ```
 */
export async function getTranslations (
  keys: Map<string, ExtractedKey>,
  objectKeys: Set<string>,
  config: I18nextToolkitConfig
): Promise<TranslationResult[]> {
  const defaultNS = config.extract.defaultNS ?? 'translation'
  const keySeparator = config.extract.keySeparator ?? '.'
  const patternsToPreserve = [...(config.extract.preservePatterns || [])]
  const mergeNamespaces = config.extract.mergeNamespaces ?? false
  for (const key of objectKeys) {
    // Convert the object key to a glob pattern to preserve all its children
    patternsToPreserve.push(`${key}.*`)
  }
  const preservePatterns = patternsToPreserve.map(globToRegex)
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  const primaryLanguage = config.extract.primaryLanguage

  // Group keys by namespace
  const keysByNS = new Map<string, ExtractedKey[]>()
  for (const key of keys.values()) {
    const ns = key.ns || defaultNS
    if (!keysByNS.has(ns)) {
      keysByNS.set(ns, [])
    }
    keysByNS.get(ns)!.push(key)
  }

  const results: TranslationResult[] = []

  for (const locale of config.locales) {
    const mergedTranslations: Record<string, any> = {}
    const mergedExisting: Record<string, any> = {}

    for (const [ns, nsKeys] of keysByNS.entries()) {
      const outputPath = getOutputPath(config.extract.output, locale, mergeNamespaces ? undefined : ns)
      const fullPath = resolve(process.cwd(), outputPath)

      const existingTranslations = await loadTranslationFile(fullPath) || {}
      const newTranslations: Record<string, any> = {}

      const existingKeys = getNestedKeys(existingTranslations, keySeparator)
      for (const existingKey of existingKeys) {
        if (preservePatterns.some(re => re.test(existingKey))) {
          const value = getNestedValue(existingTranslations, existingKey, keySeparator)
          setNestedValue(newTranslations, existingKey, value, keySeparator)
        }
      }

      const sortedKeys = (config.extract.sort === false)
        ? nsKeys
        : [...nsKeys].sort((a, b) => a.key.localeCompare(b.key))

      for (const { key, defaultValue } of sortedKeys) {
        const existingValue = getNestedValue(existingTranslations, key, keySeparator)
        const valueToSet = existingValue ?? (locale === primaryLanguage ? defaultValue : (config.extract.defaultValue ?? ''))
        setNestedValue(newTranslations, key, valueToSet, keySeparator)
      }

      if (mergeNamespaces) {
        mergedTranslations[ns] = newTranslations
        if (Object.keys(existingTranslations).length > 0) {
          mergedExisting[ns] = existingTranslations
        }
      } else {
        const oldContent = existingTranslations ? JSON.stringify(existingTranslations, null, config.extract.indentation ?? 2) : ''
        const newContent = JSON.stringify(newTranslations, null, config.extract.indentation ?? 2)

        results.push({
          path: fullPath,
          updated: newContent !== oldContent,
          newTranslations,
          existingTranslations,
        })
      }
    }

    if (mergeNamespaces) {
      const outputPath = getOutputPath(config.extract.output, locale)
      const fullPath = resolve(process.cwd(), outputPath)
      const oldContent = Object.keys(mergedExisting).length > 0 ? JSON.stringify(mergedExisting, null, config.extract.indentation ?? 2) : ''
      const newContent = JSON.stringify(mergedTranslations, null, config.extract.indentation ?? 2)

      results.push({
        path: fullPath,
        updated: newContent !== oldContent,
        newTranslations: mergedTranslations,
        existingTranslations: mergedExisting,
      })
    }
  }

  return results
}
